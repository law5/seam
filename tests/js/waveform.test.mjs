// ユニットテスト: peaks.peakMaxIn / peaks.loadPeaks / waveform の純関数部。
// canvas 依存部（描画パス）はテスト対象外（実機E2Eで確認）。
// 依存モジュール（api/state/utils/timelineModel）を切り離して走らせるため、
// 一時ディレクトリにスタブを置き、実物の peaks.js / waveform.js を
// コピーして import する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const jsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "src", "podcast_prep", "static", "js",
);

const STUB_API = `export async function fetchPeaksBinary(projectId, speaker) {
  const fn = globalThis.__fetchPeaksBinary;
  if (fn) return fn(projectId, speaker);
  throw new Error("stub: peaks unavailable");
}
`;

const STUB_STATE = `export const state = {
  project: null,
  peaks: { A: null, B: null },
  wavMeta: { A: null, B: null },
  selectedBlockId: null,
  zoom: 80,
  editVersion: 0,
  projectEpoch: 0,
};
export function emit() {}
export function on() { return () => {}; }
`;

const STUB_UTILS = `export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
export function fmtMs(seconds) {
  const ms = Math.round(seconds * 1000);
  return (ms < 0 ? "-" : "+") + Math.abs(ms).toLocaleString("en-US") + " ms";
}
export function blockDuration(b) { return Math.max(0, b.source_end - b.source_start); }
export function blockEnd(b) { return b.start + Math.max(0, b.source_end - b.source_start); }
`;

const STUB_TIMELINE_MODEL = `export function getIndex() {
  return { byStart: { A: [], B: [] }, bySource: { A: [], B: [] }, maxDur: { A: 0, B: 0 }, timelineEnd: 0 };
}
export function visibleBlocks() { return []; }
export function findBlockAt() { return null; }
`;

const dir = await mkdtemp(path.join(tmpdir(), "podcast-prep-w3-"));
await writeFile(path.join(dir, "api.js"), STUB_API);
await writeFile(path.join(dir, "state.js"), STUB_STATE);
await writeFile(path.join(dir, "utils.js"), STUB_UTILS);
await writeFile(path.join(dir, "timelineModel.js"), STUB_TIMELINE_MODEL);
await copyFile(path.join(jsDir, "peaks.js"), path.join(dir, "peaks.js"));
await copyFile(path.join(jsDir, "waveform.js"), path.join(dir, "waveform.js"));

const { state } = await import(pathToFileURL(path.join(dir, "state.js")).href);
const { loadPeaks, peakMaxIn } = await import(pathToFileURL(path.join(dir, "peaks.js")).href);
// waveform.js はモジュールトップで DOM に触らない契約 — import できること自体も検証になる
const {
  chooseRulerStep, computeFitZoom, COLORS, THEME_COLORS, applyThemeColors,
  fitState, resetFitState, exitFitState, resolveRestoreZoom, computeFitToggle, setZoom,
  // #59 PR4 Seam Strip の純関数部
  stripPxPerSec, stripBarHeight, computeStripDensity, computeStripWindow, stripXToTime,
  compressStripMarks, stripCacheSignature,
} = await import(
  pathToFileURL(path.join(dir, "waveform.js")).href
);

function pd(bins, binsPerSec = 200) {
  return { binsPerSec, bins: Uint8Array.from(bins) };
}

// Seam Strip の密度テスト用。タイムライン上 [start, end) を占める1ブロック
// （blockDuration が source_end - source_start を見るのでソース側も同じ長さにする）
function mkBlock(start, end) {
  return { id: `b${start}`, start, source_start: start, source_end: end, text: "", deleted: false };
}

// ── peakMaxIn ───────────────────────────────────────────

test("peakMaxIn: 全区間のmax", () => {
  assert.equal(peakMaxIn(pd([10, 200, 30, 40]), 0, 4 / 200), 200);
});

test("peakMaxIn: 単一bin内部の端数区間", () => {
  // [0.0125, 0.0135) は bin2 (0.010〜0.015) の内部
  assert.equal(peakMaxIn(pd([10, 20, 250, 30]), 0.0125, 0.0135), 250);
});

test("peakMaxIn: 端数バケットは両端とも含める", () => {
  // [0.004, 0.011) = bin0 の端数 + bin1 全体 + bin2 の端数
  assert.equal(peakMaxIn(pd([10, 20, 250, 30]), 0.004, 0.011), 250);
  // 右端が bin 境界ちょうど: [0, 0.010) は bin0..1 のみ（bin2 は含まない）
  assert.equal(peakMaxIn(pd([10, 20, 250, 30]), 0, 0.01), 20);
});

