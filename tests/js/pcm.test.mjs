// pcm.test.mjs — parseWavHeader / PPK1 パース / PcmStore チャンク LRU のユニットテスト（node --test）
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseWavHeader,
  createPcmStore,
  CHUNK_SECONDS,
  LRU_MAX_CHUNKS,
  MAX_CHUNKS_PER_FETCH,
} from "../../src/podcast_prep/static/js/pcm.js";
import { parsePpk1, fetchWavMeta } from "../../src/podcast_prep/static/js/api.js";

// ---------- WAV 合成ヘルパ ----------

function writeAscii(bytes, pos, text) {
  for (let i = 0; i < text.length; i += 1) bytes[pos + i] = text.charCodeAt(i);
}

function fmtChunk({ audioFormat = 1, channels = 1, sampleRate = 48000, bitsPerSample = 16 } = {}) {
  const body = new Uint8Array(16);
  const view = new DataView(body.buffer);
  view.setUint16(0, audioFormat, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(12, channels * (bitsPerSample / 8), true);
  view.setUint16(14, bitsPerSample, true);
  return ["fmt ", body];
}

function dataChunk(samples) {
  const body = new Uint8Array(samples.length * 2);
  const view = new DataView(body.buffer);
  samples.forEach((value, i) => view.setInt16(i * 2, value, true));
  return ["data", body];
}

function junkChunk(id, size) {
  return [id, new Uint8Array(size).fill(0x6a)];
}

function buildWav(chunks, { riffSizeOverride = null, truncateTo = null, magic = "RIFF", wave = "WAVE" } = {}) {
  let total = 12;
  for (const [, body] of chunks) total += 8 + body.length + (body.length % 2);
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  writeAscii(bytes, 0, magic);
  view.setUint32(4, riffSizeOverride ?? total - 8, true);
  writeAscii(bytes, 8, wave);
  let pos = 12;
  for (const [id, body] of chunks) {
    writeAscii(bytes, pos, id);
    view.setUint32(pos + 4, body.length, true);
    bytes.set(body, pos + 8);
    pos += 8 + body.length + (body.length % 2);
  }
  if (truncateTo !== null) return buffer.slice(0, truncateTo);
  return buffer;
}

// ---------- parseWavHeader ----------

test("parseWavHeader: 標準44Bヘッダ", () => {
  const buffer = buildWav([fmtChunk(), dataChunk([0, 1, -1, 2])]);
  const meta = parseWavHeader(buffer);
  assert.equal(meta.sampleRate, 48000);
  assert.equal(meta.channels, 1);
  assert.equal(meta.bitsPerSample, 16);
  assert.equal(meta.dataOffset, 44);
  assert.equal(meta.dataBytes, 8);
  assert.equal(meta.durationSec, 8 / (48000 * 2));
});

test("parseWavHeader: LISTチャンク挟み込み（偶数長）", () => {
  const buffer = buildWav([fmtChunk(), junkChunk("LIST", 26), dataChunk([5, 6])]);
  const meta = parseWavHeader(buffer);
  assert.equal(meta.dataOffset, 44 + 8 + 26);
  assert.equal(meta.dataBytes, 4);
});

test("parseWavHeader: 奇数長チャンクはパディング込みでスキップ", () => {
  const buffer = buildWav([fmtChunk(), junkChunk("LIST", 7), dataChunk([5])]);
  const meta = parseWavHeader(buffer);
  assert.equal(meta.dataOffset, 44 + 8 + 7 + 1);
});

test("parseWavHeader: fmt後方配置（LIST が先）", () => {
  const buffer = buildWav([junkChunk("LIST", 12), fmtChunk({ sampleRate: 44100 }), dataChunk([1])]);
  const meta = parseWavHeader(buffer);
  assert.equal(meta.sampleRate, 44100);
  assert.equal(meta.dataOffset, 12 + 8 + 12 + 8 + 16 + 8);
});

test("parseWavHeader: fmt が data より後でも解析できる", () => {
  const buffer = buildWav([dataChunk([1, 2]), fmtChunk()]);
  const meta = parseWavHeader(buffer);
  assert.equal(meta.dataOffset, 20);
  assert.equal(meta.dataBytes, 4);
});

test("parseWavHeader: dataチャンク欠落（完全なファイル）は確定エラー", () => {
  const buffer = buildWav([fmtChunk()]);
  assert.throws(() => parseWavHeader(buffer), /data チャンクがありません/);
  try {
    parseWavHeader(buffer);
  } catch (err) {
    assert.notEqual(err.code, "WAV_HEADER_INCOMPLETE"); // 再試行しても無駄なので incomplete 扱いにしない
  }
});

test("parseWavHeader: 切詰めバッファは WAV_HEADER_INCOMPLETE", () => {
  const full = buildWav([fmtChunk(), junkChunk("LIST", 6000), dataChunk([1, 2, 3])]);
  const truncated = full.slice(0, 4096);
  try {
    parseWavHeader(truncated);
    assert.fail("should throw");
  } catch (err) {
    assert.equal(err.code, "WAV_HEADER_INCOMPLETE");
  }
});

test("parseWavHeader: 非RIFF / 非WAVE", () => {
  assert.throws(() => parseWavHeader(buildWav([fmtChunk(), dataChunk([1])], { magic: "JUNK" })), /RIFF/);
  assert.throws(() => parseWavHeader(buildWav([fmtChunk(), dataChunk([1])], { wave: "AVI " })), /WAVE/);
});

test("parseWavHeader: fmt 検証（PCM/mono/16bit 以外は拒否）", () => {
  assert.throws(() => parseWavHeader(buildWav([fmtChunk({ audioFormat: 3 }), dataChunk([1])])), /PCM/);
  assert.throws(() => parseWavHeader(buildWav([fmtChunk({ channels: 2 }), dataChunk([1])])), /mono/);
  assert.throws(() => parseWavHeader(buildWav([fmtChunk({ bitsPerSample: 24 }), dataChunk([1])])), /16bit/);
});

// ---------- PPK1 ----------

function buildPpk1({ magic = "PPK1", binsPerSec = 200, binCount = null, bins = [0, 10, 255] } = {}) {
  const buffer = new ArrayBuffer(16 + bins.length);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  writeAscii(bytes, 0, magic);
  view.setUint32(4, binsPerSec, true);
  view.setUint32(8, binCount ?? bins.length, true);
  view.setUint32(12, 0, true);
  bytes.set(bins, 16);
  return buffer;
}

test("parsePpk1: 正常系", () => {
  const peaks = parsePpk1(buildPpk1({ bins: [0, 128, 255, 7] }));
  assert.equal(peaks.binsPerSec, 200);
  assert.deepEqual(Array.from(peaks.bins), [0, 128, 255, 7]);
});

test("parsePpk1: 異常系（magic不一致 / bin_count=0 / 切詰めボディ / 短小ヘッダ）", () => {
  assert.throws(() => parsePpk1(buildPpk1({ magic: "XPK1" })), /不明なフォーマット/);
  assert.throws(() => parsePpk1(buildPpk1({ bins: [], binCount: 0 })), /bin_count/);
  assert.throws(() => parsePpk1(buildPpk1({ bins: [1, 2, 3], binCount: 10 })), /切り詰め/);
  assert.throws(() => parsePpk1(new ArrayBuffer(8)), /ヘッダが不足/);
});

// ---------- PcmStore ----------

const RATE = 100; // 10秒チャンク = 1000サンプルでテストしやすくする
const DATA_OFFSET = 44;

function sampleValue(i) {
  return ((i * 31 + 7) % 65536) - 32768;
}

function makeStore({ totalSamples = 30000, patch = null, gate = null } = {}) {
  const file = new Int16Array(totalSamples);
  for (let i = 0; i < totalSamples; i += 1) file[i] = sampleValue(i);
  if (patch) patch(file);
  const calls = [];
  const fetchRange = async (_projectId, _speaker, _meta, byteStart, byteEndInclusive) => {
    calls.push({ byteStart, byteEndInclusive });
    if (gate) await gate.promise;
    const startSample = (byteStart - DATA_OFFSET) / 2;
    const count = (byteEndInclusive - byteStart + 1) / 2;
    return file.slice(startSample, startSample + count).buffer;
  };
  const meta = {
    sampleRate: RATE,
    channels: 1,
    bitsPerSample: 16,
    dataOffset: DATA_OFFSET,
    dataBytes: totalSamples * 2,
    durationSec: totalSamples / RATE,
  };
  const store = createPcmStore("proj-1", fetchRange);
  store.prepare({ A: meta, B: null });
  return { store, calls, file };
}

test("PcmStore: チャンク境界跨ぎの組み立てと Int16→Float32 変換", async () => {
  const { store, calls, file } = makeStore();
  const out = await store.getSegment("A", 9.98, 10.02); // samples 998..1002（chunk 0 と 1 を跨ぐ）
  assert.equal(out.length, 4);
  for (let i = 0; i < 4; i += 1) assert.equal(out[i], file[998 + i] / 32768);
  // 連続する欠落チャンク 0,1 は 1 リクエストに合体
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { byteStart: DATA_OFFSET, byteEndInclusive: DATA_OFFSET + 2000 * 2 - 1 });
});

