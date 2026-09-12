// autoEdit.js — 自動編集UI。overlaps-panel 先頭の at* ID群を担当。
// フローの実体（flushSave → POST → digest 保持 → apply時 pushHistory → adoptBlocksFrom）は
// persistence.runAutoEdit が持つ。本モジュールは UI と表示だけを担う:
// - チェックボックス/閾値入力（settings.auto_edit_* と双方向同期 + saveSoon。keep_overlap_s はUIに出さない）
// - 閾値のフロント事前検証（validateAutoEditThresholds → フィールド直下の .at-error 赤字。
//   不正のままプレビュー/適用は送信しない。サーバ400検証は最後の砦としてそのまま）
// - プレビュー: summary 表示 + waveform.setPreviewRegions ハッチ（gaps=青 / overlaps=橙）
// - 適用: toast。409 は persistence が自動再プレビューした dry_run 応答として返る
// - チェック/閾値変更・任意の編集(blocks-changed)・project-set → 適用ボタン無効化 + ハッチクリア
// - D: 被り一覧のチェック（panels が所有）を target_pairs として送る。選択が変わったら
//   overlap-selection-changed でプレビューを無効化する。
//   閾値 auto_edit_max_overlap_s を変えると category（分類チップ）が変わるため、
//   閾値変更でも一覧の分類は stale になる（BE1 申し送り2）。適用ボタン無効化と同じ扱い。

import { state, emit, on } from "./state.js";
import { runAutoEdit, saveSoon } from "./persistence.js";
import { setPreviewRegions } from "./waveform.js";
import { getSelectedTargetPairs } from "./panels.js";

// 契約 §A の settings 既定値（settings 未設定の旧プロジェクト用フォールバック）
const DEFAULTS = { max_gap_s: 1.5, keep_gap_s: 0.5, max_overlap_s: 3.0 };

let els = null;
let busy = false;

function toast(message, timeout) {
  emit("toast", { message, timeout });
}

function ready() {
  return !!state.project && state.project.status === "ready";
}

export function initAutoEdit(elements) {
  els = elements || {
    overlaps: document.getElementById("atOverlaps"),
    gaps: document.getElementById("atGaps"),
    maxGap: document.getElementById("atMaxGap"),
    keepGap: document.getElementById("atKeepGap"),
    maxOv: document.getElementById("atMaxOv"),
    preview: document.getElementById("atPreview"),
    apply: document.getElementById("atApply"),
    summary: document.getElementById("atSummary"),
    gapError: document.getElementById("atGapError"),
    maxOvError: document.getElementById("atMaxOvError"),
  };
  els.preview.addEventListener("click", () => {
    void preview();
  });
  els.apply.addEventListener("click", () => {
    void apply();
  });
  els.overlaps.addEventListener("change", invalidatePreview);
  els.gaps.addEventListener("change", invalidatePreview);
  bindThreshold(els.maxGap, "auto_edit_max_gap_s");
  bindThreshold(els.keepGap, "auto_edit_keep_gap_s");
  bindThreshold(els.maxOv, "auto_edit_max_overlap_s");

  on("project-set", () => {
    syncFromSettings();
    invalidatePreview();
    renderThresholdErrors();
    updateEnabled();
  });
  on("blocks-changed", invalidatePreview); // 任意の編集でプレビュー無効化（契約 §B）
  on("overlap-selection-changed", invalidatePreview); // D: 選択が変われば古いプレビューは嘘になる

  syncFromSettings();
  invalidatePreview();
  renderThresholdErrors();
  updateEnabled();
}

// 閾値入力: settings.auto_edit_* へ書いて saveSoon（既存 setTrackField と同じ永続化パターン）
function bindThreshold(input, settingsKey) {
  input.addEventListener("input", () => {
    const value = Number(input.value);
    if (state.project?.settings && Number.isFinite(value)) {
      state.project.settings[settingsKey] = value;
      saveSoon();
    }
    invalidatePreview();
    renderThresholdErrors(); // 入力のたびにインライン検証を更新（直れば即消える）
  });
}