test("peakMaxIn: 範囲外は0", () => {
  assert.equal(peakMaxIn(pd([10, 20]), 1.0, 2.0), 0);
  assert.equal(peakMaxIn(pd([10, 20]), -1.0, -0.5), 0);
});

test("peakMaxIn: 部分的な範囲外はクランプ", () => {
  assert.equal(peakMaxIn(pd([10, 20]), -1.0, 0.004), 10);
  assert.equal(peakMaxIn(pd([10, 20]), 0.005, 5.0), 20);
});

test("peakMaxIn: ゼロ幅区間は属する単一binを参照", () => {
  assert.equal(peakMaxIn(pd([10, 99, 20]), 0.0075, 0.0075), 99);
});

test("peakMaxIn: 不正入力は0", () => {
  assert.equal(peakMaxIn(null, 0, 1), 0);
  assert.equal(peakMaxIn(undefined, 0, 1), 0);
  assert.equal(peakMaxIn(pd([]), 0, 1), 0);
  assert.equal(peakMaxIn(pd([10]), 0.5, 0.1), 0);
  assert.equal(peakMaxIn(pd([10]), NaN, 1), 0);
  assert.equal(peakMaxIn(pd([10]), 0, Infinity), 0);
});

// ── loadPeaks ───────────────────────────────────────────

test("loadPeaks: A/B並列fetch成功で state.peaks へ格納", async () => {
  state.projectEpoch = 1;
  state.peaks.A = null;
  state.peaks.B = null;
  const calls = [];
  globalThis.__fetchPeaksBinary = async (projectId, speaker) => {
    calls.push([projectId, speaker]);
    return { binsPerSec: 200, bins: Uint8Array.from([speaker === "A" ? 11 : 22]) };
  };
  await loadPeaks("p1", 1);
  assert.equal(state.peaks.A.bins[0], 11);
  assert.equal(state.peaks.B.bins[0], 22);
  assert.deepEqual(calls.map(([, sp]) => sp).sort(), ["A", "B"]);
  assert.ok(calls.every(([id]) => id === "p1"));
});

test("loadPeaks: epoch不一致の応答は破棄", async () => {
  state.projectEpoch = 5;
  state.peaks.A = null;
  state.peaks.B = null;
  globalThis.__fetchPeaksBinary = async () => ({ binsPerSec: 200, bins: Uint8Array.from([7]) });
  await loadPeaks("p1", 4); // 旧世代epochで呼ばれたことにする
  assert.equal(state.peaks.A, null);
  assert.equal(state.peaks.B, null);
});

test("loadPeaks: fetch失敗（404等）は throw せず null のまま", async () => {
  state.projectEpoch = 9;
  state.peaks.A = null;
  state.peaks.B = null;
  globalThis.__fetchPeaksBinary = async () => {
    throw new Error("404 peaks not found");
  };
  await loadPeaks("p1", 9); // reject しないことが要件
  assert.equal(state.peaks.A, null);
  assert.equal(state.peaks.B, null);
});

// ── waveform 純関数部 ───────────────────────────────────

test("chooseRulerStep: px/step >= 80 を満たす最小ステップ", () => {
  assert.equal(chooseRulerStep(260), 0.5); // 0.1*260=26 < 80, 0.5*260=130 >= 80
  assert.equal(chooseRulerStep(80), 1);
  assert.equal(chooseRulerStep(20), 5);    // 最小ズーム
  assert.equal(chooseRulerStep(1000), 0.1);
  // Issue #21 で 1800/3600 を追加したため、フォールバック先は 600 → 3600 に変わった
  assert.equal(chooseRulerStep(0.01), 3600); // どれも満たさない → 最大にフォールバック
});

test("chooseRulerStep: 俯瞰ズーム域（#21 で追加した 1800/3600）", () => {
  // 90分エピソードを1400pxにフィット: z = 1400/5410 ≈ 0.2588 → 600*0.2588 ≈ 155 >= 80
  assert.equal(chooseRulerStep(1400 / 5410), 600);
  assert.equal(chooseRulerStep(0.05), 1800); // 600*0.05=30 < 80, 1800*0.05=90 >= 80
  assert.equal(chooseRulerStep(0.03), 3600); // 1800*0.03=54 < 80, 3600*0.03=108 >= 80
});

