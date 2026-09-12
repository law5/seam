// player.js トランスポートの回帰テスト（QA指摘対応）: 終端からの ▶ で
// UI が「再生中」のまま固まり setInterval がリークする欠陥の再発防止。
// 実物 player/state/pcm/api/timelineModel を使い、AudioContext / fetch / setInterval のみスタブする。
// 期待挙動:
//   - 終端（pausedAt >= timelineEnd - EPS）からの play() は先頭から再生する
//   - schedulePass が同期的に finishAtEnd → pause() した場合（空タイムライン等）、
//     play() は interval を張らず {playing:true} も emit しない（最終イベントは {playing:false}）
// Issue #20: 選択追従シーク（seekToSelectionStart）の再生中ガードもここで固定する
// （play() を実際に走らせられる唯一のハーネスのため）。

import test from "node:test";
import assert from "node:assert/strict";

// ── setInterval 計測（player import 前に不要。呼び出し時解決のため実行時ラップで足りる） ──

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
let intervalsCreated = 0;
let intervalsCleared = 0;
const liveIntervals = new Set();
globalThis.setInterval = (...args) => {
  intervalsCreated += 1;
  const id = realSetInterval(...args);
  liveIntervals.add(id);
  return id;
};
globalThis.clearInterval = (id) => {
  intervalsCleared += 1;
  liveIntervals.delete(id);
  return realClearInterval(id);
};

// ── AudioContext スタブ ──────────────────────────────────

class FakeGainParam {
  constructor() {
    this.value = 1;
  }
  cancelScheduledValues() {}
  setValueAtTime(v) {
    this.value = v;
  }
  linearRampToValueAtTime(v) {
    this.value = v;
  }
}

class FakeGainNode {
  constructor() {
    this.gain = new FakeGainParam();
  }
  connect() {}
  disconnect() {}
}

class FakeBufferSource {
  constructor() {
    this.onended = null;
    this.buffer = null;
  }
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
  }
  createGain() {
    return new FakeGainNode();
  }
  createBuffer(_channels, length, sampleRate) {
    return {
      length,
      sampleRate,
      copyToChannel() {},
    };
  }
  createBufferSource() {
    return new FakeBufferSource();
  }
  async resume() {
    this.state = "running";
  }
}

globalThis.AudioContext = FakeAudioContext;

// ── fetch スタブ（mono 16bit PCM WAV の Range 応答） ──────

const SAMPLE_RATE = 48000;

function buildWav(durationSec) {
  const dataBytes = Math.round(durationSec * SAMPLE_RATE) * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (pos, s) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(pos + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byteRate
  view.setUint16(32, 2, true); // blockAlign
  view.setUint16(34, 16, true); // bits
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return buf;
}

const WAV_FILE = buildWav(1.0); // A/B とも 1 秒素材

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes("/audio/")) {
    const range = options.headers?.Range || "bytes=0-";
    const m = /bytes=(\d+)-(\d+)?/.exec(range);
    const start = Number(m[1]);
    const end = m[2] !== undefined ? Number(m[2]) : WAV_FILE.byteLength - 1;
    const body = WAV_FILE.slice(start, Math.min(end + 1, WAV_FILE.byteLength));
    return {
      ok: true,
      status: 206,
      statusText: "Partial Content",
      async arrayBuffer() {
        return body;
      },
      async text() {
        return "";
      },
      async json() {
        return {};
      },
    };
  }
  throw new Error(`fetch mock: 未登録のリクエスト ${url}`);
};

test.after(() => {
  globalThis.fetch = realFetch;
  for (const id of liveIntervals) realClearInterval(id);
  liveIntervals.clear();
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});

// ── フィクスチャ ─────────────────────────────────────────

import { state, on } from "../../src/podcast_prep/static/js/state.js";
import * as player from "../../src/podcast_prep/static/js/player.js";
import { makeBlock } from "./helpers.mjs";

function readyProject() {
  return {
    id: "p1",
    name: "test",
    status: "ready",
    settings: { min_overlap_s: 0.3, crossfade_ms: 10 },
    tracks: {
      A: { speaker: "A", label: "A", gain_db: 0, deesser: 0, offset_seconds: 0 },
      B: { speaker: "B", label: "B", gain_db: 0, deesser: 0, offset_seconds: 0 },
    },
    blocks: [makeBlock("a1", "A", 0, 1, 0)], // timelineEnd = 1
    transcripts: [],
    overlaps: [],
  };
}

