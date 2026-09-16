// player.js — 再生エンジン
// HTTP Range PCM スライス + AudioBufferSourceNode の先読みスケジューリング。
// A/B は同一 AudioContext クロックでサンプル精度同期。
// モジュールトップで AudioContext / DOM / Audio に触らない（node --test セーフ）。

import { state, emit } from "./state.js";
import { clamp, dbToLinear, blockEnd, lowerBound } from "./utils.js";
import { getIndex } from "./timelineModel.js";
import { createPcmStore } from "./pcm.js";
import { fetchWavMeta } from "./api.js";

const SPEAKERS = ["A", "B"];
const LOOKAHEAD_S = 3.0;            // 先読み窓
const SCHEDULE_INTERVAL_MS = 300;   // setInterval（タブ非表示でも継続）
const RAMP_S = 0.005;               // masterGain 5ms ランプ
const STOP_DELAY_S = 0.008;         // ランプ完了後にソース停止
const START_HEADROOM_S = 0.05;      // クロック起点の余裕（キャッシュ済チャンクの組み立て猶予）
const LATE_START_PAD_S = 0.02;      // fetch遅延時の再開パディング
const EPS = 1e-6;

// ── 純関数（テスト対象・状態非依存） ─────────────────────────────

// Issue #31: 出力レイテンシのサニタイズ。AudioContext.outputLatency は
// Bluetooth で 150〜500ms・負荷やデバイス切替で動的に変わるため**都度読む**
// （キャッシュ禁止）。未実装環境（undefined）・非有限・負値は 0 に倒す。
// ctx.baseLatency は含めない — 出力経路の遅延の正は outputLatency。
export function sanitizeOutputLatency(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// 聴感位置（Issue #31）: 「いま耳に聞こえているタイムライン時刻」。
// エンジン位置から outputLatency を引き、[0, end] にクランプする。
// 再生ヘッド描画・時刻表示・分割 S・±5s 等の**ユーザーの耳基準**の系はこちら。
export function audiblePosition({ posAtStart, ctxTime, ctxT0, outputLatency, end }) {
  const latency = sanitizeOutputLatency(outputLatency);
  const pos = posAtStart + Math.max(0, ctxTime - latency - ctxT0);
  const max = Number.isFinite(end) ? Math.max(0, end) : Number.POSITIVE_INFINITY;
  return clamp(pos, 0, max);
}

// エンジン位置: 「いまエンジンに送っているタイムライン時刻」（従来の getCurrentTime）。
// スケジューリングの先読み窓など**エンジン都合**の系はこちら。
export function enginePosition({ posAtStart, ctxTime, ctxT0 }) {
  return posAtStart + Math.max(0, ctxTime - ctxT0);
}

// [fromT, toT) と交差するアクティブブロックを窓でクリップして列挙する。
// fadeIn = セグメント頭がブロック本来の頭に一致 / fadeOut = 尻が本来の尻に一致。
// index は timelineModel.getIndex の TimelineIndex（byStart は (start, source_start, id) 昇順・deleted除外済み）。
export function computePlaybackSegments(index, speaker, fromT, toT) {
  const out = [];
  if (!index || !(toT > fromT)) return out;
  const blocks = (index.byStart && index.byStart[speaker]) || [];
  if (blocks.length === 0) return out;
  const maxDur = (index.maxDur && index.maxDur[speaker]) || 0;
  let i = lowerBound(blocks, fromT - maxDur, (b) => b.start);
  for (; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.start >= toT) break;
    const bEnd = blockEnd(b);
    const segStart = Math.max(b.start, fromT);
    const segEnd = Math.min(bEnd, toT);
    if (segEnd - segStart <= EPS) continue;
    out.push({
      blockId: b.id,
      timelineStart: segStart,
      srcStart: b.source_start + (segStart - b.start),
      dur: segEnd - segStart,
      fadeIn: segStart <= b.start + EPS,
      fadeOut: segEnd >= bEnd - EPS,
    });
  }
  return out;
}