test("computeFitZoom: ビューポート幅 ÷（timelineEnd + 末尾余白）", () => {
  // 90分（5400s）+ TAIL 10s を 1400px に収める
  assert.ok(Math.abs(computeFitZoom(5400, 1400) - 1400 / 5410) < 1e-12);
  // フィット時 contentWidth = (end + tail) * z がちょうどビューポート幅になる
  assert.ok(Math.abs((5400 + 10) * computeFitZoom(5400, 1400) - 1400) < 1e-9);
  // tail 明示指定
  assert.equal(computeFitZoom(90, 100, 10), 1);
});

test("computeFitZoom: ZOOM_MIN(20) では切らない（俯瞰の特例域）", () => {
  const z = computeFitZoom(5400, 1400);
  assert.ok(z > 0 && z < 20);
});

test("computeFitZoom: 境界（ゼロ長タイムライン・極端に広いビューポート・不正入力）", () => {
  // ゼロ長タイムライン: 末尾余白のみにフィット（1400/10 = 140）
  assert.equal(computeFitZoom(0, 1400), 140);
  // 極端に広いビューポートでも ZOOM_MAX(260) を超えない
  assert.equal(computeFitZoom(0, 1e7), 260);
  assert.equal(computeFitZoom(10, 1e9), 260);
  // 不正入力は ZOOM_MIN(20) に落とす
  assert.equal(computeFitZoom(0, 0), 20);
  assert.equal(computeFitZoom(0, -100), 20);
  assert.equal(computeFitZoom(NaN, NaN), 20);
  assert.equal(computeFitZoom(0, 100, 0), 20); // end=0 かつ tail=0 → total 0
  // 負の timelineEnd は 0 扱い
  assert.equal(computeFitZoom(-50, 1400), 140);
});

// ── フィットトグル（#21 実機FB: 「全体」で元のズームへ戻る） ──

test("resolveRestoreZoom: 記憶値は 20..260 に clamp、無ければ既定80", () => {
  assert.equal(resolveRestoreZoom(120), 120);
  assert.equal(resolveRestoreZoom(5), 20);       // ZOOM_MIN clamp
  assert.equal(resolveRestoreZoom(1000), 260);   // ZOOM_MAX clamp
  assert.equal(resolveRestoreZoom(null), 80);
  assert.equal(resolveRestoreZoom(undefined), 80);
  assert.equal(resolveRestoreZoom(NaN), 80);
  assert.equal(resolveRestoreZoom(0), 80);
  assert.equal(resolveRestoreZoom(-3), 80);
  assert.equal(resolveRestoreZoom(null, 60), 60); // fallback 指定
});

test("computeFitToggle: 非フィット→フィット（現在ズームを記憶）", () => {
  const step = computeFitToggle({ active: false, restoreZoom: null }, 140);
  assert.equal(step.mode, "fit");
  assert.deepEqual(step.next, { active: true, restoreZoom: 140 });
});

test("computeFitToggle: フィット→復帰（記憶値へ。記憶なしは既定80）", () => {
  const remembered = computeFitToggle({ active: true, restoreZoom: 140 }, 3);
  assert.equal(remembered.mode, "restore");
  assert.equal(remembered.targetZoom, 140);
  assert.deepEqual(remembered.next, { active: false, restoreZoom: null });
  const fallback = computeFitToggle({ active: true, restoreZoom: null }, 3);
  assert.equal(fallback.mode, "restore");
  assert.equal(fallback.targetZoom, 80);
});

test("setZoom: 通常ズーム操作でフィット状態を解除（#21）", () => {
  fitState.active = true;
  fitState.restoreZoom = 140;
  const prevZoom = state.zoom;
  state.zoom = 3;              // フィット中の俯瞰ズーム相当
  setZoom(100);                // DOM無し経路: state.zoom 更新 + zoom-changed のみ
  assert.equal(state.zoom, 100);
  assert.equal(fitState.active, false);
  assert.equal(fitState.restoreZoom, null);
  resetFitState();
  state.zoom = prevZoom;       // 後続テストへ汚染を残さない
});

test("exitFitState: フィット中は記憶ズームへ復帰して解除（project-set の残留防止・QA #40）", () => {
  fitState.active = true;
  fitState.restoreZoom = 140;
  const prevZoom = state.zoom;
  state.zoom = 0.3;            // フィット中の俯瞰ズーム相当（ZOOM_MIN 未満）
  exitFitState();
  assert.equal(state.zoom, 140);          // 特例倍率を次プロジェクトに残さない
  assert.equal(fitState.active, false);
  assert.equal(fitState.restoreZoom, null);
  exitFitState();                          // 非フィット時は no-op（ズームを触らない）
  assert.equal(state.zoom, 140);
  resetFitState();
  state.zoom = prevZoom;       // 後続テストへ汚染を残さない
});

