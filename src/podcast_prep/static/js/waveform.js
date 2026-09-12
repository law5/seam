// waveform.js — タイムラインの描画と座標変換のみを担う。
// 契約: player / interactions は import しない（描画は一方向依存に保つ）。
// playhead 位置は playhead-tick イベント経由で setPlayheadTime が受け取り、
// ポインタ操作は interactions が xToTime/hitTest を使って外付けする。
// モジュールトップで DOM に触らない（initWaveform まで副作用なし = node でテスト可能）。
// #59 PR4: transport 中央の Seam Strip もここが描く（座標系とパレットを共有できるため）。
// 既存の drawTrack / drawRuler / applyZoom には触っていない — 帯は独立した
// rAF（stripRafId）とオフスクリーンキャッシュを持つ。
import { state, emit, on } from "./state.js";
import { clamp, fmtMs, blockDuration } from "./utils.js";
import { getIndex, visibleBlocks, findBlockAt } from "./timelineModel.js";
import { peakMaxIn } from "./peaks.js";

// 描画色の一元管理（契約 §2 / §2-3。HIG刷新でテーマ別定数に改訂 2026-08、
// Issue #59 でパレット一元化）。
// CSS 変数（styles.css :root / ダーク上書き）と対応する:
//   A.text=--spk-a / A.clip=--spk-a-soft / B.text=--spk-b / B.clip=--spk-b-soft
//   overlap=--seam-soft / cursor=--seam（#playhead と同色）/ selection=--accent
//   rulerBg=--content-bg-2 / rulerText,loadingText=--secondary-label
// ※ A.peak / B.peak は --spk-* より意図的に1段明るい（clip→peak→text の3層を
//    分離するため）。CSS と不一致に見えるが仕様。揃えないこと。
// ※ previewGap / previewOverlap / flash に対応する CSS 変数は無い（canvas 専用）。
// 色を変えるときは必ず styles.css と同時に直す。対応の機械検証は
// tests/js/palette.consistency.test.mjs にある（ズレたら落ちる）。
// 切替は applyThemeColors(theme)（main が prefers-color-scheme を購読して呼ぶ）。
// getComputedStyle は使わない — 描画ホットパスはオブジェクト参照のみで
// テーマ切替時に一括 Object.assign する（canvas 性能予算の維持）。
export const THEME_COLORS = {
  light: {
    A: { clip: "rgba(11, 106, 96, 0.14)", peak: "#107c72", text: "#0b6a60" },
    B: { clip: "rgba(138, 83, 16, 0.14)", peak: "#9e5d0e", text: "#8a5310" },
    overlap: "rgba(178, 58, 10, 0.14)",
    cursor: "#b23a0a",
    selection: "#16181d",
    previewGap: "rgba(22, 24, 29, 0.7)",         // Ink ハッチ（無音詰めプレビュー）
    previewGapBase: "rgba(22, 24, 29, 0.08)",
    previewOverlap: "rgba(178, 58, 10, 0.85)",   // Seam ハッチ（被り解消プレビュー）
    previewOverlapBase: "rgba(178, 58, 10, 0.10)",
    flash: "rgba(250, 204, 21, 0.35)",
    rulerBg: "#f4f3f0",
    rulerLine: "#d9d7d1",
    rulerText: "#5b6069",
    hairline: "#e4e2dc",
    loadingText: "#5b6069",
  },
  dark: {
    A: { clip: "rgba(79, 201, 184, 0.16)", peak: "#45bfae", text: "#4fc9b8" },
    B: { clip: "rgba(232, 169, 79, 0.16)", peak: "#dc9e45", text: "#e8a94f" },
    overlap: "rgba(255, 122, 69, 0.18)",
    cursor: "#ff7a45",
    selection: "#e8e6e1",
    previewGap: "rgba(232, 230, 225, 0.75)",
    previewGapBase: "rgba(232, 230, 225, 0.10)",
    previewOverlap: "rgba(255, 122, 69, 0.9)",
    previewOverlapBase: "rgba(255, 122, 69, 0.12)",
    flash: "rgba(255, 214, 10, 0.26)",
    rulerBg: "#23262c",
    rulerLine: "#3a3e45",
    rulerText: "#9aa0a9",
    hairline: "#2e3138",
    loadingText: "#9aa0a9",
  },
};

// 描画コードが参照する現行パレット（既定=light）。消費側の形は従来どおり
// COLORS.A.peak 等（1箇所集約の契約は維持。中身がテーマで差し替わる）。
export const COLORS = { ...THEME_COLORS.light };

// テーマ切替: COLORS を差し替え、キャッシュ済みハッチパターンを破棄して再描画。
// node（DOM無し）でも安全に呼べる（els 未初期化なら再描画のみスキップ）。
export function applyThemeColors(theme) {
  const next = THEME_COLORS[theme] ? theme : "light";
  Object.assign(COLORS, THEME_COLORS[next]);
  hatchGap = null;
  hatchOverlap = null;
  if (els) {
    invalidate();
    invalidateStrip(true);          // Seam Strip のキャッシュも捨てる（古い色が残る）
  }
}

const RULER_H = 24;
const TRACK_H = 150;
const CLIP_PAD_Y = 10;
const CLIP_RADIUS = 4;
const MIN_CLIP_PX = 2;              // 幅<2pxでも消さない（WYSIWYG）
const ZOOM_MIN = 20;
const ZOOM_MAX = 260;
const TICK_STEPS = [0.1, 0.5, 1, 5, 10, 30, 60, 300, 600, 1800, 3600];
const MIN_TICK_PX = 80;
const FOLLOW_SUPPRESS_MS = 1500;    // 手動スクロール後の再生追従抑止
const TAIL_SECONDS = 10;            // コンテンツ幅の末尾余白

