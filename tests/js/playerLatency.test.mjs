// 再生ヘッドの出力レイテンシ補正（Issue #31）のテスト。
// Bluetooth 出力（outputLatency 150〜500ms）で波形ヘッドと聞こえている声がズレる問題:
// 表示クロック（聴感位置）とスケジューリングクロック（エンジン位置）を分離した。
//
//   1. 純関数: sanitizeOutputLatency / audiblePosition / enginePosition
//      （latency あり / なし / undefined / 非有限、クランプ、往復関係）
//   2. 実 player: pause が聴感位置を保存し、resume がそこから鳴り直すこと
//      （transport テストと同じ AudioContext / fetch スタブ流儀）

import test from "node:test";
import assert from "node:assert/strict";

// ── setInterval 追跡（transport テストと同じ: 残留 interval でプロセスが
//    生き続けないよう after で強制クリアする） ──

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const liveIntervals = new Set();
globalThis.setInterval = (...args) => {
  const id = realSetInterval(...args);
  liveIntervals.add(id);
  return id;
};
globalThis.clearInterval = (id) => {
  liveIntervals.delete(id);
  return realClearInterval(id);
};
test.after(() => {
  for (const id of liveIntervals) realClearInterval(id);
  liveIntervals.clear();
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});

// ── AudioContext / fetch スタブ（player.transport.test.mjs と同形・縮約） ──

class FakeGainParam {
  constructor() { this.value = 1; }
  cancelScheduledValues() {}
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
}
class FakeGainNode {
  constructor() { this.gain = new FakeGainParam(); }
  connect() {}
  disconnect() {}
}
class FakeBufferSource {
  constructor() { this.onended = null; this.buffer = null; }
  connect() {}
  disconnect() {}
  start() {}
  stop() {}
}
class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = "running";
    this.destination = {};
    this.outputLatency = 0; // テストが書き換える（Bluetooth 相当は 0.25 等）
  }
  createGain() { return new FakeGainNode(); }
  createBuffer(_c, length, sampleRate) { return { length, sampleRate, copyToChannel() {} }; }
  createBufferSource() { return new FakeBufferSource(); }
  async resume() { this.state = "running"; }
}
let lastCtx = null;
globalThis.AudioContext = class extends FakeAudioContext {
  constructor(...args) {
    super(...args);
    lastCtx = this; // eslint-disable-line no-this-before-super -- super 済み
  }
};

const SAMPLE_RATE = 48000;
function buildWav(durationSec) {
  const dataBytes = Math.round(durationSec * SAMPLE_RATE) * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (pos, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(pos + i, s.charCodeAt(i)); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, dataBytes, true);
  return buf;
}
const WAV_FILE = buildWav(2.0);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes("/audio/")) {
    const range = options.headers?.Range || "bytes=0-";
    const m = /bytes=(\d+)-(\d+)?/.exec(range);
    const start = Number(m[1]);
    const end = m[2] !== undefined ? Number(m[2]) : WAV_FILE.byteLength - 1;
    const body = WAV_FILE.slice(start, Math.min(end + 1, WAV_FILE.byteLength));
    return {
      ok: true, status: 206, statusText: "Partial Content",
      async arrayBuffer() { return body; },
      async text() { return ""; },
      async json() { return {}; },
    };
  }
  throw new Error(`fetch mock: 未登録のリクエスト ${url}`);
};
test.after(() => { globalThis.fetch = realFetch; });

import { state } from "../../src/podcast_prep/static/js/state.js";
import * as player from "../../src/podcast_prep/static/js/player.js";
import { makeBlock } from "./helpers.mjs";

// ── 純関数 ───────────────────────────────────────────────

test("sanitizeOutputLatency: 未実装/非有限/負は 0、正の有限値はそのまま", () => {
  assert.equal(player.sanitizeOutputLatency(0.25), 0.25);
  assert.equal(player.sanitizeOutputLatency(0), 0);
  assert.equal(player.sanitizeOutputLatency(-0.1), 0);
  assert.equal(player.sanitizeOutputLatency(undefined), 0);
  assert.equal(player.sanitizeOutputLatency(NaN), 0);
  assert.equal(player.sanitizeOutputLatency(Infinity), 0);
  assert.equal(player.sanitizeOutputLatency("0.2"), 0);
});

test("audiblePosition: outputLatency 分だけエンジン位置より遅れる", () => {
  const base = { posAtStart: 10, ctxT0: 100, end: 60 };
  // レイテンシなし: エンジン位置と一致
  assert.equal(
    player.audiblePosition({ ...base, ctxTime: 105, outputLatency: 0 }),
    player.enginePosition({ posAtStart: 10, ctxTime: 105, ctxT0: 100 }),
  );
  // Bluetooth 相当 250ms: その分だけ手前を指す
  assert.equal(player.audiblePosition({ ...base, ctxTime: 105, outputLatency: 0.25 }), 14.75);
  // undefined（未実装ブラウザ）: 0 フォールバック
  assert.equal(player.audiblePosition({ ...base, ctxTime: 105, outputLatency: undefined }), 15);
});