test("COLORS: パレットを1箇所に集約（契約 §2-3。Issue #59 パレット一元化の値。既定=light）", () => {
  assert.equal(COLORS.A.peak, "#107c72");   // was #1a9384（白背景 3.78 → 5.06 で AA 通過）
  assert.equal(COLORS.A.text, "#0b6a60");   // was #0b6e63（= --spk-a）
  assert.equal(COLORS.B.peak, "#9e5d0e");   // was #c68a2e（白背景 2.97 → 5.22 で AA 通過）
  assert.equal(COLORS.B.text, "#8a5310");   // was #8f5a0c（= --spk-b）
  assert.equal(COLORS.overlap, "rgba(178, 58, 10, 0.14)"); // was rgba(215, 0, 21, 0.16)（= --seam-soft）
  assert.equal(COLORS.cursor, "#b23a0a");   // was #007aff。再生ヘッドは Seam（#playhead と同色）
  assert.equal(COLORS.selection, "#16181d"); // was #007aff。選択は中立の Ink（= --accent）
});

test("applyThemeColors: dark で差し替わり light で戻る（DOM無しでも安全）", () => {
  applyThemeColors("dark");
  assert.equal(COLORS.A.peak, THEME_COLORS.dark.A.peak);
  assert.equal(COLORS.cursor, "#ff7a45"); // was #0a84ff
  assert.equal(COLORS.rulerBg, THEME_COLORS.dark.rulerBg);
  applyThemeColors("unknown-theme"); // 未知テーマは light フォールバック
  assert.equal(COLORS.A.peak, THEME_COLORS.light.A.peak);
  assert.equal(COLORS.cursor, "#b23a0a"); // was #007aff
});

// ── Seam Strip の座標変換（#59 PR4） ────────────────────

test("stripPxPerSec: 帯幅 ÷（timelineEnd + 末尾余白）", () => {
  // 90分（5400s）+ TAIL 10s を 800px の帯に圧縮
  assert.ok(Math.abs(stripPxPerSec(800, 5400) - 800 / 5410) < 1e-12);
  // 圧縮後の全長がちょうど帯幅になる（= 末尾余白まで含めて収まる）
  assert.ok(Math.abs((5400 + 10) * stripPxPerSec(800, 5400) - 800) < 1e-9);
  assert.equal(stripPxPerSec(100, 90, 10), 1); // tail 明示
});

test("stripPxPerSec: 幅0・素材なし・不正入力は0（描画を早期 return させる）", () => {
  assert.equal(stripPxPerSec(0, 5400), 0);      // display:none の狭幅レイアウト
  assert.equal(stripPxPerSec(-10, 5400), 0);
  assert.equal(stripPxPerSec(800, 0, 0), 0);    // 全長0 → 0除算にしない
  assert.equal(stripPxPerSec(NaN, NaN), 0);
  // 素材なし（timelineEnd=0）でも末尾余白ぶんで割って有限値を返す
  assert.equal(stripPxPerSec(800, 0), 80);
});

test("stripBarHeight: 上限は half-1（中央ヘアラインを潰さない）", () => {
  assert.equal(stripBarHeight(1, 10), 9);
  assert.equal(stripBarHeight(0.5, 10), 4.5);
  // 少しでも話していれば最低1px は立てる（俯瞰で「ここで喋った」ことを消さない）
  assert.equal(stripBarHeight(0.001, 10), 1);
});

test("stripBarHeight: 無音は0（fillRect を呼ばせない）", () => {
  assert.equal(stripBarHeight(0, 10), 0);
  assert.equal(stripBarHeight(-1, 10), 0);
  assert.equal(stripBarHeight(NaN, 10), 0);
  assert.equal(stripBarHeight(null, 10), 0);
});

test("stripBarHeight: 密度は 0..1 に飽和させる（1を超える入力でも溢れない）", () => {
  assert.equal(stripBarHeight(1.5, 10), 9);
  assert.equal(stripBarHeight(Infinity, 10), 9); // clamp されて最大高まで
});

test("stripBarHeight: half が極小でも 1px は確保する", () => {
  assert.equal(stripBarHeight(1, 1), 1);
  assert.equal(stripBarHeight(1, 0), 1);
});

// ── 発話密度（#59 PR4。振幅ではなく密度を描く判断の担保） ──