// Seam Strip（#59 PR4）: transport 中央にエピソード全体を圧縮した帯。
// 上が A / 下が B で、A と B には同じ 7px を割り当てる（A/B は対称なので
// 話者ごとに配分を変えない）。中央に両者共通の「継ぎ目チャンネル」を挟む。
const STRIP_H = 20;
const STRIP_RADIUS = 4;
// 帯の縦の配分。中央に継ぎ目チャンネルを空け、そこだけに被りの縦線を立てる。
// Seam 色は Speaker B の色とコントラスト比 1.15 しかないため、B の密度バーに
// 重ねると線が消える（詳細は buildStripCache のコメント）。地色の上なら 5.40 出る。
//   0..6    Speaker A の密度バー（中央へ向かって 7px まで）
//   7..12   継ぎ目チャンネル 6px（上下 1px は境界のヘアライン、内側 4px に被りの線）
//   13..19  Speaker B の密度バー（中央へ向かって 7px まで）
const STRIP_SEAM_H = 6;
const STRIP_SEAM_TOP = Math.round((STRIP_H - STRIP_SEAM_H) / 2);      // 7
const STRIP_SEAM_BOTTOM = STRIP_SEAM_TOP + STRIP_SEAM_H;              // 13
const STRIP_BAR_MAX = STRIP_SEAM_TOP;                                 // 片側 7px
const STRIP_MIN_MARK_PX = 1;        // 被りが俯瞰圧縮で消えない最低幅
const STRIP_HEAD_W = 1.5;           // 再生ヘッドの線幅
// 窓の最低表示幅。素の窓は既定ズーム80・90分で 2.7px しかないため、
// 「今どこを見ているか」が読める幅まで広げて描く（位置は正しく、幅は概念的）。
const STRIP_WINDOW_MIN_W = 12;

let els = null;
let ctxRuler = null;
let ctxA = null;
let ctxB = null;
let dpr = 1;
let rafId = 0;
let contentWidth = 0;
let playheadTime = 0;
let dragOverride = null;            // DragOverride | null
let previewRegions = null;          // PreviewRegions | null
let flash = null;                   // {speaker|null, start, end} | null
let flashTimer = 0;
let lastManualScrollAt = -Infinity;
let expectedScrollLeft = null;      // プログラマティックスクロールの識別
let resizeObserver = null;
let dprQuery = null;
let hatchGap = null;
let hatchOverlap = null;

// Seam Strip の状態。stripCache は「波形+被り」= playhead/窓で変わらない層の
// オフスクリーン1枚（再生中 60fps でも drawImage 1回で済ませるため）。
let ctxStrip = null;
let stripW = 0;                     // CSS px（transport の flex 幅）
let stripCache = null;              // HTMLCanvasElement | null
let stripCacheKey = null;           // キャッシュが有効な条件のシグネチャ
let stripRafId = 0;
let stripObserver = null;

// ── 初期化 ──────────────────────────────────────────────

export function initWaveform(elements) {
  els = elements;
  ctxRuler = els.ruler.getContext("2d");
  ctxA = els.canvasA.getContext("2d");
  ctxB = els.canvasB.getContext("2d");
  els.scroll.addEventListener("scroll", onScroll);
  els.scroll.addEventListener("wheel", onWheel, { passive: false });
  // プロジェクト切替でフィット状態を持ち越さない（前プロジェクトのフィット倍率は無意味）。
  // フラグを折るだけだと ZOOM_MIN 未満の特例倍率が次プロジェクトに残留する（QA #40 指摘:
  // スライダーは min クランプで 20 を表示し実態と乖離）ため、通常域へ復帰させてから折る。
  on("project-set", exitFitState);
  resizeObserver = new ResizeObserver(() => {
    syncCanvasSize();
    layout();
  });
  resizeObserver.observe(els.scroll);
  watchDpr();
  syncCanvasSize();
  initSeamStrip();                  // 幅の正が別要素なので専用の ResizeObserver を持つ
  layout();
}

function onScroll() {
  if (expectedScrollLeft !== null && Math.abs(els.scroll.scrollLeft - expectedScrollLeft) < 2) {
    expectedScrollLeft = null;      // プログラマティック: 手動扱いしない
  } else {
    expectedScrollLeft = null;
    lastManualScrollAt = performance.now();
  }
  if (dragOverride) updateDragReadout();
  invalidate();
  invalidateStrip();                // 窓だけ動く（波形キャッシュは触らない）
}

// Ctrl/⌘ + wheel = カーソル位置アンカーのズーム（§5.1）。通常ホイールはネイティブスクロール。
function onWheel(event) {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const factor = Math.exp(-event.deltaY * 0.0015);
  setZoom(state.zoom * factor, xToTime(event.clientX));
}