test("audiblePosition: 再生直後はまだ音が出ていない → posAtStart に留まる（負に進まない）", () => {
  // ctxTime - latency - ctxT0 < 0 の間（開始ヘッドルーム + レイテンシ待ち）は起点のまま
  const pos = player.audiblePosition({
    posAtStart: 5, ctxTime: 100.1, ctxT0: 100, outputLatency: 0.3, end: 60,
  });
  assert.equal(pos, 5);
});

test("audiblePosition: クランプ（0 以上・end 以下）", () => {
  assert.equal(
    player.audiblePosition({ posAtStart: 0, ctxTime: 1000, ctxT0: 0, outputLatency: 0, end: 60 }),
    60,
  );
  assert.equal(
    player.audiblePosition({ posAtStart: 0, ctxTime: 0, ctxT0: 10, outputLatency: 0.5, end: 60 }),
    0,
  );
  // end が非数なら上限クランプなし（呼び出し側が常に渡す契約だが防御）
  assert.equal(
    player.audiblePosition({ posAtStart: 1, ctxTime: 2, ctxT0: 0, outputLatency: 0, end: NaN }),
    3,
  );
});

test("engine/audible の往復関係: 進行中は engine - audible == latency", () => {
  const args = { posAtStart: 10, ctxTime: 107, ctxT0: 100 };
  const latency = 0.4;
  const engine = player.enginePosition(args);
  const audible = player.audiblePosition({ ...args, outputLatency: latency, end: 1000 });
  assert.ok(Math.abs(engine - audible - latency) < 1e-9);
});

// ── 実 player: pause → resume の整合 ─────────────────────

function readyProject() {
  return {
    id: "p-latency",
    name: "latency",
    status: "ready",
    settings: { min_overlap_s: 0.3, crossfade_ms: 10 },
    tracks: {
      A: { speaker: "A", label: "A", gain_db: 0, deesser: 0, offset_seconds: 0 },
      B: { speaker: "B", label: "B", gain_db: 0, deesser: 0, offset_seconds: 0 },
    },
    blocks: [makeBlock("a1", "A", 0, 2, 0)], // timelineEnd = 2
    transcripts: [],
    overlaps: [],
  };
}

test("pause は聴感位置を保存し、getCurrentTime（再生中）もレイテンシ補正される", async () => {
  state.project = readyProject();
  state.editVersion = 0;
  state.projectEpoch += 1;
  assert.equal(await player.preparePlayback(state.projectEpoch), true);

  await player.play();
  assert.ok(lastCtx, "FakeAudioContext が生成されていること");
  lastCtx.outputLatency = 0.25; // Bluetooth 相当（再生中の動的変化も都度読みで拾う）
  // play() は ctxT0 = currentTime + 0.05（ヘッドルーム）。1.0 秒進める:
  lastCtx.currentTime = 1.0;
  // エンジン位置 = 0 + (1.0 - 0.05) = 0.95 / 聴感位置 = 0.95 - 0.25 = 0.70
  assert.ok(Math.abs(player.getCurrentTime() - 0.7) < 1e-9, String(player.getCurrentTime()));

  player.pause();
  assert.ok(Math.abs(player.getCurrentTime() - 0.7) < 1e-9, "pause 位置 = 聞こえていた場所");

  // resume: 聴感位置から鳴り直す（posAtStart = pausedAt。逆変換は不要）
  await player.play();
  assert.ok(Math.abs(player.getCurrentTime() - 0.7) < 1e-9, "resume 直後は同じ場所を指す");
  player.pause();
});

test("レイテンシ未実装（undefined）では従来挙動と一致", async () => {
  state.project = readyProject();
  state.editVersion = 0;
  state.projectEpoch += 1;
  assert.equal(await player.preparePlayback(state.projectEpoch), true);
  const base = lastCtx.currentTime; // ctx は前テストから再利用される（実装どおり）
  await player.play(); // ctxT0 = base + 0.05
  lastCtx.outputLatency = undefined;
  lastCtx.currentTime = base + 0.55; // エンジン位置 = 0.55 - 0.05 = 0.5
  assert.ok(Math.abs(player.getCurrentTime() - 0.5) < 1e-9);
  player.pause();
  assert.ok(Math.abs(player.getCurrentTime() - 0.5) < 1e-9);
});