test("computeStripDensity: 列を埋め尽くす発話は 1、半分なら 0.5", () => {
  // sz=1 → 1列=1秒
  const full = computeStripDensity([mkBlock(0, 10)], 1, 20);
  for (let c = 0; c < 10; c += 1) assert.equal(full[c], 1, `col ${c}`);
  for (let c = 10; c < 20; c += 1) assert.equal(full[c], 0, `col ${c}`);
  // 0.5秒だけ話す → その列は 0.5
  const half = computeStripDensity([mkBlock(3, 3.5)], 1, 20);
  assert.ok(Math.abs(half[3] - 0.5) < 1e-9);
  assert.equal(half[4], 0);
});

test("computeStripDensity: 圧縮された列では複数の発話が足し合わされる", () => {
  // sz=0.1 → 1列=10秒。その中に 2秒 + 2秒 + 1秒 = 5秒ぶん話す → 密度 0.5
  const blocks = [mkBlock(0, 2), mkBlock(3, 5), mkBlock(6, 7)];
  const cols = computeStripDensity(blocks, 0.1, 10);
  assert.ok(Math.abs(cols[0] - 0.5) < 1e-9, `${cols[0]}`);
  // 会話が詰まっている列と疎な列で値が違う = 階調が出るということ
  const dense = computeStripDensity([mkBlock(0, 9)], 0.1, 10);
  assert.ok(dense[0] > cols[0]);
});

test("computeStripDensity: 実素材の圧縮率で中間階調が残る（振幅版が飽和したのに対して）", () => {
  // 90分・平均6秒の発話が12秒間隔（= 密度 0.5 相当）を 830px へ
  const sz = stripPxPerSec(830, 5400);
  const blocks = [];
  for (let t = 0; t + 6 < 5400; t += 12) blocks.push(mkBlock(t, t + 6));
  const cols = computeStripDensity(blocks, sz, 830);
  let saturated = 0;
  let silent = 0;
  for (const v of cols) {
    if (v >= 0.999) saturated += 1;
    if (v <= 0.001) silent += 1;
  }
  // 振幅版は 99.9% が飽和した。密度版は中間階調が支配的であることが要件
  assert.ok(saturated / 830 < 0.1, `飽和 ${(saturated / 830 * 100).toFixed(1)}% < 10%`);
  assert.ok((830 - saturated - silent) / 830 > 0.8, "中間階調が 80% 超");
});

test("computeStripDensity: 帯をまたぐ発話は帯内へクリップし、外は捨てる", () => {
  // 左を跨ぐ
  const left = computeStripDensity([mkBlock(-5, 2)], 1, 10);
  assert.equal(left[0], 1);
  assert.equal(left[2], 0);
  // 完全に外側
  const outside = computeStripDensity([mkBlock(50, 60)], 1, 10);
  assert.ok(outside.every((v) => v === 0));
});

test("computeStripDensity: 空・不正入力は全0の配列（例外にしない）", () => {
  assert.equal(computeStripDensity(null, 1, 5).length, 5);
  assert.ok(computeStripDensity(null, 1, 5).every((v) => v === 0));
  assert.ok(computeStripDensity([], 1, 5).every((v) => v === 0));
  assert.equal(computeStripDensity([mkBlock(0, 1)], 0, 5).length, 5);   // sz 0
  assert.equal(computeStripDensity([mkBlock(0, 1)], 1, 0).length, 0);   // 幅0
  // ゼロ長・start が数値でないブロックは個別にスキップ
  const mixed = computeStripDensity(
    [mkBlock(0, 0), { start: "x", source_start: 0, source_end: 1 }, mkBlock(2, 3)], 1, 5,
  );
  assert.equal(mixed[0], 0);
  assert.equal(mixed[2], 1);
});

test("computeStripDensity: peaks に依存しない（未着でも帯が完成形で出る）", () => {
  // 引数にピークが一切登場しないこと自体が要件。ブロックだけで階調が出る
  const cols = computeStripDensity([mkBlock(0, 5), mkBlock(7, 8)], 0.1, 2);
  assert.ok(cols[0] > 0 && cols[0] < 1);
});

test("computeStripWindow: scrollLeft/zoom の表示範囲を帯の x 区間へ写す", () => {
  const sz = stripPxPerSec(800, 5400);          // ≈ 0.14787 px/s
  // ズーム1、幅1400px → 1400秒 = 207px（最低幅より広いので素の値がそのまま出る）
  const win = computeStripWindow(0, 1400, 1, sz, 800);
  assert.equal(win.x0, 0);
  assert.ok(Math.abs(win.x1 - (1400 / 1) * sz) < 1e-9);
  // スクロールすると窓が動く（幅は変わらない）
  const scrolled = computeStripWindow(1 * 600, 1400, 1, sz, 800);
  assert.ok(Math.abs(scrolled.x0 - 600 * sz) < 1e-9);
  assert.ok(Math.abs((scrolled.x1 - scrolled.x0) - (win.x1 - win.x0)) < 1e-9);
});