function syncCanvasSize() {
  if (!els) return;
  dpr = window.devicePixelRatio || 1;
  const viewW = Math.max(1, els.scroll.clientWidth);
  const targets = [
    [els.ruler, ctxRuler, RULER_H],
    [els.canvasA, ctxA, TRACK_H],
    [els.canvasB, ctxB, TRACK_H],
  ];
  for (const [canvas, ctx, cssH] of targets) {
    canvas.style.width = `${viewW}px`;
    canvas.width = Math.max(1, Math.round(viewW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function watchDpr() {
  if (dprQuery) dprQuery.removeEventListener("change", onDprChange);
  dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  dprQuery.addEventListener("change", onDprChange);
}

function onDprChange() {
  watchDpr();                       // 新しい DPR で再登録
  syncCanvasSize();
  syncStripSize();
  invalidate();
  invalidateStrip(true);            // バックストアの解像度が変わる = キャッシュも作り直し
}

// ── レイアウト / 再描画 ─────────────────────────────────

// contentWidth 再計算。project-set / blocks-changed / zoom-changed 時に main が呼ぶ。
export function layout() {
  if (!els) return;
  const z = state.zoom;
  const end = state.project ? getIndex(state.project, state.editVersion).timelineEnd : 0;
  contentWidth = Math.max((end + TAIL_SECONDS) * z, els.scroll.clientWidth);
  els.content.style.width = `${Math.round(contentWidth)}px`;
  positionPlayhead();
  invalidate();
  // layout() は project-set / blocks-changed / zoom-changed / リサイズで呼ばれる。
  // full は渡さない: 素材・編集・幅・DPR の変化は stripCacheSignature が拾うので、
  // ここで無条件に捨てるとズーム操作のたびに全ブロックの密度走査が走ってしまう。
  invalidateStrip();
}

// rAF 合流の全可視再描画。scroll/zoom/blocks/selection すべてここに集約。
export function invalidate() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    drawAll();
  });
}

function drawAll() {
  if (!els) return;
  const z = state.zoom;
  const scrollLeft = els.scroll.scrollLeft;
  const viewW = els.scroll.clientWidth;
  const t0 = scrollLeft / z;
  const t1 = (scrollLeft + viewW) / z;
  drawRuler(t0, t1, z, scrollLeft, viewW);
  drawTrack("A", ctxA, t0, t1, z, scrollLeft, viewW);
  drawTrack("B", ctxB, t0, t1, z, scrollLeft, viewW);
  positionPlayhead();
}

// ── ルーラー ────────────────────────────────────────────

// 「px/step >= 80」を満たす最小の目盛りステップ（テスト対象の純関数）
export function chooseRulerStep(pxPerSec) {
  for (const step of TICK_STEPS) {
    if (step * pxPerSec >= MIN_TICK_PX) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1];
}

function formatTick(seconds, step) {
  const t = Math.max(0, Math.round(seconds * 10) / 10);
  const whole = Math.floor(t);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  let out = h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
  if (step < 1) out += `.${Math.round((t - whole) * 10)}`;
  return out;
}

function drawRuler(t0, t1, z, scrollLeft, viewW) {
  const ctx = ctxRuler;
  ctx.clearRect(0, 0, viewW, RULER_H);
  ctx.fillStyle = COLORS.rulerBg;
  ctx.fillRect(0, 0, viewW, RULER_H);
  ctx.fillStyle = COLORS.rulerLine;
  ctx.fillRect(0, RULER_H - 1, viewW, 1);
  const step = chooseRulerStep(z);
  const first = Math.max(0, Math.floor(t0 / step) * step);
  ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "top";
  for (let i = 0; ; i += 1) {
    const t = first + i * step;
    if (t > t1) break;
    const x = Math.round(t * z - scrollLeft);
    ctx.fillStyle = COLORS.rulerLine;
    ctx.fillRect(x, RULER_H - 7, 1, 6);
    ctx.fillStyle = COLORS.rulerText;
    ctx.fillText(formatTick(t, step), x + 3, 4);
  }
}

// ── トラック描画 ────────────────────────────────────────

function effectiveStart(block, speaker) {
  if (!dragOverride) return block.start;
  if (dragOverride.type === "block" && dragOverride.blockId === block.id) {
    return dragOverride.tempStart;
  }
  if (dragOverride.type === "offset" && dragOverride.speaker === speaker) {
    return block.start + dragOverride.delta;
  }
  return block.start;
}

function findBlockWithSpeaker(blockId) {
  if (!state.project) return null;
  const index = getIndex(state.project, state.editVersion);
  for (const speaker of ["A", "B"]) {
    const arr = index.byStart[speaker] || [];
    for (const block of arr) {
      if (block.id === blockId) return { block, speaker };
    }
  }
  return null;
}

function drawTrack(speaker, ctx, t0, t1, z, scrollLeft, viewW) {
  ctx.clearRect(0, 0, viewW, TRACK_H);
  ctx.fillStyle = COLORS.hairline;
  ctx.fillRect(0, TRACK_H - 1, viewW, 1);
  const project = state.project;
  if (!project) return;
  const index = getIndex(project, state.editVersion);

  // カリング。offsetドラッグ中は仮シフト分だけ窓をずらして可視集合を得る
  const offsetDelta =
    dragOverride && dragOverride.type === "offset" && dragOverride.speaker === speaker
      ? dragOverride.delta
      : 0;
  const blocks = visibleBlocks(index, speaker, t0 - offsetDelta, t1 - offsetDelta).slice();

  // ブロックドラッグで画面外→内に入ってくるケースを補完
  if (dragOverride && dragOverride.type === "block"
      && !blocks.some((b) => b.id === dragOverride.blockId)) {
    const found = findBlockWithSpeaker(dragOverride.blockId);
    if (found && found.speaker === speaker) {
      const dur = blockDuration(found.block);
      if (dragOverride.tempStart < t1 && dragOverride.tempStart + dur > t0) {
        blocks.push(found.block);
      }
    }
  }

  const peaks = state.peaks[speaker];
  const mid = TRACK_H / 2;
  const ampMax = mid - CLIP_PAD_Y - 2;
  const clipH = TRACK_H - CLIP_PAD_Y * 2;

  for (const block of blocks) {
    const dur = blockDuration(block);
    const start = effectiveStart(block, speaker);
    const x = start * z - scrollLeft;
    const w = Math.max(MIN_CLIP_PX, dur * z);
    if (x + w < 0 || x > viewW) continue;
    const c = COLORS[speaker];

    // クリップ背景（角丸）
    ctx.fillStyle = c.clip;
    roundedRectPath(ctx, x, CLIP_PAD_Y, w, clipH, CLIP_RADIUS);
    ctx.fill();

    // ピークバー（ピクセル列ごとに区間max。ズームインで自然な階段状になる）
    if (peaks && w >= 2) {
      ctx.fillStyle = c.peak;
      const colStart = Math.max(0, Math.floor(x));
      const colEnd = Math.min(viewW, Math.ceil(x + w));
      for (let col = colStart; col < colEnd; col += 1) {
        const t = (scrollLeft + col + 0.5) / z;
        if (t < start || t >= start + dur) continue;
        const s0 = block.source_start + (t - start);
        const v = peakMaxIn(peaks, s0, s0 + 1 / z) / 255;
        if (v <= 0) continue;
        const h = Math.max(1, v * ampMax);
        ctx.fillRect(col, mid - h, 1, h * 2);
      }
    }

    // 選択アウトライン
    if (state.selectedBlockId === block.id) {
      ctx.strokeStyle = COLORS.selection;
      ctx.lineWidth = 2;
      roundedRectPath(ctx, x + 1, CLIP_PAD_Y + 1, Math.max(1, w - 2), clipH - 2, CLIP_RADIUS);
      ctx.stroke();
    }

    // テキスト（canvasテキストは不活性 = XSS無関係）
    if (w > 60 && block.text) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 2, CLIP_PAD_Y, Math.max(0, w - 4), 16);
      ctx.clip();
      ctx.fillStyle = c.text;
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.textBaseline = "top";
      const maxChars = Math.max(1, Math.floor(w / 7));
      ctx.fillText(block.text.slice(0, maxChars), x + 6, CLIP_PAD_Y + 3);
      ctx.restore();
    }
  }

  // peaks未着（404含む）: クリップ枠のみ + 「波形準備中」。到着時の invalidate は冪等
  if (!peaks && index.byStart[speaker] && index.byStart[speaker].length) {
    ctx.fillStyle = COLORS.loadingText;
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText("波形準備中", 8, 6);
  }

  // 被りハイライト（両トラックに同じ帯）。俯瞰ズームでも消えないよう最低幅 MIN_CLIP_PX
  if (project.overlaps && project.overlaps.length) {
    ctx.fillStyle = COLORS.overlap;
    for (const ov of project.overlaps) {
      if (ov.end <= t0 || ov.start >= t1) continue;
      ctx.fillRect(
        ov.start * z - scrollLeft, 0,
        Math.max(MIN_CLIP_PX, (ov.end - ov.start) * z), TRACK_H,
      );
    }
  }

  // 自動編集プレビューのハッチ（gaps=青 / overlaps=橙、両トラック）
  if (previewRegions) {
    drawRegionSet(ctx, previewRegions.gaps, t0, t1, z, scrollLeft,
      COLORS.previewGapBase, getHatch(ctx, "gap"));
    drawRegionSet(ctx, previewRegions.overlaps, t0, t1, z, scrollLeft,
      COLORS.previewOverlapBase, getHatch(ctx, "overlap"));
  }

  // flashRange（600msハイライト）。俯瞰ズームでも視認できるよう最低幅 MIN_CLIP_PX
  if (flash && (flash.speaker === null || flash.speaker === speaker)) {
    if (!(flash.end <= t0 || flash.start >= t1)) {
      ctx.fillStyle = COLORS.flash;
      ctx.fillRect(
        flash.start * z - scrollLeft, 0,
        Math.max(MIN_CLIP_PX, (flash.end - flash.start) * z), TRACK_H,
      );
    }
  }
}