test("PcmStore: Int16 境界値 ±32768 の変換", async () => {
  const { store } = makeStore({
    patch: (file) => {
      file[0] = -32768;
      file[1] = 32767;
    },
  });
  const out = await store.getSegment("A", 0, 0.02);
  assert.equal(out[0], -1.0);
  assert.equal(out[1], 32767 / 32768);
});

test("PcmStore: Range 合体は 5 チャンク上限で分割される", async () => {
  const { store, calls, file } = makeStore({ totalSamples: 10000 });
  const out = await store.getSegment("A", 0, 70); // chunks 0..6 → [0-4] + [5-6]
  assert.equal(out.length, 7000);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    byteStart: DATA_OFFSET,
    byteEndInclusive: DATA_OFFSET + MAX_CHUNKS_PER_FETCH * CHUNK_SECONDS * RATE * 2 - 1,
  });
  assert.deepEqual(calls[1], { byteStart: DATA_OFFSET + 10000, byteEndInclusive: DATA_OFFSET + 14000 - 1 });
  assert.equal(out[6999], file[6999] / 32768);
});

test("PcmStore: キャッシュヒットでは fetch しない", async () => {
  const { store, calls } = makeStore();
  await store.getSegment("A", 0, 15);
  const before = calls.length;
  await store.getSegment("A", 3, 12);
  assert.equal(calls.length, before);
});