// ブロック本来の端にのみ crossfade_ms 線形フェードを焼き込む
// （エクスポート render_edited_track の _apply_edge_fade と同じ耳ざわり = 音のWYSIWYG）。
function applyEdgeFades(data, fadeN, fadeIn, fadeOut) {
  if (fadeN <= 0) return;
  const n = data.length;
  if (fadeIn) {
    const m = Math.min(fadeN, n);
    for (let i = 0; i < m; i++) data[i] *= i / fadeN;
  }
  if (fadeOut) {
    const m = Math.min(fadeN, n);
    for (let i = 0; i < m; i++) data[n - 1 - i] *= i / fadeN;
  }
}

// ── モジュール状態 ──────────────────────────────────────────

let ctx = null;          // AudioContext（初回play操作で生成）
let masterGain = null;
let trackGain = null;    // {A: GainNode, B: GainNode}
let store = null;        // PcmStore
let prepared = false;
let disabled = false;

let playing = false;
let pausedAt = 0;        // 停止中のトランスポート位置（秒）
let posAtStart = 0;      // 再生開始時のタイムライン位置
let ctxT0 = 0;           // 再生開始時の ctx.currentTime（+ヘッドルーム）
let generation = 0;      // 世代トークン（seek/pause/編集/切替で++。async完了時不一致は破棄）
let scheduledUntil = { A: 0, B: 0 };
const activeSources = new Set();
let intervalId = null;
let rafId = null;

let gains = { A: 0, B: 0 };          // dB
let muted = { A: false, B: false };  // solo=相手mute は UI 側の責務

let previewAudio = null;  // 単一 HTMLAudio（プレビューアービタ §4.5）
let previewToken = 0;

// ── 内部ヘルパ ─────────────────────────────────────────────

function timelineEndNow() {
  if (!state.project) return 0;
  const index = getIndex(state.project, state.editVersion);
  return (index && index.timelineEnd) || 0;
}

function ensureContext() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AC !== "function") {
    disabled = true;
    emit("player-state", { playing: false, disabled: true });
    return null;
  }
  const rate =
    (state.wavMeta.A && state.wavMeta.A.sampleRate) ||
    (state.wavMeta.B && state.wavMeta.B.sampleRate) ||
    48000;
  try {
    ctx = new AC({ sampleRate: rate });
  } catch (_err) {
    try {
      // コンテキストレート指定非対応環境は Web Audio の自動リサンプルに委ねる
      ctx = new AC();
    } catch (_err2) {
      disabled = true;
      emit("player-state", { playing: false, disabled: true });
      return null;
    }
  }
  masterGain = ctx.createGain();
  masterGain.gain.value = 1;
  masterGain.connect(ctx.destination);
  trackGain = { A: ctx.createGain(), B: ctx.createGain() };
  for (const sp of SPEAKERS) {
    trackGain[sp].gain.value = muted[sp] ? 0 : dbToLinear(gains[sp]);
    trackGain[sp].connect(masterGain);
  }
  return ctx;
}

function applyTrackGain(sp) {
  if (!ctx || !trackGain) return;
  const target = muted[sp] ? 0 : dbToLinear(gains[sp]);
  const g = trackGain[sp].gain;
  const t = ctx.currentTime;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.linearRampToValueAtTime(target, t + RAMP_S);
}

function rampMaster(target) {
  const g = masterGain.gain;
  const t = ctx.currentTime;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.linearRampToValueAtTime(target, t + RAMP_S);
}

// 5msで0へ落とし、STOP_DELAY_S 時点で全ソース停止、その後1へ戻す（クリック除去）
function dipAndStop() {
  const g = masterGain.gain;
  const t = ctx.currentTime;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.linearRampToValueAtTime(0, t + RAMP_S);
  g.setValueAtTime(0, t + STOP_DELAY_S);
  g.linearRampToValueAtTime(1, t + STOP_DELAY_S + RAMP_S);
  stopSourcesAt(t + STOP_DELAY_S);
}

function stopSourcesAt(when) {
  for (const src of activeSources) {
    try {
      src.stop(when);
    } catch (_err) {
      // 既に停止済み
    }
  }
  activeSources.clear();
}