// 俯瞰ズームでも消えないよう最低幅 MIN_CLIP_PX。1〜2px 幅ではハッチ模様は出ない
// （パターンタイル8pxに満たない）ため、実質 base 色のみの表示になる割り切り。
function drawRegionSet(ctx, regions, t0, t1, z, scrollLeft, baseColor, pattern) {
  if (!regions || !regions.length) return;
  for (const region of regions) {
    if (region.end <= t0 || region.start >= t1) continue;
    const x = region.start * z - scrollLeft;
    const w = Math.max(MIN_CLIP_PX, (region.end - region.start) * z);
    ctx.fillStyle = baseColor;
    ctx.fillRect(x, 0, w, TRACK_H);
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fillRect(x, 0, w, TRACK_H);
    }
  }
}

function getHatch(ctx, kind) {
  if (kind === "gap") {
    if (!hatchGap) hatchGap = makeHatch(ctx, COLORS.previewGap);
    return hatchGap;
  }
  if (!hatchOverlap) hatchOverlap = makeHatch(ctx, COLORS.previewOverlap);
  return hatchOverlap;
}

function makeHatch(ctx, color) {
  const tile = document.createElement("canvas");
  tile.width = 8;
  tile.height = 8;
  const tctx = tile.getContext("2d");
  tctx.strokeStyle = color;
  tctx.lineWidth = 1.5;
  tctx.beginPath();
  tctx.moveTo(-2, 10);
  tctx.lineTo(10, -2);
  tctx.moveTo(-2, 2);
  tctx.lineTo(2, -2);
  tctx.moveTo(6, 10);
  tctx.lineTo(10, 6);
  tctx.stroke();
  return ctx.createPattern(tile, "repeat");
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

// ── Seam Strip（#59 PR4） ───────────────────────────────
//
// transport 中央の 20px の帯にエピソード全体を圧縮して描く「指紋」。
// 座標は drawTrack から scrollLeft を落として z を sz（全体 → 帯幅）に替えただけで、
// 新しい座標概念は増えていない。
//
// ■ 上下の帯が示すのは「振幅」ではなく「発話密度」（設計仕様 6-4 からの変更）
//
// 仕様は各列を peakMaxIn の振幅で描く案だったが、実装して実素材（sample/*.wav の
// 実ピーク）で測ったところ成立しなかった。帯は1列が数秒〜数十秒に相当するため、
// 区間 max はほぼ必ず最大値を引く:
//   5分素材 / 0.37 秒/px … 全列の 96.9% が最大高
//   90分素材 / 6.5 秒/px … 全列の 99.9% が最大高
//   最小幅120px / 45 秒/px … 全列の 100% が最大高
// 結果は「上下2本の単色の矩形」で、指紋にならない。これは帯の高さ（9px）の問題では
// なく圧縮率の問題で、既存の 150px トラックでも同じ 6.5 秒/px なら 99.9% が飽和する
// （「全体」フィットのスクショで Speaker B が塊に見えるのと同じ現象）。
//
// 代わりに「その列の時間のうち、その話者が実際に話していた割合」を高さにする。
// 90分素材でも中間階調が 65〜71% の列に出て、相槌が多い話者と長く話す話者が
// 見た目で違う形になる = エピソードごとに違う「指紋」として機能する。
// 副作用として state.peaks に依存しないので、peaks 未着（404の旧プロジェクト含む）でも
// 帯が最初から意味を持つ。
//
// ■ 被りは中央の「継ぎ目チャンネル」に立てる（設計仕様 6-4 step6 からの変更）
//
// Seam 色は Speaker B の色とコントラスト比 1.15 しかない。全高の縦線にすると
// B 側の半分では線が消えてしまう。中央に 6px のチャンネルを空け、密度バーを
// そこへ食い込ませないことで、被りの線が常に地色の上に乗る（実測 5.40 / 5.86）。
// 帯の主役は被りの位置なので、そこに一番読める場所を割り当てる。
//
// ■ 表示範囲は「スクリム」ではなく「枠」で示す（設計仕様 6-4 step7 からの変更）
//
// 仕様は窓の外側を alpha 0.55 で覆う案だったが、既定ズーム80・90分素材では
// 窓幅が 2.7px しかない（スクリム被覆 99.7%）。「内側を明るく見せる」どころか
// 帯の全面が沈んで指紋が読めなくなる。窓は最低幅を持つ枠として描き、
// 指紋側のコントラストは落とさない。
//
// ■ 層の分離が性能の要
//   キャッシュ層（発話密度 + 被り）… 素材・編集・幅・テーマが変わったときだけ描き直す
//   ライブ層（窓 + 再生ヘッド）… スクロール/ズーム/再生ごとに描く（drawImage 1回 + fillRect 数回）
// これで再生中 60fps でもブロック走査が1フレームも走らない。

// 全体 → 帯の px/sec（純関数・node テスト対象）。drawTrack の z に相当する。
// 素材が無い（timelineEnd 0）ときも末尾余白ぶんで割って有限値を返す。
export function stripPxPerSec(stripWidth, timelineEnd, tail = TAIL_SECONDS) {
  const w = Math.max(0, Number(stripWidth) || 0);
  const total = Math.max(0, Number(timelineEnd) || 0) + Math.max(0, Number(tail) || 0);
  if (w <= 0 || total <= 0) return 0;
  return w / total;
}

// 密度バーの高さ（純関数・node テスト対象）。density は 0..1（列の時間に対する発話の割合）。
// 上限は half - 1（継ぎ目チャンネルの境界を1px 残す）。少しでも話していれば最低 1px は
// 立てる（俯瞰で「ここで喋っていた」ことを消さない = drawTrack の MIN_CLIP_PX と同じ思想）。
export function stripBarHeight(density, half = STRIP_BAR_MAX + 1) {
  const d = Math.max(0, Math.min(1, Number(density) || 0));
  if (d <= 0) return 0;
  const max = Math.max(1, half - 1);
  return Math.max(1, Math.min(max, d * max));
}

// 話者1人ぶんの発話密度を列ごとに積む（純関数・node テスト対象）。
// 返り値は長さ stripWidth の Float64Array で、各要素は 0..1。
// 「列の時間区間とブロックの重なり秒数 ÷ 列の時間幅」なので、
//   1列に発話が詰まっていれば 1（= 最大高）、半分なら 0.5、無音なら 0。
// ブロックは start 昇順（getIndex の byStart）を前提にするが、順序に依存しない実装。
// 計算量は O(ブロック数 + 触れた列数) で、90分・450ブロックでも列数 830 を超えない。
export function computeStripDensity(blocks, sz, stripWidth) {
  const w = Math.max(0, Math.round(Number(stripWidth) || 0));
  const cols = new Float64Array(Math.max(0, w));
  if (!blocks || !blocks.length || !(Number(sz) > 0) || w <= 0) return cols;
  const secPerCol = 1 / sz;
  for (const block of blocks) {
    const start = Number(block?.start);
    const dur = blockDuration(block);
    if (!Number.isFinite(start) || !(dur > 0)) continue;
    const x0 = start * sz;
    const x1 = x0 + dur * sz;
    if (x1 <= 0 || x0 >= w) continue;
    const from = Math.max(0, Math.floor(x0));
    const to = Math.min(w, Math.ceil(x1));
    for (let col = from; col < to; col += 1) {
      // 列 [col, col+1) と発話 [x0, x1) の重なりを px で取り、秒に直して足す
      const overlapPx = Math.min(col + 1, x1) - Math.max(col, x0);
      if (overlapPx > 0) cols[col] += overlapPx * secPerCol;
    }
  }
  // 秒 → 割合。被りで1列に両者が入っても各話者は自分の割合しか持たないので 1 で飽和
  for (let col = 0; col < w; col += 1) {
    cols[col] = Math.min(1, cols[col] / secPerCol);
  }
  return cols;
}

// 現在の表示範囲（波形ビューポート）を帯の x 区間に写す（純関数・node テスト対象）。
// scrollLeft/zoom が時刻になり、その時刻に sz を掛けるだけ。
//
// 素の窓は既定ズーム80・90分素材で 2.7px しかない（帯の 0.3%）。そのままでは
// 「今どこを見ているか」が読めないので、STRIP_WINDOW_MIN_W まで広げて描く。
// 広げるときは中心を保ったまま左右に伸ばし、帯の端では内側へ押し戻す
// （端で窓が帯の外に逃げると位置の手がかりが失われる）。
// full=true は「窓が帯のほぼ全体」= フィット表示中で、枠を描く意味がないことを示す。
export function computeStripWindow(scrollLeft, clientWidth, zoom, sz, stripWidth, minW = STRIP_WINDOW_MIN_W) {
  const z = Number(zoom) || 0;
  const w = Math.max(0, Number(stripWidth) || 0);
  if (z <= 0 || !(Number(sz) > 0) || w <= 0) return null;
  const t0 = Math.max(0, (Number(scrollLeft) || 0) / z);
  const t1 = t0 + Math.max(0, Number(clientWidth) || 0) / z;
  const rawX0 = clamp(t0 * sz, 0, w);
  const rawX1 = clamp(t1 * sz, 0, w);
  const want = Math.min(w, Math.max(minW, rawX1 - rawX0));
  // 中心を保って want まで広げ、はみ出した分は反対側へ寄せる
  let x0 = (rawX0 + rawX1) / 2 - want / 2;
  x0 = clamp(x0, 0, Math.max(0, w - want));
  return { x0, x1: x0 + want, full: want >= w - 0.5 };
}

// 帯 x → 時刻（純関数・node テスト対象）。クリックシークが使う。
// 帯の外を掴んでも端に丸める（負の時刻へ飛ばさない）。
export function stripXToTime(x, sz, timelineEnd) {
  if (!(Number(sz) > 0)) return 0;
  const t = (Number(x) || 0) / sz;
  return clamp(t, 0, Math.max(0, Number(timelineEnd) || 0));
}

// 被り区間を帯の px 矩形へ圧縮する（純関数・node テスト対象）。
// 90分素材では被りが数百本になり、帯幅 800px では大半が同じ列に重なる。
// 素直に1本ずつ fillRect すると（1）同じピクセルを何十回も塗って α が飽和し
// 「全面 Seam 色」になり（2）無駄な描画命令が増える。隣接・重複を1本に畳んでから
// 描くことで、見た目は「立っている縦線の本数」として読めるまま命令数が列数以下に収まる。
export function compressStripMarks(regions, sz, stripWidth, minPx = STRIP_MIN_MARK_PX) {
  const w = Math.max(0, Number(stripWidth) || 0);
  if (!regions || !regions.length || !(Number(sz) > 0) || w <= 0) return [];
  const raw = [];
  for (const r of regions) {
    const start = Number(r?.start);
    const end = Number(r?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const x = start * sz;
    const width = Math.max(minPx, (Math.max(start, end) - start) * sz);
    if (x + width <= 0 || x >= w) continue;
    raw.push([Math.max(0, x), Math.min(w, x + width)]);
  }
  if (!raw.length) return [];
  raw.sort((a, b) => a[0] - b[0]);
  const out = [];
  let [cs, ce] = raw[0];
  for (let i = 1; i < raw.length; i += 1) {
    const [s, e] = raw[i];
    if (s <= ce) {                  // 接触も含めて畳む（縦線が1本に見える範囲）
      if (e > ce) ce = e;
    } else {
      out.push({ x: cs, w: Math.max(minPx, ce - cs) });
      cs = s;
      ce = e;
    }
  }
  out.push({ x: cs, w: Math.max(minPx, ce - cs) });
  return out;
}

// キャッシュ有効条件のシグネチャ（純関数・node テスト対象）。
// これが変わったらキャッシュを捨てる。含まれないものが重要:
//   - スクロール / ズーム / 再生位置 … ライブ層なので捨ててはいけない（60fps の要）
//   - テーマ … COLORS はオブジェクトで値比較できないため applyThemeColors から明示破棄
//   - state.peaks … 帯は発話密度で描くので peaks に依存しない（未着でも完成形が出る）
export function stripCacheSignature(projectId, editVersion, width, ratio) {
  return [projectId ?? "", editVersion ?? -1, Math.round(width), ratio].join("|");
}

function initSeamStrip() {
  if (!els || !els.seamStrip) return;
  ctxStrip = els.seamStrip.getContext("2d");
  // 幅の正は transport の flex 配分なので、els.scroll の ResizeObserver には
  // 相乗りできない（別の要素・別の変化タイミング）。既存を汚さないよう別に持つ。
  stripObserver = new ResizeObserver(() => {
    syncStripSize();
    invalidateStrip();              // 幅の変化は stripCacheSignature が拾う
  });
  stripObserver.observe(els.seamStrip);
  syncStripSize();
}

function syncStripSize() {
  if (!els || !els.seamStrip || !ctxStrip) return;
  const canvas = els.seamStrip;
  const next = Math.max(1, Math.round(canvas.clientWidth));
  stripW = next;
  canvas.width = Math.max(1, Math.round(next * dpr));
  canvas.height = Math.max(1, Math.round(STRIP_H * dpr));
  ctxStrip.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// full=true で波形層（キャッシュ）も捨てる。rAF 合流は既存 invalidate と同じ流儀だが
// 帯だけの再描画を独立して間引けるよう別の rafId を持つ（波形本体の予算に触らない）。
export function invalidateStrip(full = false) {
  if (full) stripCache = null;
  if (!ctxStrip || stripRafId) return;
  stripRafId = requestAnimationFrame(() => {
    stripRafId = 0;
    drawSeamStrip();
  });
}

// 発話密度 + 被り = 「表示範囲や再生位置では変わらない層」をオフスクリーンへ1回描く。
function buildStripCache(index, sz) {
  const cache = document.createElement("canvas");
  cache.width = Math.max(1, Math.round(stripW * dpr));
  cache.height = Math.max(1, Math.round(STRIP_H * dpr));
  const ctx = cache.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = COLORS.rulerBg;
  ctx.fillRect(0, 0, stripW, STRIP_H);

  // A=上向き / B=下向き。列の高さ = その列の時間のうち話していた割合。
  // 振幅（peakMaxIn）ではない理由はこの節の冒頭コメントに実測値つきで書いてある。
  // バーは中央の継ぎ目チャンネルを避け、そこから外側へ伸ばす。
  for (const speaker of ["A", "B"]) {
    const density = computeStripDensity(index.byStart[speaker], sz, stripW);
    ctx.fillStyle = COLORS[speaker].peak;
    for (let col = 0; col < stripW; col += 1) {
      const h = stripBarHeight(density[col], STRIP_BAR_MAX + 1);
      if (h <= 0) continue;
      if (speaker === "A") ctx.fillRect(col, STRIP_SEAM_TOP - h, 1, h);
      else ctx.fillRect(col, STRIP_SEAM_BOTTOM, 1, h);
    }
  }

  // 被り = 継ぎ目チャンネル（帯の中央 STRIP_SEAM_H px）に立てる縦線。
  //
  // なぜ全高の縦線ではなく中央のチャンネルなのか（設計仕様 6-4 step6 からの変更）:
  // Seam 色（#b23a0a）と Speaker B の色（#9e5d0e）はコントラスト比 1.15 しかない。
  // 150px の波形本体では被りが「幅のある薄いティント」なので混ざらないが、帯では
  // 1px 幅の実線になるため、B の側に描いた線は事実上見えない（ライト 1.15 / ダーク 1.11）。
  // 被りの位置は帯の主役なので、密度バーが絶対に入らない中央の帯を専用に空け、
  // そこに地色（rulerBg）とのコントラストだけで読める線を立てる。
  // 実測: ライト #b23a0a on #f4f3f0 = 5.40 / ダーク #ff7a45 on #23262c = 5.86。
  // 密度バーも地色に対して ライト A 4.56 / B 4.70、ダーク A 6.73 / B 6.51 で全て 4.5 以上
  // （色はすべて PR1 のパレットのまま。新規に足した色は無い）。
  const marks = compressStripMarks(state.project?.overlaps, sz, stripW);
  if (marks.length) {
    ctx.fillStyle = COLORS.cursor;
    for (const m of marks) ctx.fillRect(m.x, STRIP_SEAM_TOP, m.w, STRIP_SEAM_H);
  }

  // チャンネルの上下の縁 = A/B の境界（旧ヘアライン）。被りの線より後に描いて
  // チャンネルを「溝」として見せる。被りの線はこの溝の中で完結する。
  ctx.fillStyle = COLORS.hairline;
  ctx.fillRect(0, STRIP_SEAM_TOP, stripW, 1);
  ctx.fillRect(0, STRIP_SEAM_BOTTOM - 1, stripW, 1);
  return cache;
}

function drawSeamStrip() {
  if (!els || !ctxStrip || stripW <= 0) return;
  // 帯が畳まれている幅（≤900px の display:none）では描かない。stripW は
  // syncStripSize の Math.max(1, …) で 1 に押し上げられるため上のガードでは
  // 落ちない（QA #71 指摘）。不可視の 1px に対して毎フレーム描くのを避ける。
  if (els.seamStrip.clientWidth <= 0) return;
  const ctx = ctxStrip;
  ctx.clearRect(0, 0, stripW, STRIP_H);

  // 角丸クリップ。地の塗りもこの中で行い、帯が transport から浮いて見えるようにする
  ctx.save();
  roundedRectPath(ctx, 0, 0, stripW, STRIP_H, STRIP_RADIUS);
  ctx.clip();

  const project = state.project;
  const index = project ? getIndex(project, state.editVersion) : null;
  const sz = stripPxPerSec(stripW, index ? index.timelineEnd : 0);

  if (!project || !sz) {
    // 未取込: 地だけ。空の帯が「席はあるが素材が無い」ことを示す
    ctx.fillStyle = COLORS.rulerBg;
    ctx.fillRect(0, 0, stripW, STRIP_H);
    ctx.restore();
    return;
  }

  const key = stripCacheSignature(project.id, state.editVersion, stripW, dpr);
  if (!stripCache || stripCacheKey !== key) {
    stripCache = buildStripCache(index, sz);
    stripCacheKey = key;
  }
  ctx.drawImage(stripCache, 0, 0, stripW, STRIP_H);

  // 表示範囲の窓: スクリムは使わない（既定ズームでは帯の 99.7% を覆ってしまい、
  // 指紋そのものが読めなくなる。節冒頭の実測を参照）。代わりに枠で囲う。
  // 内側をごく薄く起こして「ここを見ている」を示し、枠線で境界を確定させる。
  const win = computeStripWindow(
    els.scroll.scrollLeft, els.scroll.clientWidth, state.zoom, sz, stripW,
  );
  if (win && !win.full) {
    const wx = win.x0;
    const ww = Math.max(1, win.x1 - win.x0);
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = COLORS.selection;   // Ink（テーマ追従）
    ctx.fillRect(wx, 0, ww, STRIP_H);
    ctx.restore();
    ctx.strokeStyle = COLORS.selection;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(wx) + 0.5, 0.5,
      Math.max(1, Math.round(ww) - 1), STRIP_H - 1,
    );
  }

  // 再生ヘッドは必ず最後（窓の塗りに埋もれさせない）
  ctx.fillStyle = COLORS.cursor;
  ctx.fillRect(
    clamp(playheadTime * sz, 0, Math.max(0, stripW - STRIP_HEAD_W)), 0,
    STRIP_HEAD_W, STRIP_H,
  );
  ctx.restore();
}

// クリックシーク用の時刻解決（interactions が呼ぶ）。契約 §5 のとおり waveform は
// player を import しないので、ここは「clientX → 時刻」だけを返し seek はしない。
export function seamStripTimeAt(clientX) {
  if (!els || !els.seamStrip || stripW <= 0 || !state.project) return null;
  const index = getIndex(state.project, state.editVersion);
  const sz = stripPxPerSec(stripW, index.timelineEnd);
  if (!sz) return null;
  const rect = els.seamStrip.getBoundingClientRect();
  return stripXToTime(clientX - rect.left, sz, index.timelineEnd);
}

// ── ズーム ──────────────────────────────────────────────

// 「全体」トグルの状態（Issue #21 実機FB）。active = フィット表示中、restoreZoom = 復帰先。
// リサイズや blocks-changed でズーム値と computeFitZoom の結果がズレても誤判定しないよう、
// 値の一致比較ではなくフラグで管理する。解除経路は「通常ズーム操作（setZoom）」
// 「もう一度『全体』」「project-set」の3つ。node テスト（DOM無し）から遷移を
// 直接検証するため export している（COLORS と同じ「exportされた可変状態」パターン）。
export const fitState = { active: false, restoreZoom: null };

const DEFAULT_RESTORE_ZOOM = 80;    // #zoom スライダー初期値と同じ既定

export function resetFitState() {
  fitState.active = false;
  fitState.restoreZoom = null;
}

// フィット中なら通常域のズームへ復帰させてから状態を折る（project-set 用）。
// resetFitState と違い state.zoom も直す = ZOOM_MIN 未満の特例倍率を残留させない。
// 状態リセットを applyZoom（zoom-changed 発火）より先に行う: 購読側（ボタン同期）が
// 旧状態（押下中）を見ないように（fitToWindow と同じ順序原則）。
export function exitFitState() {
  const wasActive = fitState.active;
  const restore = fitState.restoreZoom;
  resetFitState();
  if (wasActive) {
    applyZoom(resolveRestoreZoom(restore));
  }
}

// 復帰先ズームの解決（純関数・nodeテスト対象）。記憶値が無い/不正なら既定80、
// あれば通常域 20..260 に clamp（記憶値は setZoom 経由の値なので実質 clamp 済み）。
export function resolveRestoreZoom(remembered, fallback = DEFAULT_RESTORE_ZOOM) {
  const z = Number(remembered);
  return Number.isFinite(z) && z > 0 ? clamp(z, ZOOM_MIN, ZOOM_MAX) : fallback;
}

// トグル遷移の判定（純関数・nodeテスト対象）。fitToWindow が使う。
//   非フィット時 → { mode: "fit", next }: 現在ズームを記憶してフィットへ
//   フィット時   → { mode: "restore", targetZoom, next }: 記憶ズーム（無ければ80）へ復帰
export function computeFitToggle(fit, currentZoom) {
  if (fit && fit.active) {
    return {
      mode: "restore",
      targetZoom: resolveRestoreZoom(fit.restoreZoom),
      next: { active: false, restoreZoom: null },
    };
  }
  return { mode: "fit", next: { active: true, restoreZoom: currentZoom } };
}

// clamp 20..260。anchorTime 未指定 = ビューポート中央固定（スライダー用）、
// 指定あり = その時刻のスクリーン位置を固定（Ctrl/⌘+wheel 用）。
// 通常のズーム操作はすべてここを通る = フィット状態（<20）から操作すると 20 以上に戻り、
// 同時にフィットトグルも解除される（#21）。
export function setZoom(pxPerSec, anchorTime) {
  resetFitState();
  applyZoom(clamp(pxPerSec, ZOOM_MIN, ZOOM_MAX), anchorTime);
}

// フィットズーム倍率 = ビューポート幅 ÷（timelineEnd + 末尾余白）。純関数（nodeテスト対象）。
// ZOOM_MIN では切らない（俯瞰の特例域）。上限のみ ZOOM_MAX、不正入力は ZOOM_MIN に落とす。
export function computeFitZoom(timelineEnd, viewW, tail = TAIL_SECONDS) {
  const total = Math.max(0, Number(timelineEnd) || 0) + Math.max(0, Number(tail) || 0);
  const width = Number(viewW) || 0;
  if (width <= 0 || total <= 0) return ZOOM_MIN;
  return Math.min(width / total, ZOOM_MAX);
}

// 「全体」ボタンのトグル（Issue #21 案1 + 実機FB対応）:
//   非フィット時 → 現在ズームを記憶してエピソード全体（末尾余白込み）を1画面へ。
//     ZOOM_MIN 未満を許す唯一の経路。ワンショット（リサイズ追従なし）。
//     フィット時は contentWidth == viewW となり、applyZoom 内のスクロールクランプで scrollLeft=0 に収束する。
//   フィット時 → 記憶ズーム（無ければ既定80）へ復帰し、再生ヘッドをビューポート中央へ。
//     playheadTime は playhead-tick 経由で player と同期済み（seek でも停止中でも更新される。
//     waveform は player を import しない契約のため getCurrentTime() は直接読まない）。
// fitState の更新は applyZoom（= zoom-changed 発火）より先に行い、購読側が新状態を見えるようにする。
export function fitToWindow() {
  if (!els) return;
  const step = computeFitToggle(fitState, state.zoom);
  Object.assign(fitState, step.next);
  if (step.mode === "restore") {
    setZoom(step.targetZoom);
    scrollToTime(playheadTime, "center");
    return;
  }
  const end = state.project ? getIndex(state.project, state.editVersion).timelineEnd : 0;
  applyZoom(computeFitZoom(end, els.scroll.clientWidth));
}

function applyZoom(z, anchorTime) {
  if (Math.abs(z - state.zoom) < 1e-9) return;
  if (!els) {
    state.zoom = z;
    emit("zoom-changed");
    return;
  }
  const scroller = els.scroll;
  const viewW = scroller.clientWidth;
  const oldZ = state.zoom;
  let anchorT;
  let anchorPx;
  if (anchorTime == null) {
    anchorPx = viewW / 2;
    anchorT = (scroller.scrollLeft + anchorPx) / oldZ;
  } else {
    anchorT = anchorTime;
    anchorPx = anchorT * oldZ - scroller.scrollLeft;
  }
  state.zoom = z;
  layout();
  programmaticScrollTo(clamp(anchorT * z - anchorPx, 0, Math.max(0, contentWidth - viewW)));
  emit("zoom-changed");
  invalidate();
}

// ── 座標変換 / ヒットテスト ─────────────────────────────

export function xToTime(clientX) {
  if (!els) return 0;
  const rect = els.scroll.getBoundingClientRect();
  return (els.scroll.scrollLeft + clientX - rect.left) / state.zoom;
}

export function timeToX(t) {
  return t * state.zoom;            // コンテンツ座標
}

export function hitTest(clientX, clientY) {
  if (!els) return null;
  const rect = els.scroll.getBoundingClientRect();
  const y = clientY - rect.top;
  if (y < 0 || y > rect.height) return null;
  const time = xToTime(clientX);
  let speaker = null;
  if (y >= RULER_H && y < RULER_H + TRACK_H) speaker = "A";
  else if (y >= RULER_H + TRACK_H && y < RULER_H + TRACK_H * 2) speaker = "B";
  let block = null;
  if (speaker && state.project) {
    block = findBlockAt(getIndex(state.project, state.editVersion), speaker, time);
  }
  return { speaker, time, block };
}

// ── スクロール / 再生ヘッド ─────────────────────────────

function programmaticScrollTo(x) {
  if (Math.abs(els.scroll.scrollLeft - x) < 0.5) return;
  expectedScrollLeft = x;
  els.scroll.scrollLeft = x;
}

export function scrollToTime(t, align = "left") {
  if (!els) return;
  const viewW = els.scroll.clientWidth;
  const x = t * state.zoom;
  const target = align === "center" ? x - viewW / 2 : x - viewW * 0.1;
  programmaticScrollTo(clamp(target, 0, Math.max(0, contentWidth - viewW)));
  invalidate();
}

function positionPlayhead() {
  if (!els) return;
  els.playhead.style.transform = `translateX(${playheadTime * state.zoom}px)`;
}

// 再生中の60fps更新は div の transform のみ（canvas再描画なし）。
// playhead が右端90%を超えたらページ送り。直近1.5秒以内の手動スクロール中は抑止。
export function setPlayheadTime(t) {
  playheadTime = Math.max(0, Number(t) || 0);
  if (!els) return;
  positionPlayhead();
  // 帯のヘッドだけは canvas なので再描画が要る。invalidateStrip は rAF 合流 +
  // キャッシュ済みなので、1フレームあたり drawImage 1回 + fillRect 数回に収まる
  // （波形本体の canvas は従来どおり無再描画）。
  invalidateStrip();
  const scroller = els.scroll;
  const viewW = scroller.clientWidth;
  const rel = playheadTime * state.zoom - scroller.scrollLeft;
  if ((rel > viewW * 0.9 || rel < 0)
      && performance.now() - lastManualScrollAt > FOLLOW_SUPPRESS_MS) {
    programmaticScrollTo(
      clamp(playheadTime * state.zoom - viewW * 0.1, 0, Math.max(0, contentWidth - viewW)),
    );
    invalidate();
  }
}

// ── ドラッグ / プレビュー / フラッシュ ──────────────────

// ドラッグ中の仮描画（モデル非破壊）。#dragReadout の表示もここで面倒を見る。
export function setDragOverride(override) {
  dragOverride = override || null;
  updateDragReadout();
  invalidate();
}

function updateDragReadout() {
  if (!els) return;
  const readout = els.dragReadout;
  if (!dragOverride) {
    readout.hidden = true;
    return;
  }
  const scrollLeft = els.scroll.scrollLeft;
  const viewW = els.scroll.clientWidth;
  let text = "";
  let left = scrollLeft + viewW / 2;
  let top = RULER_H + 6;
  if (dragOverride.type === "offset") {
    text = `offset ${dragOverride.speaker}: ${fmtMs(dragOverride.delta)}`;
    top = RULER_H + (dragOverride.speaker === "A" ? 0 : TRACK_H) + 6;
  } else if (dragOverride.type === "block") {
    text = formatClock(dragOverride.tempStart);
    const found = findBlockWithSpeaker(dragOverride.blockId);
    if (found) top = RULER_H + (found.speaker === "A" ? 0 : TRACK_H) + 6;
    left = clamp(dragOverride.tempStart * state.zoom, scrollLeft + 8, scrollLeft + viewW - 90);
  }
  readout.textContent = text;
  readout.style.left = `${left}px`;
  readout.style.top = `${top}px`;
  readout.hidden = false;
}

function formatClock(t) {
  const total = Math.max(0, Math.round((Number(t) || 0) * 1000));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const ms = total % 1000;
  return `${m}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

// 自動編集 dry_run プレビューのハッチ範囲（現在座標）。null でクリア。
export function setPreviewRegions(regions) {
  previewRegions = regions || null;
  invalidate();
}

// 600ms ハイライト（被りジャンプ・分割フィードバック）。speaker=null は両トラック。
export function flashRange(speaker, start, end) {
  flash = { speaker: speaker ?? null, start, end };
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flash = null;
    flashTimer = 0;
    invalidate();
  }, 600);
  invalidate();
}