test("PcmStore: キャッシュ済みチャンクを挟む欠落は合体が分断される", async () => {
  const { store, calls } = makeStore({ totalSamples: 10000 });
  await store.getSegment("A", 20, 30); // chunk 2 をキャッシュ
  assert.equal(calls.length, 1);
  await store.getSegment("A", 0, 50); // 欠落は 0,1 / 3,4 の 2 ラン
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], { byteStart: DATA_OFFSET, byteEndInclusive: DATA_OFFSET + 4000 - 1 });
  assert.deepEqual(calls[2], { byteStart: DATA_OFFSET + 6000, byteEndInclusive: DATA_OFFSET + 10000 - 1 });
});

test("PcmStore: LRU は 24 チャンク上限・最近使用を残す", async () => {
  const { store, calls } = makeStore({ totalSamples: 26000 });
  for (let i = 0; i < LRU_MAX_CHUNKS; i += 1) {
    await store.getSegment("A", i * 10, i * 10 + 0.5); // chunk i を個別ロード
  }
  assert.equal(calls.length, LRU_MAX_CHUNKS);
  await store.getSegment("A", 0, 0.5); // chunk 0 に触れて最近使用へ
  assert.equal(calls.length, LRU_MAX_CHUNKS);
  await store.getSegment("A", 240, 240.5); // chunk 24 追加 → 最古の chunk 1 が追い出される
  assert.equal(calls.length, LRU_MAX_CHUNKS + 1);
  await store.getSegment("A", 0, 0.5); // chunk 0 は残っている
  assert.equal(calls.length, LRU_MAX_CHUNKS + 1);
  await store.getSegment("A", 10, 10.5); // chunk 1 は追い出されたので再フェッチ
  assert.equal(calls.length, LRU_MAX_CHUNKS + 2);
});