function collectPlayerState() {
  const events = [];
  const off = on("player-state", (detail) => events.push(detail));
  return { events, off };
}

// ── テスト（同一プロセスで順に実行される） ────────────────

test("終端からの ▶ は先頭から再生し {playing:true} で確定する（固着・interval リークなし）", async () => {
  state.project = readyProject();
  state.editVersion = 0;
  state.projectEpoch += 1;
  assert.equal(await player.preparePlayback(state.projectEpoch), true);

  player.seek(1); // 自然終端後と同じ状態（finishAtEnd は pausedAt = timelineEnd を残す）
  const createdBefore = intervalsCreated;
  const { events, off } = collectPlayerState();

  await player.play();

  assert.equal(player.isPlaying(), true, "終端からの再生は開始されること");
  assert.deepEqual(events, [{ playing: true }], "{playing:false} が混ざらず最終状態が再生中であること");
  assert.equal(player.getCurrentTime(), 0, "先頭からの再生（pausedAt リセット）であること");
  assert.equal(intervalsCreated - createdBefore, 1);

  player.pause();
  off();
  assert.equal(player.isPlaying(), false);
  assert.equal(intervalsCreated, intervalsCleared, "interval がリークしないこと");
  assert.equal(liveIntervals.size, 0);
});

test("空タイムラインで ▶: interval を張らず最終イベントは {playing:false}（見かけ上の再生中固着なし）", async () => {
  // 全ブロック削除相当（§14: blocks 空 → 再生は即終端）
  state.project.blocks = [];
  state.editVersion += 1;
  player.seek(0);

  const createdBefore = intervalsCreated;
  const { events, off } = collectPlayerState();

  await player.play();
  off();

  assert.equal(player.isPlaying(), false);
  assert.ok(events.length > 0, "player-state が emit されること");
  assert.equal(events[events.length - 1].playing, false, "最終イベントは停止状態であること");
  assert.ok(!events.some((e) => e.playing === true), "{playing:true} を流さないこと");
  assert.equal(intervalsCreated - createdBefore, 0, "interval を作らないこと");
  assert.equal(liveIntervals.size, 0);
});

test("終端再生 → pause → 再度終端 ▶ を繰り返しても interval が累積しない", async () => {
  state.project = readyProject();
  state.editVersion += 1;
  state.projectEpoch += 1;
  assert.equal(await player.preparePlayback(state.projectEpoch), true);

  for (let i = 0; i < 3; i += 1) {
    player.seek(1);
    await player.play();
    assert.equal(player.isPlaying(), true);
    player.pause();
    assert.equal(player.isPlaying(), false);
  }
  assert.equal(intervalsCreated, intervalsCleared, "サイクル毎の interval が全て解放されること");
  assert.equal(liveIntervals.size, 0);
});

// ── Issue #20: 選択追従シーク ────────────────────────────

test("seekToSelectionStart: 停止中は対象位置へ移動する（被り=区間先頭 / 波形=クリック位置）", async () => {
  state.project = readyProject();
  state.editVersion += 1;
  state.projectEpoch += 1;
  assert.equal(await player.preparePlayback(state.projectEpoch), true);

  assert.equal(player.seekToSelectionStart(0.5), true);
  assert.equal(player.getCurrentTime(), 0.5);
  // 負値・非数は seek のクランプに委ねる（0 に丸まる）
  assert.equal(player.seekToSelectionStart(-3), true);
  assert.equal(player.getCurrentTime(), 0);
  assert.equal(player.seekToSelectionStart(NaN), true);
  assert.equal(player.getCurrentTime(), 0);
});

test("seekToSelectionStart: 再生中はヘッドを動かさない（聴きながらの選択を妨げない）", async () => {
  player.seek(0.3);
  await player.play();
  assert.equal(player.isPlaying(), true);

  assert.equal(player.seekToSelectionStart(0.8), false);
  assert.equal(player.getCurrentTime(), 0.3, "再生位置が選択で飛ばないこと");
  assert.equal(player.isPlaying(), true, "再生が止まらないこと");

  player.pause();
  // 停止後は再び追従する
  assert.equal(player.seekToSelectionStart(0.8), true);
  assert.equal(player.getCurrentTime(), 0.8);
});