test("computeStripWindow: 素の窓が細すぎるときは最低幅まで広げる（中心を保つ）", () => {
  // 既定ズーム80・90分素材の素の窓は 2.7px。そのままでは見えないので 12px へ広げる
  const sz = stripPxPerSec(800, 5400);
  const raw = (1400 / 80) * sz;
  assert.ok(raw < 12, `素の窓 ${raw.toFixed(2)}px は最低幅未満`);
  const win = computeStripWindow(80 * 1800, 1400, 80, sz, 800);
  assert.equal(win.x1 - win.x0, 12);
  // 広げても中心は素の窓の中心のまま（位置は正しく、幅だけ概念的に太らせる）
  const rawCenter = (1800 + 1400 / 80 / 2) * sz;
  assert.ok(Math.abs((win.x0 + win.x1) / 2 - rawCenter) < 1e-9);
});

test("computeStripWindow: ズームインで窓が狭まり、フィットで帯全体（full）になる", () => {
  const sz = stripPxPerSec(800, 5400);
  const wide = computeStripWindow(0, 1400, 1, sz, 800);
  const tight = computeStripWindow(0, 1400, 5, sz, 800);
  assert.ok(tight.x1 - tight.x0 < wide.x1 - wide.x0);
  // フィット表示中（z = computeFitZoom）は窓が帯いっぱい → full=true で枠を描かない
  const fit = computeStripWindow(0, 1400, computeFitZoom(5400, 1400), sz, 800);
  assert.equal(fit.x0, 0);
  assert.equal(fit.x1, 800);
  assert.equal(fit.full, true);
  assert.equal(wide.full, false);
});

test("computeStripWindow: 端でも帯の内側に収まる（外へ逃げない）", () => {
  const sz = stripPxPerSec(800, 5400);
  // 末尾までスクロール: 最低幅ぶん内側へ押し戻される
  const tail = computeStripWindow(80 * 5400, 1400, 80, sz, 800);
  assert.ok(tail.x1 <= 800 + 1e-9, `${tail.x1}`);
  assert.ok(tail.x0 >= 0);
  assert.equal(tail.x1 - tail.x0, 12);
  // 先頭: 左端に張り付き、負にならない
  const head = computeStripWindow(0, 1400, 80, sz, 800);
  assert.equal(head.x0, 0);
  assert.equal(head.x1, 12);
  // clientWidth 0 でも最低幅は残る = 窓が消えない
  assert.equal(computeStripWindow(0, 0, 80, sz, 800).x1 - computeStripWindow(0, 0, 80, sz, 800).x0, 12);
});

test("computeStripWindow: 帯が最低幅より狭ければ帯幅いっぱい（min-width 120px 未満の保険）", () => {
  const sz = stripPxPerSec(8, 5400);
  const win = computeStripWindow(80 * 1800, 1400, 80, sz, 8);
  assert.equal(win.x0, 0);
  assert.equal(win.x1, 8);
  assert.equal(win.full, true);
});

test("computeStripWindow: 描画できない条件では null（呼び出し側で分岐）", () => {
  const sz = stripPxPerSec(800, 5400);
  assert.equal(computeStripWindow(0, 1400, 0, sz, 800), null);   // zoom 0
  assert.equal(computeStripWindow(0, 1400, 80, 0, 800), null);   // sz 0（素材なし）
  assert.equal(computeStripWindow(0, 1400, 80, sz, 0), null);    // 幅0（狭幅で畳んだ）
  assert.equal(computeStripWindow(0, 1400, NaN, sz, 800), null);
});

test("stripXToTime: 帯 x → 時刻。stripPxPerSec の逆写像になっている", () => {
  const sz = stripPxPerSec(800, 5400);
  assert.ok(Math.abs(stripXToTime(400, sz, 5400) - 400 / sz) < 1e-9);
  // 往復して元に戻る（クリック位置と飛び先が一致する保証）
  for (const t of [0, 1.5, 900, 5399.5]) {
    assert.ok(Math.abs(stripXToTime(t * sz, sz, 5400) - t) < 1e-6);
  }
});