test("PcmStore: data 末尾でクランプ・範囲外は空", async () => {
  const { store, calls, file } = makeStore({ totalSamples: 1500 });
  const out = await store.getSegment("A", 10, 20); // 実データは sample 1500 まで
  assert.equal(out.length, 500);
  assert.equal(out[499], file[1499] / 32768);
  assert.deepEqual(calls[0], { byteStart: DATA_OFFSET + 2000, byteEndInclusive: DATA_OFFSET + 3000 - 1 });
  const empty = await store.getSegment("A", 20, 25); // 完全に EOF 以降
  assert.equal(empty.length, 0);
  assert.equal(calls.length, 1); // fetch は発生しない
  const negative = await store.getSegment("A", -1, 0.05); // 負開始は 0 クランプ
  assert.equal(negative.length, 5);
});

test("PcmStore: 同一チャンクの並行要求は 1 フェッチに合流する", async () => {
  let release;
  const gate = { promise: new Promise((resolve) => (release = resolve)) };
  const { store, calls, file } = makeStore({ gate });
  const p1 = store.getSegment("A", 0, 5);
  const p2 = store.getSegment("A", 3, 8);
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(calls.length, 1);
  assert.equal(a[0], file[0] / 32768);
  assert.equal(b[0], file[300] / 32768);
});

test("PcmStore: invalidateAll でキャッシュが破棄される", async () => {
  const { store, calls } = makeStore();
  await store.getSegment("A", 0, 5);
  assert.equal(calls.length, 1);
  store.invalidateAll();
  await store.getSegment("A", 0, 5);
  assert.equal(calls.length, 2);
});

test("PcmStore: fetch 失敗は伝播し、後続の再試行で回復する", async () => {
  const file = new Int16Array(1000);
  for (let i = 0; i < 1000; i += 1) file[i] = sampleValue(i);
  let fail = true;
  const store = createPcmStore("proj-1", async (_p, _s, _m, byteStart, byteEndInclusive) => {
    if (fail) throw new Error("network down");
    const startSample = (byteStart - DATA_OFFSET) / 2;
    return file.slice(startSample, startSample + (byteEndInclusive - byteStart + 1) / 2).buffer;
  });
  store.prepare({
    A: { sampleRate: RATE, channels: 1, bitsPerSample: 16, dataOffset: DATA_OFFSET, dataBytes: 2000, durationSec: 10 },
    B: null,
  });
  await assert.rejects(store.getSegment("A", 0, 1), /network down/);
  fail = false;
  const out = await store.getSegment("A", 0, 1);
  assert.equal(out.length, 100);
  assert.equal(out[0], file[0] / 32768);
});

test("PcmStore: 未準備トラックの getSegment は reject", async () => {
  const { store } = makeStore();
  await assert.rejects(store.getSegment("B", 0, 1), /準備されていません/);
});

// ---------- fetchWavMeta（globalThis.fetch スタブ） ----------

test("fetchWavMeta: 4KB で不足なら 0-65535 で 1 回だけ再試行する", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const full = buildWav([fmtChunk(), junkChunk("LIST", 6000), dataChunk([1, 2, 3, 4])]);
  const ranges = [];
  globalThis.fetch = async (_url, options) => {
    ranges.push(options.headers.Range);
    const match = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
    const end = Math.min(Number(match[2]), full.byteLength - 1);
    const body = full.slice(Number(match[1]), end + 1);
    return { status: 206, ok: true, arrayBuffer: async () => body };
  };
  const meta = await fetchWavMeta("p1", "A");
  assert.deepEqual(ranges, ["bytes=0-4095", "bytes=0-65535"]);
  assert.equal(meta.dataOffset, 12 + (8 + 16) + (8 + 6000) + 8);
  assert.equal(meta.dataBytes, 8);
});

test("fetchWavMeta: 206 以外は即 throw（200 の全量 DL を受理しない）", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return { status: 200, ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  await assert.rejects(fetchWavMeta("p1", "A"), /206/);
  assert.equal(callCount, 1);
});
