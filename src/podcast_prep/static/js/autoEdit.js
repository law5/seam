// autoEdit.js — 自動編集UI。overlaps-panel 先頭の at* ID群を担当。
// フローの実体（flushSave → POST → digest 保持 → apply時 pushHistory → adoptBlocksFrom）は
// persistence.runAutoEdit が持つ。本モジュールは UI と表示だけを担う:
// - チェックボックス/閾値入力（settings.auto_edit_* と双方向同期 + saveSoon。keep_overlap_s はUIに出さない）
// - 閾値のフロント事前検証（validateAutoEditThresholds → フィールド直下の .at-error 赤字。
//   不正のままプレビュー/適用は送信しない。サーバ400検証は最後の砦としてそのまま）。
//   同じ検証結果を**永続化ゲート**（thresholdValueToPersist）も参照する: サーバが 400 で
//   撥ねる値は settings にも書かない（#36 QA。max_ov: 0 が保存されると classify_overlaps が
//   ValueError → 被り一覧が全行「不明」に化ける）。妥当性ルールの定義箇所は1つのまま。
// - プレビュー: summary 表示 + waveform.setPreviewRegions ハッチ（gaps=青 / overlaps=橙）
// - 適用: toast。409 は persistence が自動再プレビューした dry_run 応答として返る
// - チェック/閾値変更・任意の編集(blocks-changed)・project-set → 適用ボタン無効化 + ハッチクリア
// - D: 被り一覧のチェック（panels が所有）を target_pairs として送る。選択が変わったら
//   overlap-selection-changed でプレビューを無効化する。
//
// 【Issue #36】閾値変更は一覧に即時反映しない。分類（category）は**プレビュー/適用の
// 成功時点で確定**させ（panels.confirmOverlapCategories）、閾値を触っただけでは
// 一覧の分類ラベルが書き換わらないようにする。旧挙動（350ms デバウンス PUT の echo で
// 分類が総入れ替え）はキーストロークのたびに結果が出てしまい、プレビューの意味を消していた。
// 被り区間そのもの（行の増減）は従来どおり即時反映する（panels 側の線引きを参照）。
//
// 【Issue #36】確認ダイアログ（#overlapResetDialog）の所有:
// main.js は autoEdit を import しているため、autoEdit → main の import は循環する。
// よって「at* 群は autoEdit が持つ」という既存の DOM 所有ルールをそのまま延長し、
// このダイアログの DOM も autoEdit が直接引く（main への注入も逆参照も作らない）。
// 判定そのものは shouldConfirmOverlapReset（純関数・テスト対象）に切り出し、
// importFlow.js / overlayGate.js と同じ「規則は純関数・DOM は端で」の流儀に揃えている。
// DOM 欠損時は fail-closed（確認を出せないなら実行しない）。

import { state, emit, on } from "./state.js";
import { runAutoEdit, saveSoon } from "./persistence.js";
import { setPreviewRegions } from "./waveform.js";
import {
  getSelectedTargetPairs,
  hasTouchedOverlaps,
  clearOverlapTouched,
  confirmOverlapCategories,
} from "./panels.js";

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
    // Issue #36: 被り一覧のチェックを手で変更した後のプレビュー確認
    resetDialog: document.getElementById("overlapResetDialog"),
    resetForm: document.getElementById("overlapResetForm"),
  };
  els.preview.addEventListener("click", () => {
    void preview();
  });
  els.apply.addEventListener("click", () => {
    void apply();
  });
  els.overlaps.addEventListener("change", invalidatePreview);
  els.gaps.addEventListener("change", invalidatePreview);
  // 第3引数は validateAutoEditThresholds の field 名（永続化ゲートが自分の欄の
  // エラーだけを見るために必要。#36 QA）
  bindThreshold(els.maxGap, "auto_edit_max_gap_s", "maxGap");
  bindThreshold(els.keepGap, "auto_edit_keep_gap_s", "keepGap");
  bindThreshold(els.maxOv, "auto_edit_max_overlap_s", "maxOv");

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

// 閾値入力: settings.auto_edit_* へ書いて saveSoon（既存 setTrackField と同じ永続化パターン）。
// 書いてよいかの判断は thresholdValueToPersist（下）が一手に引き受ける。
function bindThreshold(input, settingsKey, field) {
  input.addEventListener("input", () => {
    // 検証は**3欄まとめて**行う。max_gap < keep_gap のような組み合わせエラーは
    // 単独の欄だけ見ても判定できないため（サーバの検証式も3値をまとめて見る）。
    const value = thresholdValueToPersist(field, currentThresholdInputs(), minOverlapS());
    if (state.project?.settings && value !== null) {
      state.project.settings[settingsKey] = value;
      saveSoon();
    }
    invalidatePreview();
    renderThresholdErrors(); // 入力のたびにインライン検証を更新（直れば即消える）
  });
}