test("stripXToTime: 帯の外・末尾余白は端に丸める（負の時刻へ飛ばさない）", () => {
  const sz = stripPxPerSec(800, 5400);
  assert.equal(stripXToTime(-50, sz, 5400), 0);
  // 末尾余白（timelineEnd 以降）を掴んだら timelineEnd で止める
  assert.equal(stripXToTime(800, sz, 5400), 5400);
  assert.equal(stripXToTime(1e6, sz, 5400), 5400);
  assert.equal(stripXToTime(100, 0, 5400), 0);     // sz 0 は 0
  assert.equal(stripXToTime(NaN, sz, 5400), 0);
});

// ── 被り位置の圧縮（#59 PR4） ───────────────────────────

test("compressStripMarks: 離れた被りはそれぞれ縦線になる", () => {
  const sz = 1; // 1px/s で読みやすく
  const marks = compressStripMarks([
    { start: 10, end: 12 },
    { start: 100, end: 103 },
  ], sz, 800);
  assert.deepEqual(marks, [{ x: 10, w: 2 }, { x: 100, w: 3 }]);
});

test("compressStripMarks: 重複・接触は1本に畳む（α飽和と無駄な描画命令を防ぐ）", () => {
  const sz = 1;
  // 重なる2本 + 端が接する1本 → すべて1本
  const marks = compressStripMarks([
    { start: 10, end: 15 },
    { start: 12, end: 20 },
    { start: 20, end: 22 },
  ], sz, 800);
  assert.deepEqual(marks, [{ x: 10, w: 12 }]);
});

test("compressStripMarks: 入力順に依存しない（start でソートしてから畳む）", () => {
  const regions = [
    { start: 100, end: 103 },
    { start: 10, end: 15 },
    { start: 12, end: 20 },
  ];
  const forward = compressStripMarks(regions, 1, 800);
  const reversed = compressStripMarks(regions.slice().reverse(), 1, 800);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward, [{ x: 10, w: 10 }, { x: 100, w: 3 }]);
});

test("compressStripMarks: 俯瞰圧縮で消えないよう最低1px（drawTrack の MIN_CLIP_PX と同じ思想）", () => {
  // 90分素材を800pxへ: 0.3秒の被りは 0.044px = 1px 未満
  const sz = stripPxPerSec(800, 5400);
  const marks = compressStripMarks([{ start: 1000, end: 1000.3 }], sz, 800);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].w, 1);
  assert.ok(Math.abs(marks[0].x - 1000 * sz) < 1e-9);
  // ゼロ幅も消さない
  assert.equal(compressStripMarks([{ start: 500, end: 500 }], sz, 800)[0].w, 1);
});

test("compressStripMarks: 帯の外は捨て、跨ぐものは帯内へクリップ", () => {
  const marks = compressStripMarks([
    { start: -20, end: -10 },   // 完全に左外 → 捨てる
    { start: -5, end: 5 },      // 左を跨ぐ → 0..5
    { start: 795, end: 810 },   // 右を跨ぐ → 795..800
    { start: 900, end: 910 },   // 完全に右外 → 捨てる
  ], 1, 800);
  assert.deepEqual(marks, [{ x: 0, w: 5 }, { x: 795, w: 5 }]);
});

test("compressStripMarks: 被りが数百本でも描画命令は帯の列数以下に収まる", () => {
  // 90分に 600本の被り（実素材の上限相当）を 800px へ圧縮。
  // 会話の被りは「話が重なった数十秒」に固まるので、密集帯を模して並べる。
  const sz = stripPxPerSec(800, 5400);
  const regions = [];
  for (let i = 0; i < 600; i += 1) {
    const cluster = Math.floor(i / 40) * 600;   // 15箇所のクラスタ
    regions.push({ start: cluster + (i % 40) * 0.8, end: cluster + (i % 40) * 0.8 + 0.5 });
  }
  const marks = compressStripMarks(regions, sz, 800);
  assert.ok(marks.length <= 800, `${marks.length} <= 800`);
  // 密集ぶんは1本に畳まれる（600本 → クラスタ数程度）
  assert.ok(marks.length <= 20, `${marks.length} <= 20`);
  // 畳んだ矩形は互いに重ならない（= 同じピクセルを二度塗らない → α が飽和しない）
  for (let i = 1; i < marks.length; i += 1) {
    assert.ok(marks[i].x >= marks[i - 1].x + marks[i - 1].w, "重なりが残っていない");
  }
});

