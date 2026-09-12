// pcm.js — WAVヘッダ解析 + ソース時間固定10秒チャンクの Int16 LRU キャッシュ（player のみが使う）
// 契約: DOM・state 直接参照禁止。チャンクはソース時間で固定するため、
//       ブロックの移動・分割でキャッシュが無効化されない。

import { fetchPcmRange } from "./api.js";

export const CHUNK_SECONDS = 10;       // ソース時間固定チャンク（編集不変条件により move/split/delete で無効化されない）
export const LRU_MAX_CHUNKS = 24;      // 1トラックあたり ≒240秒 ≒23MB（Int16）
export const MAX_CHUNKS_PER_FETCH = 5; // 連続欠落チャンクの Range 合体上限（=50秒/リクエスト）

function asciiAt(view, pos) {
  return String.fromCharCode(
    view.getUint8(pos),
    view.getUint8(pos + 1),
    view.getUint8(pos + 2),
    view.getUint8(pos + 3),
  );
}

// バッファ切詰めが原因で fmt/data に到達できなかったことを示すエラー。
// api.fetchWavMeta はこのコードのときだけ bytes=0-65535 で1回再試行する。
function incompleteError(message) {
  const err = new Error(message);
  err.code = "WAV_HEADER_INCOMPLETE";
  return err;
}

// RIFF チャンクを汎用ウォークして WavMeta を返す純関数（node --test 対象）。
// LIST 等の未知チャンクはスキップ。fmt は PCM / mono / 16bit を検証する。
// 返却: {sampleRate, channels, bitsPerSample, dataOffset, dataBytes, durationSec}
export function parseWavHeader(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const len = view.byteLength;
  if (len < 12) throw incompleteError("wav: バッファが短すぎます");
  if (asciiAt(view, 0) !== "RIFF") throw new Error("wav: RIFF ファイルではありません");
  if (asciiAt(view, 8) !== "WAVE") throw new Error("wav: WAVE ファイルではありません");
  const riffEnd = 8 + view.getUint32(4, true);
  let fmt = null;
  let dataOffset = null;
  let dataBytes = null;
  let pos = 12;
  while (pos + 8 <= len && (fmt === null || dataOffset === null)) {
    const id = asciiAt(view, pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      if (body + 16 > len) throw incompleteError("wav: fmt チャンクが途中で切れています");
      const audioFormat = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      if (audioFormat !== 1) throw new Error(`wav: PCM 以外は非対応です (format=${audioFormat})`);
      if (channels !== 1) throw new Error(`wav: mono 以外は非対応です (channels=${channels})`);
      if (bitsPerSample !== 16) throw new Error(`wav: 16bit 以外は非対応です (bits=${bitsPerSample})`);
      if (sampleRate === 0) throw new Error("wav: sample rate が 0 です");
      fmt = { sampleRate, channels, bitsPerSample };
    } else if (id === "data") {
      dataOffset = body;
      dataBytes = size;
    }
    pos = body + size + (size % 2); // 奇数長チャンクはパディング込みで進める
  }
  if (fmt === null || dataOffset === null) {
    if (len >= riffEnd) {
      // ファイル全体を見ても無い = 再試行しても無駄（確定エラー）
      throw new Error(fmt === null ? "wav: fmt チャンクがありません" : "wav: data チャンクがありません");
    }
    throw incompleteError("wav: ヘッダ範囲に fmt/data チャンクが見つかりません");
  }
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    dataOffset,
    dataBytes,
    durationSec: dataBytes / (fmt.sampleRate * 2),
  };
}