// 閾値3欄の生値（検証・永続化の判断はここを唯一の入力とする）
function currentThresholdInputs() {
  return {
    max_gap_s: els.maxGap.value,
    keep_gap_s: els.keepGap.value,
    max_overlap_s: els.maxOv.value,
  };
}

function minOverlapS() {
  return state.project?.settings?.min_overlap_s;
}

// 閾値入力欄の値 → 数値 / 数値にならない null（純関数・テスト対象）。
//
// Issue #36 の補足バグ: 旧実装は `Number(input.value)` をそのまま Number.isFinite に
// 掛けていたため、**入力欄を空にした瞬間** `Number("") === 0` が検証を通過していた
// （空白のみ・"abc" 等も同じ穴。Number(" ") も 0 になる）。
// この関数の責務は**「空」と「0」を取り違えないこと**だけ。値が妥当かどうか
// （範囲・欄どうしの整合）は validateAutoEditThresholds の責務で、混ぜない。
export function parseThresholdInput(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// 閾値欄 field の値を settings へ永続化してよいか（純関数・テスト対象）。
// 書いてよければ数値、書いてはいけなければ null を返す。
//
// Issue #36 QA: 空文字バグ（`Number("") === 0`）を塞いだだけでは**穴の半分**しか
// 埋まっていなかった。ユーザーが明示的に `0` と打つと parseThresholdInput は
// 素直に 0 を返すので、settings に `auto_edit_max_overlap_s: 0` が保存されて
// サーバへ飛ぶ。サーバ側で `max_ov < min_ov` となり classify_overlaps が
// ValueError → 分類を放棄し、被り一覧が**全行「不明」**に化ける。空文字のときと
// **同一症状・同一経路**なので、片方だけ塞いだ状態で残さない。
//
// 【レイヤ分離の解き方】新しい妥当性ルールをここに書き足すことはしない。
// 判定は既存の validateAutoEditThresholds に丸ごと委ね、**その結果に自分の欄の
// エラーが含まれるかどうかだけ**を見る。同関数はサーバ auto_edit_project の
// 検証式（keep_gap < 0 / max_gap < keep_gap / max_ov < min_ov）のミラーとして
// 書かれている = 「サーバが 400 で撥ねる値は settings にも書かない」が自動的に揃い、
// 妥当性ルールの定義箇所は1つのまま増えない。
// - parseThresholdInput … 「空」と「0」の区別（表記レベル）
// - validateAutoEditThresholds … 値が妥当か（意味レベル。赤字表示と共用）
// - この関数 … 上2つを合成して「永続化してよいか」だけを決める
//
// 検証を3欄まとめて行い、自分の欄に紐づくエラーだけを見るのが要点。
// max_gap < keep_gap のような組み合わせエラーは単独の欄では判定できず、
// かつサーバも3値をまとめて見て 400 を返すため、ここで同じ粒度に揃える。
// インライン赤字（renderThresholdErrors）は入力欄の生値を見て従来どおり出るので、
// 「保存されないが理由は赤字で分かる」状態になる。
export function thresholdValueToPersist(field, inputs, minOverlapSeconds) {
  const raw = THRESHOLD_INPUT_KEYS[field];
  if (!raw) return null; // 未知の欄は書かない（安全側）
  const value = parseThresholdInput(inputs?.[raw]);
  if (value === null) return null; // 空・空白・非数値
  const errors = validateAutoEditThresholds(inputs, minOverlapSeconds);
  if (errors.some((e) => e.field === field)) return null; // 不正値は settings に書かない
  return value;
}

// 欄の識別子（validateAutoEditThresholds の field 名）→ opts のキー
const THRESHOLD_INPUT_KEYS = {
  maxGap: "max_gap_s",
  keepGap: "keep_gap_s",
  maxOv: "max_overlap_s",
};

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

// Issue #36: プレビュー前に確認ダイアログを出すべきか（純関数・テスト対象）。
// 出す条件は「ユーザーが被り一覧のチェックを手で変更している」の一点だけ。
// 触っていなければ失われるものが無いので、従来どおり無確認で即プレビューする。
export function shouldConfirmOverlapReset(touched) {
  return !!touched;
}

// Issue #36: 確認ダイアログの submitter.value → 判断（純関数・テスト対象。
// workdirConflictChoice と同じ「安全側フォールバック」の流儀）。
// 「はい」= value "yes" のみ真。未知値・空・undefined（Esc で submitter が無い）は
// すべて「いいえ」= 実行しない側に倒す（他ダイアログの値が紛れても勝手に実行しない）。
export function overlapResetChoice(submitterValue) {
  return submitterValue === "yes";
}

// Issue #36: 確認ダイアログを Promise で包む（closeProjectDialog /
// exportOverwriteDialog と同じ流儀。ネイティブ confirm() は使わない）。
// dialog / form を引数で受けるのはテスト可能性のため（DOM 要素形の最小スタブを渡せる）。
// - returnValue ではなく event.submitter?.value を読む（form の submit ボタン値が正）
// - Esc（cancel イベント）は「いいえ」扱い
// - settle で submit / cancel 両方のリスナーを必ず外す（片方だけ once にすると
//   次回表示時に前回の残骸が発火する）
// - DOM 欠損（HTML / ID の退行）は **fail-closed = 実行しない**（#36 QA）。
//   他のダイアログ helper（confirmExportOverwrite 等）は DOM 欠損ガードを持たず
//   throw して止まる = 破壊的操作へ倒れない。ここだけ fail-open で true を返すと、
//   ダイアログが出ないまま**ユーザーが手で付けたチェックを無確認で破棄**する方向に
//   倒れる。確認を出せないなら実行しないのがコードベースの流儀と揃う。
export function awaitOverlapResetChoice(dialog, form) {
  if (!dialog || !form) return Promise.resolve(false); // 確認を出せないなら実行しない
  return new Promise((resolve) => {
    const settle = (yes) => {
      form.removeEventListener("submit", onSubmit);
      dialog.removeEventListener("cancel", onCancel);
      resolve(yes);
    };
    const onSubmit = (event) => settle(overlapResetChoice(event.submitter?.value));
    const onCancel = () => settle(false);
    form.addEventListener("submit", onSubmit);
    dialog.addEventListener("cancel", onCancel);
    dialog.showModal();
  });
}

function confirmOverlapReset() {
  return awaitOverlapResetChoice(els.resetDialog, els.resetForm);
}

async function preview() {
  if (busy || !ready()) return;
  if (!renderThresholdErrors()) return; // 不正閾値は送信しない（インライン赤字で提示済み）
  // Issue #36: 手でチェックを変えた後のプレビューは、その変更が解除されることを先に伝える。
  // busy を先に立ててからダイアログを開く（await 中の再入 = showModal の二重呼びを防ぐ。
  // importFlow.js の busy ガードと同じ役割）。
  setBusy(true);
  try {
    if (shouldConfirmOverlapReset(hasTouchedOverlaps())) {
      const proceed = await confirmOverlapReset();
      if (!proceed) return; // いいえ = 何もしない（トーストも出さない）
      if (!ready()) return; // ダイアログを待っている間にプロジェクトが変わった
    }
    // 「はい」= チェックを既定（分類由来）へ戻してから、その内容でプレビューする。
    // clearOverlapTouched → renderOverlaps で行が再評価されるので、この後に読む
    // currentOpts() の target_pairs は既定チェックの結果になる。
    clearOverlapTouched();
    // ダイアログ表示中も閾値欄は編集できる（モーダルの外ではあるが state は動く）ため、
    // 送信直前にもう一度ゲートを通す。不正閾値を送るとサーバ 400 の生メッセージが出る。
    if (!renderThresholdErrors()) return;
    const version = state.editVersion;
    const data = await runAutoEdit({ ...currentOpts(), dry_run: true });
    // 実行中に編集が入った場合は古いプレビューを描かない（適用は digest 409 が防ぐ）
    if (state.editVersion !== version || !state.project) return;
    renderPreview(data);
    // Issue #36: このプレビューで見えている分類を確定させる。以降、閾値変更の echo が
    // 届いても一覧の分類ラベルはここで確定した値のまま（プレビュー起点の確定）。
    confirmOverlapCategories();
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
      // 再プレビューも「プレビュー成功」なので分類を確定し直す（#36）
      confirmOverlapCategories();
      toast("プロジェクトが変わっていたため再プレビューしました");
    } else if (data.applied) {
      // pushHistory → adoptBlocksFrom は persistence 側で完了済み（追加PUTなし・⌘Zで一括Undo）。
      // adoptBlocksFrom の blocks-changed で本モジュールのハッチ/summary はクリア済み。
      // Issue #36: 適用後の overlaps（adoptBlocksFrom がサーバ応答で差し替え済み）で
      // 分類を確定し直す。適用で被りが解消され一覧の顔ぶれ自体が変わっているため、
      // 古いスナップショットを残すと消えたペアの分類を抱え続けることになる。
      confirmOverlapCategories();
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