test("compressStripMarks: 均等にばらけた被りは畳まれず本数として読める", () => {
  // クラスタしていない場合は「立っている縦線の本数」がそのまま被りの多さを示す。
  // 圧縮で1本に融合してしまうと数の情報が消えるので、畳みすぎないことも要件。
  const sz = stripPxPerSec(800, 5400);
  const regions = [];
  for (let i = 0; i < 60; i += 1) regions.push({ start: i * 88, end: i * 88 + 0.5 });
  const marks = compressStripMarks(regions, sz, 800);
  assert.equal(marks.length, 60);
});

test("compressStripMarks: 空・不正入力は空配列（overlaps 未算出のプロジェクト）", () => {
  assert.deepEqual(compressStripMarks(null, 1, 800), []);
  assert.deepEqual(compressStripMarks([], 1, 800), []);
  assert.deepEqual(compressStripMarks([{ start: 1, end: 2 }], 0, 800), []);
  assert.deepEqual(compressStripMarks([{ start: 1, end: 2 }], 1, 0), []);
  // start/end が数値でない要素は個別にスキップし、残りは描く
  assert.deepEqual(
    compressStripMarks([{ start: "x", end: 2 }, {}, null, { start: 10, end: 11 }], 1, 800),
    [{ x: 10, w: 1 }],
  );
});

// ── キャッシュ破棄の条件（#59 PR4） ─────────────────────

test("stripCacheSignature: 素材・編集・幅・DPR で変わる", () => {
  const base = stripCacheSignature("p1", 3, 800, 2);
  assert.equal(base, stripCacheSignature("p1", 3, 800, 2));       // 同条件は同じ
  assert.notEqual(base, stripCacheSignature("p2", 3, 800, 2));    // プロジェクト切替
  assert.notEqual(base, stripCacheSignature("p1", 4, 800, 2));    // 編集
  assert.notEqual(base, stripCacheSignature("p1", 3, 801, 2));    // リサイズ
  assert.notEqual(base, stripCacheSignature("p1", 3, 800, 1));    // DPR 変化
});

test("stripCacheSignature: スクロール・ズーム・再生位置では変わらない（60fps の要）", () => {
  // 署名に入っていない = 窓とヘッドの更新でキャッシュが捨てられないことの担保。
  // ここが崩れると再生中に毎フレーム全ブロックの密度走査が走る。
  const sig = stripCacheSignature("p1", 3, 800, 2);
  assert.deepEqual(sig.split("|"), ["p1", "3", "800", "2"]);
});

test("stripCacheSignature: peaks の到着では変わらない（帯は密度で描くので無関係）", () => {
  // 引数に peaks 相当が無いこと自体が要件。余分な引数を渡しても署名は変わらない
  assert.equal(stripCacheSignature("p1", 3, 800, 2, true), stripCacheSignature("p1", 3, 800, 2));
});

test("stripCacheSignature: 幅は丸めて比較（サブピクセルの揺れで捨てない）", () => {
  assert.equal(
    stripCacheSignature("p1", 0, 800.2, 2),
    stripCacheSignature("p1", 0, 799.8, 2),
  );
});

test("stripCacheSignature: 未取込（id/version なし）でも例外にならない", () => {
  assert.equal(stripCacheSignature(null, undefined, 0, 1), "|-1|0|1");
});

// ── 帯の縦の配分（#59 PR4。継ぎ目チャンネルを空ける設計の担保） ──

test("stripBarHeight: 既定の上限は 7px（中央 6px の継ぎ目チャンネルを侵さない）", () => {
  // 密度が最大でもバーは 7px までしか伸びない。20px = 7(A) + 6(継ぎ目) + 7(B)。
  // ここが崩れると被りの縦線が密度バーに重なり、Seam 色と B 色の
  // コントラスト比 1.15 のせいで線が見えなくなる（この節冒頭の実測）。
  assert.equal(stripBarHeight(1), 7);
  assert.equal(stripBarHeight(0.5), 3.5);
  assert.equal(stripBarHeight(0.001), 1);
  assert.equal(stripBarHeight(0), 0);
});

test("stripBarHeight: A/B のバーと継ぎ目チャンネルが 20px にちょうど収まる", () => {
  const SEAM_TOP = 7;
  const SEAM_BOTTOM = 13;
  const maxBar = stripBarHeight(1);
  // A は SEAM_TOP から上へ、B は SEAM_BOTTOM から下へ伸びる
  assert.equal(SEAM_TOP - maxBar, 0, "A の最大バーが帯の上端で止まる");
  assert.equal(SEAM_BOTTOM + maxBar, 20, "B の最大バーが帯の下端で止まる");
  assert.equal(SEAM_BOTTOM - SEAM_TOP, 6, "継ぎ目チャンネルは 6px");
});