// PcmStore を生成する。fetchRange はテスト用のモック注入点（既定は api.fetchPcmRange）。
// PcmStore = { prepare(meta: {A,B}), getSegment(speaker, srcStartSec, srcEndSec) -> Promise<Float32Array>, invalidateAll() }
export function createPcmStore(projectId, fetchRange = fetchPcmRange) {
  const metas = { A: null, B: null };
  let caches = { A: new Map(), B: new Map() };   // chunkIndex -> Int16Array（Map の挿入順 = LRU 順）
  let pendings = { A: new Map(), B: new Map() }; // chunkIndex -> Promise<Int16Array>（同一チャンクの多重フェッチ防止）
  let generation = 0;

  function invalidateAll() {
    generation += 1;
    caches = { A: new Map(), B: new Map() };
    pendings = { A: new Map(), B: new Map() };
  }

  function prepare(meta) {
    metas.A = meta?.A || null;
    metas.B = meta?.B || null;
    invalidateAll(); // メタ差し替え時は旧チャンク・進行中フェッチを無効化
  }

  function totalSamplesOf(meta) {
    return Math.floor(meta.dataBytes / 2);
  }

  function touch(cache, idx) {
    const data = cache.get(idx);
    cache.delete(idx);
    cache.set(idx, data);
    return data;
  }

  function insertChunk(cache, idx, data) {
    if (cache.has(idx)) cache.delete(idx);
    cache.set(idx, data);
    while (cache.size > LRU_MAX_CHUNKS) {
      cache.delete(cache.keys().next().value); // 最古（先頭）を破棄
    }
  }

  async function fetchRun(speaker, meta, runIndices) {
    const chunkSamples = CHUNK_SECONDS * meta.sampleRate;
    const totalSamples = totalSamplesOf(meta);
    const startSample = Math.min(runIndices[0] * chunkSamples, totalSamples);
    const endSample = Math.min((runIndices[runIndices.length - 1] + 1) * chunkSamples, totalSamples);
    let samples = new Int16Array(0);
    if (endSample > startSample) {
      // バイト位置は data チャンク先頭 + サンプル×2（一貫して 2 バイト整列、末尾クランプ済み）
      const byteStart = meta.dataOffset + startSample * 2;
      const byteEndInclusive = meta.dataOffset + endSample * 2 - 1;
      const buffer = await fetchRange(projectId, speaker, meta, byteStart, byteEndInclusive);
      samples = new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2));
    }
    return runIndices.map((idx) => {
      const from = Math.max(0, Math.min(idx * chunkSamples - startSample, samples.length));
      const to = Math.max(from, Math.min((idx + 1) * chunkSamples - startSample, samples.length));
      return samples.slice(from, to); // チャンクごとに独立コピー（LRU 破棄が個別に効く）
    });
  }

  function scheduleRun(speaker, runIndices) {
    const meta = metas[speaker];
    const pending = pendings[speaker];
    const startedGeneration = generation;
    const run = fetchRun(speaker, meta, runIndices);
    runIndices.forEach((idx, k) => {
      pending.set(idx, run.then((chunks) => chunks[k]));
    });
    run
      .then((chunks) => {
        if (generation !== startedGeneration) return; // invalidateAll 後に到着した結果は破棄
        runIndices.forEach((idx, k) => insertChunk(caches[speaker], idx, chunks[k]));
      })
      .catch(() => {}) // エラーは getSegment 側の await で伝播する（ここでは握りつぶすだけ）
      .finally(() => {
        runIndices.forEach((idx) => pending.delete(idx));
      });
  }

  // indices（昇順）の各チャンクを Promise で返す。欠落分は連続ランごとに
  // 1 つの Range リクエストへ合体（上限 MAX_CHUNKS_PER_FETCH）。
  function requestChunks(speaker, indices) {
    const cache = caches[speaker];
    const pending = pendings[speaker];
    let run = [];
    const flush = () => {
      if (run.length) {
        scheduleRun(speaker, run);
        run = [];
      }
    };
    for (const idx of indices) {
      if (cache.has(idx) || pending.has(idx)) {
        flush();
        continue;
      }
      if (run.length && (idx !== run[run.length - 1] + 1 || run.length >= MAX_CHUNKS_PER_FETCH)) flush();
      run.push(idx);
    }
    flush();
    return indices.map((idx) => (cache.has(idx) ? Promise.resolve(touch(cache, idx)) : pending.get(idx)));
  }

  // ソース秒範囲 [srcStartSec, srcEndSec) を Float32Array（-1..1）で返す。
  // 範囲は data チャンク末尾でクランプ（丸めは一貫して Math.round）。
  async function getSegment(speaker, srcStartSec, srcEndSec) {
    const meta = metas[speaker];
    if (!meta) throw new Error(`pcm: track ${speaker} が準備されていません`);
    const chunkSamples = CHUNK_SECONDS * meta.sampleRate;
    const totalSamples = totalSamplesOf(meta);
    const startSample = Math.min(Math.max(Math.round(srcStartSec * meta.sampleRate), 0), totalSamples);
    const endSample = Math.min(Math.max(Math.round(srcEndSec * meta.sampleRate), 0), totalSamples);
    const out = new Float32Array(Math.max(0, endSample - startSample));
    if (out.length === 0) return out;
    const firstChunk = Math.floor(startSample / chunkSamples);
    const lastChunk = Math.floor((endSample - 1) / chunkSamples);
    const indices = [];
    for (let idx = firstChunk; idx <= lastChunk; idx += 1) indices.push(idx);
    const chunks = await Promise.all(requestChunks(speaker, indices));
    for (let k = 0; k < indices.length; k += 1) {
      const chunkStart = indices[k] * chunkSamples;
      const data = chunks[k];
      const from = Math.max(startSample - chunkStart, 0);
      const to = Math.min(endSample - chunkStart, data.length);
      let write = chunkStart + from - startSample;
      for (let i = from; i < to; i += 1) {
        out[write] = data[i] / 32768;
        write += 1;
      }
    }
    return out;
  }

  return { prepare, getSegment, invalidateAll };
}