function crossfadeMsNow() {
  const cf = state.project && state.project.settings ? state.project.settings.crossfade_ms : null;
  return typeof cf === "number" && Number.isFinite(cf) ? cf : 10;
}

async function scheduleSegment(sp, seg, gen, cfMs) {
  let data;
  try {
    data = await store.getSegment(sp, seg.srcStart, seg.srcStart + seg.dur);
  } catch (err) {
    if (gen === generation) console.warn(`player: PCM取得失敗 (${sp})`, err);
    return;
  }
  // 世代トークン: seek/pause/編集/切替後の遅延完了は破棄
  if (gen !== generation || !playing || !ctx || !data || data.length === 0) return;
  const meta = state.wavMeta[sp];
  const rate = (meta && meta.sampleRate) || 48000;
  applyEdgeFades(data, Math.round((cfMs / 1000) * rate), seg.fadeIn, seg.fadeOut);
  const buffer = ctx.createBuffer(1, data.length, rate);
  buffer.copyToChannel(data, 0);
  const when = ctxT0 + (seg.timelineStart - posAtStart);
  const now = ctx.currentTime;
  let startAt = when;
  let offsetS = 0;
  if (when < now) {
    // fetch遅延で予定時刻を過ぎた: 先頭トリムして max(now+pad, when) から
    startAt = Math.max(now + LATE_START_PAD_S, when);
    offsetS = startAt - when;
    if (offsetS >= seg.dur - EPS) return;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(trackGain[sp]);
  activeSources.add(src);
  src.onended = () => {
    // バッファ参照破棄（滞留はルックアヘッド分のみ）
    activeSources.delete(src);
    try {
      src.disconnect();
    } catch (_err) {
      /* no-op */
    }
  };
  src.start(startAt, offsetS);
}

function schedulePass() {
  if (!playing || !prepared || !ctx || !state.project) return;
  const end = timelineEndNow();
  // 終了判定は**聴感位置**（Issue #31）: エンジン位置で止めると出力レイテンシ分
  // （Bluetooth で最大 0.5s）の末尾がまだ鳴っているのに pause され、尻切れになる。
  // エンジンが終端まで送り終えた後は segments が空になるだけで害はない。
  if (getCurrentTime() >= end - EPS) {
    finishAtEnd(Math.max(0, end));
    return;
  }
  const gen = generation;
  // 先読み窓の起点は**エンジン位置**: 聴感位置を使うとレイテンシ分だけ窓が過去へ
  // ずれ、実効ルックアヘッドが縮む（スケジューリングはエンジン都合の系）。
  const horizon = engineTimeNow() + LOOKAHEAD_S;
  const index = getIndex(state.project, state.editVersion);
  const cfMs = crossfadeMsNow();
  for (const sp of SPEAKERS) {
    const from = scheduledUntil[sp];
    if (horizon <= from) continue;
    const segs = computePlaybackSegments(index, sp, from, horizon);
    scheduledUntil[sp] = horizon;
    for (const seg of segs) scheduleSegment(sp, seg, gen, cfMs);
  }
}

function finishAtEnd(end) {
  pause();
  pausedAt = end;
  emit("playhead-tick", end);
}

function startTicker() {
  stopTicker();
  if (typeof globalThis.requestAnimationFrame !== "function") return;
  const loop = () => {
    if (!playing) {
      rafId = null;
      return;
    }
    const end = timelineEndNow();
    const t = getCurrentTime();
    if (t >= end - EPS) {
      rafId = null;
      finishAtEnd(Math.max(0, end));
      return;
    }
    emit("playhead-tick", t);
    rafId = globalThis.requestAnimationFrame(loop);
  };
  rafId = globalThis.requestAnimationFrame(loop);
}

function stopTicker() {
  if (rafId !== null && typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(rafId);
  }
  rafId = null;
}

function stopPreviewInternal() {
  previewToken++;
  if (previewAudio) previewAudio.pause();
}

// ── 公開 API ───────────────────────────────────────────────

export function initPlayer() {
  stopAll();
  generation++;
  prepared = false;
  disabled = false;
  pausedAt = 0;
}

// wavMeta×2 取得 + PcmStore 準備。epoch 不一致（プロジェクト切替）の応答は破棄。
// 成功で true / 失敗・破棄で false を返す（失敗時は再生系のみ disabled。toast は呼び出し側）。
export async function preparePlayback(epoch) {
  stopPreviewInternal();
  if (playing) pause();
  generation++;
  pausedAt = 0;
  prepared = false;
  disabled = false;
  if (store) {
    store.invalidateAll();
    store = null;
  }
  if (epoch === state.projectEpoch) {
    state.wavMeta.A = null;
    state.wavMeta.B = null;
  }
  const project = state.project;
  if (!project || !project.id) {
    disabled = true;
    return false;
  }
  const tracks = project.tracks || {};
  gains = {
    A: tracks.A && Number.isFinite(tracks.A.gain_db) ? tracks.A.gain_db : 0,
    B: tracks.B && Number.isFinite(tracks.B.gain_db) ? tracks.B.gain_db : 0,
  };
  muted = { A: false, B: false };
  if (ctx) {
    applyTrackGain("A");
    applyTrackGain("B");
  }
  try {
    const [a, b] = await Promise.all([
      fetchWavMeta(project.id, "A"),
      fetchWavMeta(project.id, "B"),
    ]);
    if (epoch !== state.projectEpoch) return false;
    state.wavMeta.A = a;
    state.wavMeta.B = b;
    const s = createPcmStore(project.id);
    s.prepare({ A: a, B: b });
    store = s;
    prepared = true;
    return true;
  } catch (err) {
    if (epoch === state.projectEpoch) {
      disabled = true;
      console.warn("player: preparePlayback 失敗", err);
      emit("player-state", { playing: false, disabled: true });
    }
    return false;
  }
}

export async function play() {
  if (playing || disabled || !prepared) return;
  stopPreviewInternal(); // 本編play開始時はプレビュー停止（§4.5）
  const c = ensureContext();
  if (!c) return;
  if (c.state === "suspended") {
    try {
      await c.resume();
    } catch (_err) {
      disabled = true;
      emit("player-state", { playing: false, disabled: true });
      return;
    }
  }
  if (playing || disabled || !prepared) return; // resume await 中の状態変化ガード
  const end = timelineEndNow();
  if (pausedAt >= end - EPS) pausedAt = 0; // 終端（または終端超）からの ▶ は先頭から再生
  playing = true;
  posAtStart = clamp(pausedAt, 0, Math.max(0, end));
  ctxT0 = c.currentTime + START_HEADROOM_S;
  scheduledUntil = { A: posAtStart, B: posAtStart };
  const g = masterGain.gain;
  const t = c.currentTime;
  g.cancelScheduledValues(t);
  g.setValueAtTime(0, t);
  g.linearRampToValueAtTime(1, t + RAMP_S);
  schedulePass();
  // schedulePass が同期的に finishAtEnd → pause() した場合（空タイムライン等）は
  // ここで打ち切る: interval/ticker を張らず {playing:true} も流さない
  // （流すと ⏸ 表示のまま固まり、interval が次の play まで解放されない）。
  if (!playing) return;
  intervalId = setInterval(schedulePass, SCHEDULE_INTERVAL_MS);
  startTicker();
  emit("player-state", { playing: true });
}

export function pause() {
  if (!playing) return;
  // 一時停止位置は**聴感位置**（Issue #31）: 「⏸ → ヘッドが指す場所 = 直前まで
  // 聞こえていた場所」。resume（play）はこの値を posAtStart にして新規スケジュール
  // するため、エンジン位置への逆変換は不要 — 送信済みで未再生だったレイテンシ分
  // （Bluetooth で最大 0.5s）は resume 時に聞こえていた位置から鳴り直される。
  // エンジン位置で保存すると、聞こえていない未来へ飛んで語の途中が欠落する。
  pausedAt = getCurrentTime();
  playing = false;
  generation++;
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  stopTicker();
  if (ctx) {
    rampMaster(0);
    stopSourcesAt(ctx.currentTime + STOP_DELAY_S);
  }
  emit("player-state", { playing: false });
}

export async function toggle() {
  if (playing) pause();
  else await play();
}

export function seek(t) {
  const end = timelineEndNow();
  const target = clamp(Number.isFinite(t) ? t : 0, 0, Math.max(0, end));
  generation++;
  if (playing && ctx) {
    dipAndStop();
    posAtStart = target;
    ctxT0 = ctx.currentTime + START_HEADROOM_S;
    scheduledUntil = { A: target, B: target };
    schedulePass();
  } else {
    pausedAt = target;
  }
  emit("playhead-tick", target);
}

// 選択追従シーク（Issue #20）: 選択操作で再生ヘッドを対象位置（被り一覧=区間の先頭 /
// 波形クリック=クリック位置）へ移す。再生中は動かさない（聴きながらの選択作業と、
// 再生で位置を決めてから S で分割するワークフローを妨げない）。移動したら true。
export function seekToSelectionStart(start) {
  if (playing) return false;
  seek(start); // クランプ・非数の扱いは seek に委ねる
  return true;
}

// 聴感位置（公開クロック。Issue #31）: 外部の呼び出し元（再生ヘッド描画・時刻表示・
// 分割 S・±5s・無音の挿入/削除の基準位置）はすべて「ユーザーの耳基準」なのでこちら。
// Bluetooth 出力（outputLatency 150〜500ms）でも波形上のヘッドと聞こえている声が一致する。
// outputLatency は都度読む（デバイス切替・負荷で動的に変わる）。停止中は pausedAt。
export function getCurrentTime() {
  if (!playing || !ctx) return pausedAt;
  return audiblePosition({
    posAtStart,
    ctxTime: ctx.currentTime,
    ctxT0,
    outputLatency: ctx.outputLatency,
    end: timelineEndNow(),
  });
}

// エンジン位置（内部クロック）: schedulePass の先読み窓の起点だけが使う。
function engineTimeNow() {
  if (!playing || !ctx) return pausedAt;
  return enginePosition({ posAtStart, ctxTime: ctx.currentTime, ctxT0 });
}

export function isPlaying() {
  return playing;
}

export function setGainDb(speaker, db) {
  if (!(speaker in gains)) return;
  gains[speaker] = Number.isFinite(db) ? db : 0;
  applyTrackGain(speaker);
}

export function setTrackMute(speaker, isMuted) {
  if (!(speaker in muted)) return;
  muted[speaker] = !!isMuted;
  applyTrackGain(speaker);
}

// 編集時（main が blocks-changed 購読で呼ぶ）: 再生中なら現位置から再スケジュール
export function notifyBlocksChanged() {
  if (!playing || !ctx) return;
  generation++;
  // 再スケジュール起点は**聴感位置**（pause→resume と同じ判断。Issue #31）:
  // 編集の瞬間に聞こえていた場所から続ける。エンジン位置だとレイテンシ分先へ
  // スキップし、編集のたびに音が飛んで聞こえる。
  const t = getCurrentTime();
  dipAndStop();
  posAtStart = t;
  ctxT0 = ctx.currentTime + START_HEADROOM_S;
  scheduledUntil = { A: t, B: t };
  schedulePass();
}

// ── プレビューアービタ（§4.5）: 音が2つ鳴り得る経路をここに閉じ込める ──

export async function playPreview(url) {
  if (playing) pause(); // (1) 本編 pause
  const token = ++previewToken; // (3) 古い play() 解決を無視
  if (previewAudio) {
    previewAudio.pause(); // (2) 保持中の単一 HTMLAudio を pause
  } else {
    if (typeof globalThis.Audio !== "function") return;
    previewAudio = new globalThis.Audio();
  }
  previewAudio.src = url;
  try {
    await previewAudio.play(); // (4) 新規再生
  } catch (err) {
    // 後続の playPreview / stopAll に追い越された分は握りつぶす
    if (token === previewToken) throw err;
  }
}

export function stopAll() {
  stopPreviewInternal();
  if (playing) pause();
}