// project-set 時に settings から閾値欄を初期化（未設定は契約既定値）
function syncFromSettings() {
  const settings = state.project?.settings || {};
  setNumberInput(els.maxGap, settings.auto_edit_max_gap_s, DEFAULTS.max_gap_s);
  setNumberInput(els.keepGap, settings.auto_edit_keep_gap_s, DEFAULTS.keep_gap_s);
  setNumberInput(els.maxOv, settings.auto_edit_max_overlap_s, DEFAULTS.max_overlap_s);
}

function setNumberInput(input, value, fallback) {
  const v = Number(value);
  input.value = String(Number.isFinite(v) ? v : fallback);
}

function invalidatePreview() {
  if (!els) return;
  els.apply.disabled = true;
  els.summary.textContent = "";
  setPreviewRegions(null);
}

function updateEnabled() {
  els.preview.disabled = busy || !ready();
}

function setBusy(value) {
  busy = value;
  updateEnabled();
  if (value) els.apply.disabled = true;
}

// サーバ契約 §A のキーのみ（keep_overlap_s は settings 専用の上級ノブでUIから送らない）。
// target_pairs は**常に配列を明示送信**する（省略すると全件適用になり、
// 「全チェックを外した」意図が全件解消に化ける。BE1 申し送り3）。
function currentOpts() {
  return {
    tighten_gaps: !!els.gaps.checked,
    tighten_overlaps: !!els.overlaps.checked,
    max_gap_s: Number(els.maxGap.value),
    keep_gap_s: Number(els.keepGap.value),
    max_overlap_s: Number(els.maxOv.value),
    target_pairs: getSelectedTargetPairs(),
  };
}

// 閾値のインライン検証を描画し、妥当なら true（プレビュー/適用の送信ゲート）。
// フィールド近傍の赤字（.at-error）に日本語で表示する。サーバ 400 の生メッセージ
// （invalid auto edit thresholds）を toast で見せない（実機FB #20）。
function renderThresholdErrors() {
  if (!els) return true;
  const errors = validateAutoEditThresholds(
    {
      max_gap_s: els.maxGap.value,
      keep_gap_s: els.keepGap.value,
      max_overlap_s: els.maxOv.value,
    },
    state.project?.settings?.min_overlap_s,
  );
  setErrorText(els.gapError, errors.filter((e) => e.field === "maxGap" || e.field === "keepGap"));
  setErrorText(els.maxOvError, errors.filter((e) => e.field === "maxOv"));
  return errors.length === 0;
}

function setErrorText(node, errs) {
  if (!node) return;
  node.textContent = errs.map((e) => e.message).join(" / ");
  node.hidden = errs.length === 0;
}

function renderPreview(data) {
  els.summary.textContent = formatAutoEditSummary(data.summary);
  const preview = data.preview || {};
  setPreviewRegions({ gaps: preview.gaps || [], overlaps: preview.overlaps || [] });
  els.apply.disabled = !(data.summary && data.summary.would_change);
}

async function preview() {
  if (busy || !ready()) return;
  if (!renderThresholdErrors()) return; // 不正閾値は送信しない（インライン赤字で提示済み）
  setBusy(true);
  const version = state.editVersion;
  try {
    const data = await runAutoEdit({ ...currentOpts(), dry_run: true });
    // 実行中に編集が入った場合は古いプレビューを描かない（適用は digest 409 が防ぐ）
    if (state.editVersion !== version || !state.project) return;
    renderPreview(data);
  } catch (err) {
    toast(`自動編集プレビュー失敗: ${err.message}`, 8000);
  } finally {
    setBusy(false);
  }
}

async function apply() {
  if (busy || !ready()) return;
  if (!renderThresholdErrors()) return; // 不正閾値は送信しない（インライン赤字で提示済み）
  setBusy(true);
  const version = state.editVersion;
  try {
    const data = await runAutoEdit({ ...currentOpts(), dry_run: false });
    if (!state.project) return;
    if (data.dry_run) {
      // 409 "changed since preview" → persistence が自動再プレビューした応答
      if (state.editVersion === version) renderPreview(data);
      toast("プロジェクトが変わっていたため再プレビューしました");
    } else if (data.applied) {
      // pushHistory → adoptBlocksFrom は persistence 側で完了済み（追加PUTなし・⌘Zで一括Undo）。
      // adoptBlocksFrom の blocks-changed で本モジュールのハッチ/summary はクリア済み。
      const summary = data.summary || {};
      toast(
        `自動調整を適用: 無音 ${summary.gaps_closed ?? 0}件 / 被り ${summary.overlaps_resolved ?? 0}件`,
      );
    } else {
      toast("自動調整: 変更はありませんでした");
      invalidatePreview();
    }
  } catch (err) {
    toast(`自動編集の適用に失敗: ${err.message}`, 8000);
  } finally {
    setBusy(false);
  }
}

// ── 検証・表示整形（純関数・テスト対象） ────────────────

// 閾値のフロント事前検証（実機FB #20: サーバ 400 の生メッセージ
// 「invalid auto edit thresholds」がプレビュー失敗 toast に出ていた）。
// サーバ auto_edit_project の検証式
//   keep_gap < 0 or max_gap < keep_gap or max_ov < min_ov
// のうち **UI で編集できる3欄ぶん**をミラーする。サーバ側検証は最後の砦として
// そのまま。keep_overlap_s は settings 専用の上級ノブで UI に出ないため対象外
// （不正なら従来どおりサーバ 400 の toast で提示される）。
// 返り値: [{field: "maxGap"|"keepGap"|"maxOv", message}]。空配列 = 妥当。
export function validateAutoEditThresholds(opts, minOverlapS = 0.3) {
  const errors = [];
  const maxGap = Number(opts?.max_gap_s);
  const keepGap = Number(opts?.keep_gap_s);
  const maxOv = Number(opts?.max_overlap_s);
  const minOv = Number.isFinite(Number(minOverlapS)) ? Number(minOverlapS) : 0.3;
  if (!Number.isFinite(maxGap)) {
    errors.push({ field: "maxGap", message: "「超」の秒数に数値を入力してください" });
  }
  if (!Number.isFinite(keepGap)) {
    errors.push({ field: "keepGap", message: "「→」の秒数に数値を入力してください" });
  } else if (keepGap < 0) {
    errors.push({ field: "keepGap", message: "詰めた後（→）の秒数は 0 以上にしてください" });
  }
  if (Number.isFinite(maxGap) && Number.isFinite(keepGap) && maxGap < keepGap) {
    errors.push({
      field: "keepGap",
      message: "詰めた後（→）の秒数は詰める判定（超）の秒数以下にしてください",
    });
  }
  if (!Number.isFinite(maxOv)) {
    errors.push({ field: "maxOv", message: "数値を入力してください" });
  } else if (maxOv < minOv) {
    errors.push({
      field: "maxOv",
      message: `${minOv} 秒以上にしてください（被り検出の下限より小さくできません）`,
    });
  }
  return errors;
}

// ── 表示整形（純関数・テスト対象） ──────────────────────

export function formatAutoEditSummary(summary) {
  if (!summary) return "";
  const removed = (Number(summary.duration_before) || 0) - (Number(summary.duration_after) || 0);
  const sign = removed >= 0 ? "−" : "+";
  const lines = [
    `適用予定: ギャップ ${summary.gaps_closed ?? 0}件 / 被り ${summary.overlaps_resolved ?? 0}件` +
      `（${sign}${formatSpan(Math.abs(removed))}）`,
  ];
  if (summary.overlaps_skipped) {
    const reasons = summary.skipped_reasons || {};
    lines.push(
      `スキップ ${summary.overlaps_skipped}件（相槌${reasons.contained ?? 0} / ` +
        `長尺${reasons.too_long ?? 0} / 同時${reasons.same_start ?? 0}）`,
    );
  }
  if (!summary.would_change) lines.push("変更はありません");
  return lines.join("\n");
}

// 秒数の短縮表示: 60秒未満 "12.3s" / 以上 "3:13"（純関数・テスト対象）
export function formatSpan(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const tenth = Math.round(s * 10) / 10;
  if (tenth < 60) return `${tenth.toFixed(1)}s`;
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const rest = total % 60;
  return `${m}:${String(rest).padStart(2, "0")}`;
}
