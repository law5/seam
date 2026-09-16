// panels.js — 下段パネル群と transport / topbar 表示要素の結線（initPanels）。
// 担当: 被り一覧（分類チップ / チェックボックス選択 / Prev・Next ナビ /
//       クリック=scrollToTime+後発ブロック選択+flashRange）/ #selectedBlock /
//       トラック設定入力（gain/deesser/offset）/ ラウドネス後がけ（POST /normalize）/
//       ラウドネス設定欄（#targetLufs / #truePeak / #normTolerance / #loudnormReset。Issue #37）/
//       Before/After（player.playPreview）/ undo/redoボタン+入力欄同期 / block-tools /
//       transport(▶⏸・±5s) / #jobProgress / timeReadout / 保存インジケータ(save-state) /
//       書き出し結果（出力先パス表示 + Finderで開く）/ 作業フォルダ表示（#workdirInfo）/ #toast。
// イベント購読は §10.4 の panels 行を自モジュール内で行う（公開APIが initPanels のみのため）。
// "toast" イベント（{message, timeout}）は内部イベント: 他モジュールが emit し
// panels が #toast に表示する（DOM を持たないモジュールからの通知経路）。
// waveform を import する（被り一覧クリックの scrollToTime + flashRange が panels の
// 責務のため。waveform → panels の逆参照は無く循環しない）。
// persistence を import する(2026-08)（ラウドネス後がけ・reveal のジョブ実行）。
//
// 【被り選択の所有権】チェック状態（selectedPairs）は panels が持ち、autoEdit が
// getSelectedTargetPairs() で読む。autoEdit → panels の一方向参照で循環しない
// （panels は autoEdit を import しない）。永続化しないフロントの一時状態。

import { state, on, emit, beginJob, endJob, isJobBusy } from "./state.js";
import {
  fmt, blockDuration, blockEnd, nearestScrollTop,
  LOUDNORM_DEFAULTS, applyLoudnormDefaults,
} from "./utils.js";
import * as edits from "./edits.js";
import * as player from "./player.js";
import { canUndo, canRedo } from "./history.js";
import * as waveform from "./waveform.js";
import * as persistence from "./persistence.js";

const SPEAKERS = ["A", "B"];
const JOB_KIND_LABELS = {
  import: "取込",
  transcribe: "文字起こし",
  export: "エクスポート",
  normalize: "ラウドネス正規化",
  restore: "復元", // Issue #22: アーカイブ済みプロジェクトの中間WAV再生成
  model_download: "モデル取得", // Issue #12: Whisperモデルのダウンロード（契約 §K）
};
const $ = (id) => document.getElementById(id);

let els = null;
let lastTick = 0;
let toastTimer = 0;
let saveLabelTimer = 0;
let playerDisabled = false;
let endCache = { project: null, version: -1, value: 0 };

// ── 被り一覧の一時状態（project.json には保存しない） ──
let overlapRows = [];          // 描画中の行データ [{overlap, key, category, checked}]
let selectedPairs = new Set(); // チェック済みペアの key（"a|b" 正規化済み）
let seenPairs = new Set();     // 既定チェックの判断を確定済みのペア（Issue #45: 現存ペアに
                               // 絞らず世代内で保持。分類未導出の初見ペアは未確定のまま）
let selectionSeeded = false;   // このプロジェクト世代で既定チェックを注入済みか
let cursorIndex = -1;          // Prev/Next の現在位置（overlapRows のindex）
// 後がけ正規化ジョブの多重起動ガードは state（beginJob/endJob）が正（#57 QA の根因対応）。
// 従来はここのローカル変数だけで持っており、main の jobBusy が立たないため正規化中でも
// 「編集を破棄して閉じる」・復元・別プロジェクト取込が通ってしまっていた。
let lastExport = null;         // {dir, files} — 直近のエクスポート結果（G）

export function initPanels() {
  els = {
    overlaps: $("overlaps"),
    overlapCount: $("overlapCount"),
    overlapSummary: $("ovSummary"),
    ovCheckAll: $("ovCheckAll"),
    ovUncheckAll: $("ovUncheckAll"),
    ovPrev: $("ovPrev"),
    ovNext: $("ovNext"),
    ovPosition: $("ovPosition"),
    normStatusA: document.querySelector('[data-norm-status="A"]'),
    normStatusB: document.querySelector('[data-norm-status="B"]'),
    targetLufs: $("targetLufs"),
    truePeak: $("truePeak"),
    normTolerance: $("normTolerance"),
    loudnormReset: $("loudnormReset"),
    exportResult: $("exportResult"),
    exportPath: $("exportPath"),
    revealExport: $("revealExport"),
    workdirInfo: $("workdirInfo"),
    workdirPath: $("workdirPath"),
    revealWorkdir: $("revealWorkdir"),
    selectedBlock: $("selectedBlock"),
    undo: $("undo"),
    redo: $("redo"),
    splitBlock: $("splitBlock"),
    deleteBlock: $("deleteBlock"),
    insertGap: $("insertGap"),
    deleteGap: $("deleteGap"),
    playPause: $("playPause"),
    back5: $("back5"),
    forward5: $("forward5"),
    timeReadout: $("timeReadout"),
    zoom: $("zoom"),
    jobProgress: $("jobProgress"),
    jobBar: document.querySelector("#jobProgress progress"),
    jobLabel: document.querySelector("#jobProgress span"),
    saveButton: $("saveProject"),
    toast: $("toast"),
  };
  bindTransport();
  bindBlockTools();
  bindTrackSettings();
  bindOverlapControls();
  bindExportResult();
  subscribe();
  renderAll();
}

// 被り一覧のヘッダ操作（全選択・全解除・Prev/Next）。
// Prev/Next（ボタン・←→/A・D）は解消可の行だけに飛ぶ（Issue #52。moveOverlapCursor 参照）。
// キーボード（Issue #20）: 一覧コンテナに focus があるときだけ ←→=移動 /
// ↓=チェック切替 / ↑=その位置から再生（A/D/S/W は別名）。document keydown は
// interactions が所有しているため、二重バインド禁止に従いコンテナ限定で購読する。
function bindOverlapControls() {
  els.ovCheckAll?.addEventListener("click", () => setAllChecked(true));
  els.ovUncheckAll?.addEventListener("click", () => setAllChecked(false));
  els.ovPrev?.addEventListener("click", () => moveOverlapCursor(-1));
  els.ovNext?.addEventListener("click", () => moveOverlapCursor(1));
  els.overlaps.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement) return; // チェックボックス操作を邪魔しない
    if (event.metaKey || event.ctrlKey || event.altKey) return; // ⌘Z 等のショートカットを奪わない
    const action = overlapKeyAction(event.key);
    if (!action) return; // 割り当て外（Space=再生/停止 等）はグローバルへ素通し
    // stopPropagation 必須: document keydown を持つ interactions と二重発火する
    // （←→ = ±5秒シーク、S = 再生ヘッド位置で分割）。一覧フォーカス中はこちらが
    // 勝つ、というスコープ切りがこの1行。契約 §E-3 のコンテナ限定購読は
    // これとセットで初めて成立する。
    event.preventDefault();
    event.stopPropagation();
    if (action === "prev") moveOverlapCursor(-1);
    else if (action === "next") moveOverlapCursor(1);
    else if (action === "toggle") toggleCursorChecked();
    else playCursorOverlap();
  });
}

// G: 「Finderで開く」。job.result.output_dir を POST /reveal に渡す。
function bindExportResult() {
  els.revealExport?.addEventListener("click", () => {
    void revealExport();
  });
  els.revealWorkdir?.addEventListener("click", () => {
    void revealWorkdir();
  });
}

// ── バインド ────────────────────────────────────────────

function bindTransport() {
  els.playPause.addEventListener("click", () => player.toggle().catch(() => {}));
  els.back5.addEventListener("click", () => player.seek(player.getCurrentTime() - 5));
  els.forward5.addEventListener("click", () => player.seek(player.getCurrentTime() + 5));
}

function bindBlockTools() {
  els.undo.addEventListener("click", () => edits.undoEdit());
  els.redo.addEventListener("click", () => edits.redoEdit());
  els.splitBlock.addEventListener("click", () => {
    if (!edits.splitSelectedAtPlayhead()) {
      toastMsg("分割できません（ブロックを選択し、再生ヘッドを端から50ms以上内側へ）");
    }
  });
  els.deleteBlock.addEventListener("click", () => {
    if (!edits.deleteSelected()) toastMsg("削除するブロックを選択してください");
  });
  els.insertGap.addEventListener("click", () => {
    const duration = askDuration("1.0");
    if (duration) edits.insertGapAt(player.getCurrentTime(), duration, ["A", "B"]);
  });
  els.deleteGap.addEventListener("click", () => {
    const duration = askDuration("1.0");
    if (duration) edits.deleteGapAt(player.getCurrentTime(), duration, ["A", "B"]);
  });
}

function bindTrackSettings() {
  for (const input of document.querySelectorAll("[data-field][data-speaker]")) {
    const speaker = input.dataset.speaker;
    const field = input.dataset.field;
    if (field === "gain_db") {
      // input = ライブ反映（モデル非変更）+ 現在値表示、change = 履歴1段 + 保存
      input.addEventListener("input", () => {
        player.setGainDb(speaker, Number(input.value));
        setOutputValue(speaker, "gain_db", Number(input.value));
      });
      input.addEventListener("change", () => edits.setTrackField(speaker, "gain_db", Number(input.value)));
    } else if (field === "deesser") {
      input.addEventListener("input", () => setOutputValue(speaker, "deesser", Number(input.value)));
      input.addEventListener("change", () => edits.setTrackField(speaker, "deesser", Number(input.value)));
    } else if (field === "offset_seconds") {
      input.addEventListener("change", () => {
        const result = edits.applyTrackOffset(speaker, Number(input.value || 0) / 1000);
        if (result && result.clamped) {
          toastMsg("オフセットは先頭 0 秒でクランプしました（相手トラックを右にずらしてください）");
        }
        syncTrackInputs(); // クランプ後の実値を反映（blocks-changed 側でも同期される）
      });
    }
  }
  for (const btn of document.querySelectorAll("[data-preview]")) {
    btn.addEventListener("click", () => playPreviewFor(btn.dataset.speaker, btn.dataset.preview));
  }
  // L: 後がけラウドネス正規化（トラック単位）
  for (const btn of document.querySelectorAll("[data-normalize]")) {
    btn.addEventListener("click", () => {
      void runNormalize(btn.dataset.normalize);
    });
  }
  // Issue #37: ラウドネス設定（settings へ書いて saveSoon — autoEdit.bindThreshold と同じ流儀）
  bindLoudnormOption(els.targetLufs, "target_lufs");
  bindLoudnormOption(els.truePeak, "true_peak");
  bindLoudnormOption(els.normTolerance, "tolerance");
  // Issue #37 追加FB: リセット（既定値へ1クリックで戻す。settings は Undo 対象外なので確認なし）
  els.loudnormReset?.addEventListener("click", () => {
    const changed = applyLoudnormDefaults(state.project?.settings);
    syncLoudnormInputs();
    if (changed) persistence.saveSoon();
  });
}

// ラウドネス設定欄 → project.settings（target_lufs / true_peak / tolerance）。プロジェクト共通設定。
function bindLoudnormOption(input, settingsKey) {
  input?.addEventListener("change", () => {
    const value = Number(input.value);
    if (state.project?.settings && Number.isFinite(value)) {
      state.project.settings[settingsKey] = value;
      persistence.saveSoon();
    }
  });
}

// ── 購読（§10.4 の panels 行） ──────────────────────────

function subscribe() {
  on("project-set", () => {
    playerDisabled = false;
    // 新しいプロジェクト世代: 被り選択と Prev/Next カーソルをリセットし、既定チェックを再注入
    selectedPairs = new Set();
    seenPairs = new Set();
    selectionSeeded = false;
    cursorIndex = -1;
    lastExport = null; // 前プロジェクトの出力先を新プロジェクトの結果として見せない
    renderAll();
  });
  on("blocks-changed", () => {
    renderOverlaps();
    renderSelected();
    syncTrackInputs();
    updateUndoRedo();
    updateReadout();
    pushGains(); // Undo/Redo で gain_db が戻ったときの player 追従
  });
  on("selection-changed", renderSelected);
  // PUT echo でサーバ導出の overlap.category が反映されたら分類チップを描き直す
  // （Issue #20 実機FB。overlaps の中身だけの更新なので被り一覧のみ再描画。
  //   renderOverlaps は選択・カーソルを保持し、スクロールもしない）
  on("overlaps-merged", renderOverlaps);
  on("zoom-changed", () => {
    if (els.zoom && els.zoom !== document.activeElement) els.zoom.value = String(state.zoom);
  });
  on("playhead-tick", (t) => {
    lastTick = Number(t) || 0;
    updateReadout();
  });
  on("player-state", (info) => {
    const playing = !!(info && info.playing);
    els.playPause.textContent = playing ? "⏸" : "▶";
    if (info && info.disabled && !playerDisabled) {
      playerDisabled = true;
      toastMsg("再生の準備に失敗しました（波形表示と編集は利用できます）", 8000);
    }
    updateReadyState();
  });
  on("save-state", onSaveState);
  on("job-progress", onJobProgress);
  // #57 QA: 在否が state に移ったので、他モジュール所有のジョブ（取込 / 文字起こし /
  // エクスポート）でも正規化ボタンの disabled が追随する。
  on("job-busy", () => updateReadyState());
  on("toast", (detail) => {
    if (detail && detail.message) toastMsg(detail.message, detail.timeout);
  });
}

// ── 描画 ────────────────────────────────────────────────

function renderAll() {
  syncTrackInputs();
  renderOverlaps();
  renderSelected();
  updateUndoRedo();
  updateReadout();
  updateReadyState();
  renderExportResult();
  renderWorkdir();
  pushGains();
  if (els.zoom) els.zoom.value = String(state.zoom);
}

// ── 被り一覧（C: 分類チップ / D: 選択 / E: Prev・Next） ──
//
// 分類チップの契約（BE1 申し送り）: overlap.category は欠損しうる（min_overlap_s 未満で
// 分類対象外・settings 破損時など）。既定チェックの判定は必ず肯定形 `=== "resolvable"` で
// 書く。否定形だと undefined が誤って ON（＝保護対象を自動編集）になる。

// 分類 → チップ文言・クラス・保護フラグ（純関数・テスト対象）。
// 未知/欠損は「不明」= 保護扱い（安全側フォールバック）。
export const OVERLAP_CATEGORIES = {
  resolvable: { label: "解消可", className: "ov-cat resolvable", protected: false },
  contained: { label: "相槌", className: "ov-cat protected", protected: true },
  too_long: { label: "長尺", className: "ov-cat protected", protected: true },
  same_start: { label: "同時", className: "ov-cat protected", protected: true },
};
const UNKNOWN_CATEGORY = { label: "不明", className: "ov-cat unknown", protected: true };

export function categoryInfo(category) {
  return OVERLAP_CATEGORIES[category] || UNKNOWN_CATEGORY;
}

// block_ids ペアの正規化キー（順不同 → ソートして "|" 連結）。純関数・テスト対象。
// id が2つ揃わない壊れた overlap は null（選択対象にしない）。
export function pairKey(blockIds) {
  const ids = (blockIds || []).filter((id) => typeof id === "string" && id);
  if (ids.length !== 2) return null;
  return ids.slice().sort().join("|");
}

// 既定チェック状態: category === "resolvable" のみ ON（肯定形判定）。純関数・テスト対象。
export function defaultChecked(overlap) {
  return (overlap?.category ?? null) === "resolvable";
}

// 一覧ヘッダのサマリー整形（純関数・テスト対象）。
export function formatOverlapSummary(rows) {
  const list = rows || [];
  let resolvable = 0;
  let guarded = 0;
  for (const row of list) {
    if (row.category === "resolvable") resolvable += 1;
    else guarded += 1;
  }
  const checked = list.filter((row) => row.checked).length;
  return `解消可 ${resolvable}件 / 保護 ${guarded}件 — 選択中 ${checked}件`;
}

// Prev/Next のインデックス計算（純関数・テスト対象）。Issue #52:
// ナビは category === "resolvable"（解消可）の行だけに飛ぶ。確認が必要な箇所だけを
// 高速に回るためで、クリック選択・↑↓（再生/チェック）は従来どおり全行対象。
// - 現在位置 current から delta 方向の**次の解消可行**の index を返す
// - 未選択(-1)・範囲外からの next は先頭側、prev は末尾側の解消可へ入る（旧 stepIndex と同じ流儀）
// - その方向に解消可が無ければ -1（端で止まる。ラップしない）。解消可0件なら常に -1 = 無反応
// - 分類未導出（「不明」）は保護扱いでスキップ（#45 と整合: echo 後に解消可へ復活する）
export function stepResolvableIndex(rows, current, delta) {
  const list = rows || [];
  const cur = Number.isInteger(current) && current >= 0 && current < list.length ? current : -1;
  if (delta > 0) {
    for (let i = cur + 1; i < list.length; i += 1) {
      if (list[i]?.category === "resolvable") return i;
    }
    return -1;
  }
  for (let i = cur === -1 ? list.length - 1 : cur - 1; i >= 0; i -= 1) {
    if (list[i]?.category === "resolvable") return i;
  }
  return -1;
}

// 被り一覧フォーカス時のキー → アクション対応（純関数・テスト対象）。Issue #20。
// A/D/W/S は矢印キーの別名（矢印キーが遠い・無い環境向け）。
// S はグローバル（interactions の document keydown）では「再生ヘッド位置で分割」だが、
// 一覧フォーカス中はこちらが勝つ（呼び出し側の stopPropagation で分割を抑止）。
// 割り当て外は null を返し、グローバルキー（Space=再生/停止 等）を奪わない。
export function overlapKeyAction(key) {
  switch (key) {
    case "ArrowLeft":
    case "a":
    case "A":
      return "prev";
    case "ArrowRight":
    case "d":
    case "D":
      return "next";
    case "ArrowUp":
    case "w":
    case "W":
      return "play";
    case "ArrowDown":
    case "s":
    case "S":
      return "toggle";
    default:
      return null;
  }
}

// overlaps + 既存選択 → 描画用の行データ（純関数・テスト対象）。
//
// seeded=false（プロジェクト世代の初回描画）: 全行に既定チェックを適用する。
// seeded=true（編集後の再描画）: 既に見たペアはユーザーの選択を尊重し、
//   **初めて現れたペア**（編集で新しく生まれた被り）だけ既定チェックを適用する。
//   ここで一律 selected.has(key) にすると、新規の被りが常に未チェックで現れて
//   「解消可なのに適用されない」取りこぼしになる。
// seen は「既定チェックの判断を確定済みのペア」の集合。
//
// ペアキー永続の2原則（Issue #45。破ると頭出し・分割でチェックが全て外れる）:
// - 返り値の nextSelected / nextSeen は**現存ペアに絞らない**（selected/seen を包含）。
//   頭出しのオーバーシュート→戻し等でペアが一時的に消えても記録を保持し、
//   復活時にユーザーの選択を復元する（消えたままのペアの記録は project-set で消える）。
// - category 未導出（ローカルスイープ直後・サーバ echo 前）の初見ペアは seen に
//   **刻まない**。ここで刻むと echo で分類が届いても「既知・未選択」に固定され、
//   既定チェック（resolvable=ON）が一生効かなくなる。判断は分類が届いた描画まで保留する。
export function buildOverlapRows(overlaps, selected, seeded, seen = null) {
  const rows = [];
  const nextSelected = new Set(selected || []);
  const nextSeen = new Set(seen || []);
  for (const overlap of overlaps || []) {
    const key = pairKey(overlap.block_ids);
    const category = overlap.category ?? null;
    const known = seeded && seen !== null && seen.has(key);
    const checked = key === null
      ? false
      : known
        ? selected.has(key)
        : defaultChecked(overlap);
    if (key !== null) {
      if (known || category !== null) nextSeen.add(key);
      if (checked) nextSelected.add(key);
    }
    rows.push({ overlap, key, category, checked });
  }
  return { rows, nextSelected, nextSeen };
}

// ユーザーのチェック操作を選択集合へ反映する（純関数寄り・テスト対象。Set を直接更新）。
// seen にも必ず刻む: 分類未導出（「不明」表示中）の行をユーザーが操作した場合、
// ここで確定させないと echo 到着時の既定チェックがユーザーの意思を上書きしてしまう。
export function applySelection(selected, seen, key, checked) {
  if (!key) return false;
  seen.add(key);
  if (checked) selected.add(key);
  else selected.delete(key);
  return true;
}

// 分割等でブロックIDが変わったペアへチェック・既知記録を引き継ぐ（純関数・テスト対象）。
// Issue #45（43b5b09 の分類引き継ぎと同じ考え方をチェック状態に適用）:
// 初見ペアのうち「既知の旧ペアと片方のブロックIDを共有し、区間が交差する」ものは
// 旧ペアの判断（seen + 選択状態）を引き継ぐ。無関係な新規ペア（ID共有なし・区間
// 非交差）には波及させず、通常の既定チェック経路（buildOverlapRows）に委ねる。
// prevRows は直前描画の行データ（renderOverlaps が保持する overlapRows）。
export function carryOverlapSelection(prevRows, overlaps, selected, seen) {
  const nextSelected = new Set(selected || []);
  const nextSeen = new Set(seen || []);
  if (!prevRows || prevRows.length === 0) {
    return { selected: nextSelected, seen: nextSeen };
  }
  for (const overlap of overlaps || []) {
    const key = pairKey(overlap.block_ids);
    if (key === null || nextSeen.has(key)) continue; // 既知ペアは引き継ぎ不要
    const ids = new Set(overlap.block_ids);
    for (const prev of prevRows) {
      if (!prev.key || prev.key === key || !nextSeen.has(prev.key)) continue;
      const sharesBlock = (prev.overlap.block_ids || []).some((id) => ids.has(id));
      const intersects = prev.overlap.start < overlap.end && overlap.start < prev.overlap.end;
      if (!sharesBlock || !intersects) continue;
      nextSeen.add(key);
      if (nextSelected.has(prev.key)) nextSelected.add(key);
      break;
    }
  }
  return { selected: nextSelected, seen: nextSeen };
}

// 選択中ペア → auto_edit の target_pairs（[[a,b], ...]）。純関数・テスト対象。
// **常に配列を返す**（undefined を返すと省略扱いで全件適用になる。BE1 申し送り3）。
export function toTargetPairs(rows) {
  const out = [];
  for (const row of rows || []) {
    if (row.checked && row.key) out.push(row.key.split("|"));
  }
  return out;
}

// autoEdit が読む公開API。プロジェクト非 ready でも常に配列を返す。
export function getSelectedTargetPairs() {
  return toTargetPairs(overlapRows);
}

function renderOverlaps() {
  const container = els.overlaps;
  const overlaps = state.project?.overlaps || [];
  els.overlapCount.textContent = String(overlaps.length);
  els.overlapCount.classList.toggle("alert", overlaps.length > 0);

  // 分割等のID変化ペアへ先にチェックを引き継いでから行を構築する（Issue #45）
  const carried = carryOverlapSelection(overlapRows, overlaps, selectedPairs, seenPairs);
  const built = buildOverlapRows(overlaps, carried.selected, selectionSeeded, carried.seen);
  overlapRows = built.rows;
  selectedPairs = built.nextSelected;
  seenPairs = built.nextSeen;
  if (overlaps.length > 0) selectionSeeded = true;
  if (cursorIndex >= overlapRows.length) cursorIndex = -1;

  renderOverlapSummary();
  updateOverlapNav();

  if (!state.project) {
    container.className = "list empty";
    container.textContent = "プロジェクトを取り込んでください";
    return;
  }
  if (overlaps.length === 0) {
    container.className = "list empty";
    container.textContent = "被りはありません";
    return;
  }
  container.className = "list";
  container.textContent = "";
  const frag = document.createDocumentFragment();
  overlapRows.forEach((row, index) => {
    frag.append(buildOverlapRowEl(row, index));
  });
  container.append(frag);
  highlightCursor(false); // 再描画では一覧をスクロールしない（編集のたびに視点が飛ぶのを防ぐ）
}

function buildOverlapRowEl(row, index) {
  const { overlap, key, category, checked } = row;
  const el = document.createElement("div");
  el.className = "list-row overlap-row";
  el.dataset.i = String(index);

  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "ov-check";
  box.checked = checked;
  box.disabled = key === null; // ペアが壊れている行は選択不可
  box.setAttribute(
    "aria-label",
    `${fmt(overlap.start)} の被りを自動解消の対象にする（${categoryInfo(category).label}）`,
  );
  box.addEventListener("click", (event) => event.stopPropagation()); // 行クリック(ジャンプ)と分離
  box.addEventListener("change", () => setRowChecked(index, box.checked));

  const label = document.createElement("span");
  label.className = "ov-time";
  label.textContent = `${fmt(overlap.start)} (${Number(overlap.duration).toFixed(2)}s)`;

  const info = categoryInfo(category);
  const chip = document.createElement("span");
  chip.className = info.className;
  chip.textContent = info.label;

  // 旧「未解決/解決済」チップ（.ov-status）は削除（2026-08）。外れるタイミングが無く
  // 分類チップ（解消可/相槌/長尺/同時）と機能が重複していた。
  el.append(box, label, chip);
  el.addEventListener("click", () => {
    cursorIndex = index;
    highlightCursor();
    jumpToOverlap(overlap);
  });
  return el;
}

function setRowChecked(index, checked) {
  const row = overlapRows[index];
  if (!row || !row.key) return;
  row.checked = checked;
  applySelection(selectedPairs, seenPairs, row.key, checked);
  renderOverlapSummary();
  emit("overlap-selection-changed"); // autoEdit がプレビューを無効化する
}

function setAllChecked(checked) {
  for (let i = 0; i < overlapRows.length; i += 1) {
    const row = overlapRows[i];
    if (!row.key) continue;
    row.checked = checked;
    applySelection(selectedPairs, seenPairs, row.key, checked);
  }
  for (const box of els.overlaps.querySelectorAll(".ov-check")) {
    if (!box.disabled) box.checked = checked;
  }
  renderOverlapSummary();
  emit("overlap-selection-changed");
}

function renderOverlapSummary() {
  if (els.overlapSummary) els.overlapSummary.textContent = formatOverlapSummary(overlapRows);
}

function updateOverlapNav() {
  const has = overlapRows.length > 0;
  // Issue #52: disabled は「その方向に解消可が無い」に追随（stepResolvableIndex と境界一致）。
  // 解消可0件なら両方 disabled — キー操作の無反応の理由が見た目で分かる。
  if (els.ovPrev) els.ovPrev.disabled = stepResolvableIndex(overlapRows, cursorIndex, -1) < 0;
  if (els.ovNext) els.ovNext.disabled = stepResolvableIndex(overlapRows, cursorIndex, 1) < 0;
  if (els.ovPosition) {
    els.ovPosition.textContent = has
      ? `${cursorIndex >= 0 ? cursorIndex + 1 : "–"} / ${overlapRows.length}`
      : "– / 0";
  }
  if (els.ovCheckAll) els.ovCheckAll.disabled = !has;
  if (els.ovUncheckAll) els.ovUncheckAll.disabled = !has;
}

// Prev/Next: カーソル移動 + 既存のクリック時挙動（ジャンプ）を再利用。
// Issue #52: 移動先は解消可の行のみ。無ければ何もしない（無反応 — 件数表示で状況が分かる）
function moveOverlapCursor(delta) {
  const next = stepResolvableIndex(overlapRows, cursorIndex, delta);
  if (next < 0) return;
  cursorIndex = next;
  highlightCursor();
  const row = overlapRows[next];
  if (row) jumpToOverlap(row.overlap);
}

// ↓ / S: カーソル行の適用チェックをトグル。モデル更新は setRowChecked に任せ、
// DOM のチェックボックス表示だけここで同期する（change イベント経由ではないため）。
function toggleCursorChecked() {
  const row = overlapRows[cursorIndex];
  if (!row || !row.key) return; // 未選択(-1) / 壊れたペアは何もしない
  const box = els.overlaps.querySelectorAll(".ov-check")[cursorIndex];
  if (box) box.checked = !row.checked;
  setRowChecked(cursorIndex, !row.checked);
}

// ↑ / W: カーソルの被り位置から再生（再生中でもその位置へ飛んで続行する。
// 選択追従の再生中ガードとは役割が違う「聴きたい」明示操作なので seek を直接使う）
function playCursorOverlap() {
  const row = overlapRows[cursorIndex];
  if (!row) return;
  player.seek(Math.max(0, row.overlap.start));
  player.play().catch(() => {});
}

// scroll=true は Prev/Next・行クリックなどユーザー操作起点のときだけ
// （再描画で毎回スクロールすると編集のたびに一覧の視点が動いてしまう）。
// スクロールは一覧コンテナ内に限定する（Issue #20 実機FB: scrollIntoView は
// ページ等の祖先も動かすため、縦が狭い環境で画面が勝手に下スクロールしていた）。
function highlightCursor(scroll = true) {
  const rowEls = els.overlaps.querySelectorAll(".overlap-row");
  rowEls.forEach((el, i) => el.classList.toggle("cursor", i === cursorIndex));
  const active = cursorIndex >= 0 ? rowEls[cursorIndex] : null;
  if (scroll && active) {
    const list = els.overlaps;
    const cRect = list.getBoundingClientRect();
    const rRect = active.getBoundingClientRect();
    const itemTop = rRect.top - cRect.top + list.scrollTop;
    const next = nearestScrollTop(list.scrollTop, list.clientHeight, itemTop, rRect.height);
    if (next !== list.scrollTop) list.scrollTop = next;
  }
  updateOverlapNav();
}

// 被り一覧クリック: タイムラインを中央スクロール + 後発（start が大きい側）ブロック選択 + フラッシュ
// + 停止中は被り区間の先頭へ再生ヘッドを追従させる（Issue #20。再生中ガードは player 側）
function jumpToOverlap(overlap) {
  waveform.scrollToTime(overlap.start, "center");
  const later = laterBlockOf(overlap);
  if (later) edits.selectBlock(later.id);
  player.seekToSelectionStart(overlap.start);
  waveform.flashRange(null, overlap.start, overlap.end);
}

function laterBlockOf(overlap) {
  const ids = new Set(overlap.block_ids || []);
  let later = null;
  for (const block of state.project?.blocks || []) {
    if (!ids.has(block.id)) continue;
    if (!later || block.start > later.start) later = block;
  }
  return later;
}

function renderSelected() {
  const node = els.selectedBlock;
  const block = (state.project?.blocks || []).find(
    (item) => item.id === state.selectedBlockId && !item.deleted,
  );
  if (!block) {
    node.textContent = "未選択";
    return;
  }
  node.textContent = `${block.speaker} ${block.id}  ${fmt(block.start)} - ${fmt(blockEnd(block))}  ${block.text || ""}`;
}

// ── 入力欄同期（project-set / blocks-changed / Undo後の §14 事故防止） ──

function syncTrackInputs() {
  const project = state.project;
  for (const sp of SPEAKERS) {
    const track = project?.tracks?.[sp];
    const gain = track ? track.gain_db || 0 : 0;
    const deesser = track ? track.deesser || 0 : 0;
    setInputValue(`[data-field="gain_db"][data-speaker="${sp}"]`, gain);
    setInputValue(`[data-field="deesser"][data-speaker="${sp}"]`, deesser);
    setInputValue(
      `[data-field="offset_seconds"][data-speaker="${sp}"]`,
      track ? Math.round((track.offset_seconds || 0) * 1000) : 0,
    );
    setOutputValue(sp, "gain_db", gain);
    setOutputValue(sp, "deesser", deesser);
    renderNormalizeStatus(sp);
  }
  syncLoudnormInputs();
}

// Issue #37: ラウドネス設定欄（プロジェクト共通。未設定は既定値 LOUDNORM_DEFAULTS で表示）。
// リセットボタンからも呼ぶため syncTrackInputs から独立させている。
function syncLoudnormInputs() {
  const settings = state.project?.settings;
  setInputValue("#targetLufs", Number(settings?.target_lufs ?? LOUDNORM_DEFAULTS.target_lufs));
  setInputValue("#truePeak", Number(settings?.true_peak ?? LOUDNORM_DEFAULTS.true_peak));
  setInputValue("#normTolerance", Number(settings?.tolerance ?? LOUDNORM_DEFAULTS.tolerance));
}

// ── L: ラウドネス正規化の状態表示 + 後がけ実行 ──────────
//
// 読むキーは tracks[speaker].loudness_normalized（トップレベル。BE2 契約1節）。
// loudness dict 内の同名キーは audio 層のマーカーで、フロントは参照しない。

// 正規化状態 → 表示文言（純関数・テスト対象）。
export function normalizeStatusLabel(track) {
  // 判定は normalized_wav（作業実体）基準。original_file は後がけのやり直し専用で、
  // 可搬エクスポートを原音なしで開いた場合に欠けうる（欠けても正規化済みの事実は残る）。
  if (!track || !track.normalized_wav) return "未取込";
  if (!track.loudness_normalized) return "未正規化";
  // Issue #44: 許容量スキップ（#37）は「正規化済み」と区別する。loudness.normalization_skipped
  // は audio 層のマーカー（normalize_loudnorm がスキップ時のみ立てる）で、計測値は
  // loudness.input.input_i（ffmpeg loudnorm JSON の文字列。例 "-16.30"）から取る。
  // 表示のみの変更 — done/todo クラス等の挙動は loudness_normalized 基準のまま変えない。
  if (track.loudness?.normalization_skipped) {
    const measured = Number(track.loudness?.input?.input_i);
    const detail = Number.isFinite(measured) ? `（計測 ${measured.toFixed(1)} LUFS）` : "";
    const suffix = track.original_file ? "" : "（元音源なし）";
    return `許容量内・スキップ${detail}${suffix}`;
  }
  return track.original_file ? "正規化済み" : "正規化済み（元音源なし）";
}

function renderNormalizeStatus(speaker) {
  const node = els[`normStatus${speaker}`];
  if (!node) return;
  const track = state.project?.tracks?.[speaker];
  const normalized = !!track?.loudness_normalized;
  node.textContent = normalizeStatusLabel(track);
  node.classList.toggle("done", normalized);
  node.classList.toggle("todo", !!track?.normalized_wav && !normalized);
}

// 後がけ正規化ジョブ。完了後は project を差し替え + ピーク/音声を取り直す
// （BE2 契約4節: blocks は不変だが normalized_wav とピークサイドカーは差し替わる）。
async function runNormalize(speaker) {
  // #57 QA: 他ジョブ（取込 / 文字起こし / エクスポート）進行中も弾く。正規化だけが
  // グローバルの在否を見ていなかったため、逆向きの多重起動も開いていた。
  if (isJobBusy() || !state.project || state.project.status !== "ready") return;
  const target = SPEAKERS.includes(speaker) ? [speaker] : SPEAKERS.slice();
  // Issue #57: 完了時に対象プロジェクトが閉じられて/切り替わっていたら文脈付きで通知する
  const jobProject = { id: state.project.id, name: state.project.name };
  beginJob(); // 正規化中は破棄（#54）・復元・取込を止める（"job-busy" で main も追随）
  updateReadyState();
  try {
    toastMsg(`Speaker ${target.join("/")} のラウドネス正規化を開始しました`);
    await persistence.runNormalize(target, currentLoudnormOptions());
    toastMsg(normalizeFinishToast(true, jobProject) || "ラウドネス正規化が完了しました");
  } catch (err) {
    toastMsg(
      normalizeFinishToast(false, jobProject, err.message) ||
        `ラウドネス正規化に失敗: ${err.message}`,
      8000,
    );
  } finally {
    endJob();
    updateReadyState();
  }
}

// Issue #57: 完了時点の状態で detached を判定する（同一プロジェクトが開いたまま完了した
// 場合は runNormalize の adoptServerProject が先に走りビューも最新 = 従来文言で足りる）。
function normalizeFinishToast(ok, jobProject, detail) {
  const detached = isJobDetached(jobProject.id, state.project?.id, projectViewClosed());
  return jobFinishMessage("normalize", ok, { projectName: jobProject.name, detached, detail });
}

// Issue #37: 後がけ正規化に載せるラウドネス詳細（純関数寄りに切り出し。POST /normalize の
// overrides として明示送信する。settings へも change 時に保存済みだが、デバウンス競合に
// 依存しないよう値そのものを送る。デフォルト値でも送ってよい = サーバ既定と同値なら挙動不変）
function currentLoudnormOptions() {
  const options = {};
  const truePeak = Number(els.truePeak?.value);
  if (Number.isFinite(truePeak)) options.true_peak = truePeak;
  const tolerance = Number(els.normTolerance?.value);
  if (Number.isFinite(tolerance)) options.tolerance = tolerance;
  return options;
}

// ── G: 書き出し結果（出力先フルパス + Finderで開く） ────

// エクスポート完了ジョブ → 表示用の結果（純関数・テスト対象）。
// output_dir が無い応答は null（パネルを出さない）。
export function exportResultOf(job) {
  const dir = job?.result?.output_dir;
  if (typeof dir !== "string" || !dir) return null;
  const files = Array.isArray(job.result.files) ? job.result.files.filter((f) => typeof f === "string") : [];
  return { dir, files };
}

// main が startExport 完了時に呼ぶ（トーストは消えるが、この表示はパネルに残す）。
export function showExportResult(job) {
  lastExport = exportResultOf(job);
  renderExportResult();
}

function renderExportResult() {
  if (!els.exportResult) return;
  if (!lastExport) {
    els.exportResult.hidden = true;
    return;
  }
  els.exportResult.hidden = false;
  if (els.exportPath) els.exportPath.textContent = lastExport.dir; // パスは textContent（XSS規律）
  if (els.revealExport) {
    els.revealExport.disabled = false;
    els.revealExport.title = lastExport.files.length
      ? `${lastExport.files.length} ファイル: ${lastExport.files.join(", ")}`
      : "出力フォルダを開く";
  }
}

async function revealExport() {
  if (!state.project || !lastExport) return;
  els.revealExport.disabled = true;
  try {
    await persistence.revealPath(lastExport.dir);
  } catch (err) {
    toastMsg(`フォルダを開けませんでした: ${err.message}`, 8000);
  } finally {
    els.revealExport.disabled = false;
  }
}

// ── 作業フォルダの常時表示（payload.workdir は応答時導出のフィールド） ──

function renderWorkdir() {
  if (!els.workdirInfo) return;
  const dir = state.project?.workdir;
  if (typeof dir !== "string" || !dir) {
    els.workdirInfo.hidden = true;
    return;
  }
  els.workdirInfo.hidden = false;
  if (els.workdirPath) els.workdirPath.textContent = dir; // パスは textContent（XSS規律）
}

async function revealWorkdir() {
  const dir = state.project?.workdir;
  if (!dir) return;
  els.revealWorkdir.disabled = true;
  try {
    await persistence.revealPath(dir);
  } catch (err) {
    toastMsg(`フォルダを開けませんでした: ${err.message}`, 8000);
  } finally {
    els.revealWorkdir.disabled = false;
  }
}

// スライダー横の現在値表示（<output data-out data-speaker>）。gain=dB / deesser=%
function setOutputValue(speaker, field, value) {
  const output = document.querySelector(`[data-out="${field}"][data-speaker="${speaker}"]`);
  if (!output) return;
  const v = Number(value) || 0;
  if (field === "gain_db") {
    output.textContent = `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
  } else if (field === "deesser") {
    output.textContent = `${Math.round(v * 100)}%`;
  } else {
    output.textContent = String(v);
  }
}

function setInputValue(selector, value) {
  const input = document.querySelector(selector);
  if (!input || input === document.activeElement) return; // 編集中の欄は上書きしない
  input.value = String(value);
}

function pushGains() {
  const project = state.project;
  if (!project) return;
  for (const sp of SPEAKERS) {
    player.setGainDb(sp, Number(project.tracks?.[sp]?.gain_db || 0));
  }
}

function updateUndoRedo() {
  els.undo.disabled = !canUndo();
  els.redo.disabled = !canRedo();
}

function updateReadout() {
  els.timeReadout.textContent = `${fmt(lastTick)} / ${fmt(timelineEnd())}`;
}

function updateReadyState() {
  const ready = !!state.project && state.project.status === "ready";
  const transportOk = ready && !playerDisabled;
  for (const el of [els.playPause, els.back5, els.forward5]) el.disabled = !transportOk;
  for (const el of [els.splitBlock, els.deleteBlock, els.insertGap, els.deleteGap]) {
    el.disabled = !ready;
  }
  for (const input of document.querySelectorAll("[data-field][data-speaker], [data-preview]")) {
    input.disabled = !ready;
  }
  // L: 後がけ正規化はジョブなので実行中は全ボタンを止める（多重起動ガード）
  for (const btn of document.querySelectorAll("[data-normalize]")) {
    const speaker = btn.dataset.normalize;
    const hasSource = !!state.project?.tracks?.[speaker]?.original_file;
    btn.disabled = !ready || isJobBusy() || !hasSource;
  }
}

// timelineEnd のローカル導出（panels → timelineModel の依存を増やさないため。
// 定義は getIndex().timelineEnd と同一: max(active block end)）。editVersion でメモ化。
function timelineEnd() {
  const project = state.project;
  if (!project) return 0;
  if (endCache.project === project && endCache.version === state.editVersion) {
    return endCache.value;
  }
  let end = 0;
  for (const block of project.blocks || []) {
    if (!block.deleted && blockDuration(block) > 0) {
      const e = blockEnd(block);
      if (e > end) end = e;
    }
  }
  endCache = { project, version: state.editVersion, value: end };
  return end;
}

// ── Before/After プレビュー（previewURL のクエリ形式は旧実装から踏襲） ──

function playPreviewFor(speaker, mode) {
  const project = state.project;
  if (!project) return;
  const track = project.tracks?.[speaker] || {};
  const start = player.getCurrentTime();
  const deesser = mode === "before" ? 0 : track.deesser || 0;
  const url =
    `/api/projects/${encodeURIComponent(project.id)}/preview/${speaker}` +
    `?start=${encodeURIComponent(start)}&duration=8` +
    `&gain_db=${encodeURIComponent(track.gain_db || 0)}&deesser=${encodeURIComponent(deesser)}`;
  player.playPreview(url).catch((err) => toastMsg(`プレビュー再生失敗: ${err.message}`, 8000));
}

// ── 保存インジケータ / ジョブ進捗 / toast ───────────────

function onSaveState(detail) {
  const saveState = detail?.state;
  const btn = els.saveButton;
  if (btn) {
    clearTimeout(saveLabelTimer);
    if (saveState === "saving") {
      btn.textContent = "保存中…";
    } else if (saveState === "saved") {
      btn.textContent = "保存 ✓";
      saveLabelTimer = setTimeout(() => {
        btn.textContent = "保存";
      }, 1500);
    } else {
      btn.textContent = "保存";
    }
  }
  if (saveState === "error") {
    toastMsg(`保存失敗: ${detail?.message || ""}`, 8000);
  }
}

// ── Issue #57: ジョブの文脈表示（プロジェクトを閉じても続くジョブに名前を出す） ──

// 「プロジェクトを閉じた」状態か = 取込オーバーレイがセットアップ表示中。
// 進捗モード（importSetup が hidden）は取込ジョブ自身の強制表示であって「閉じた」ではない。
// main の完了トーストも同じ判定を使う（詳細な閉じ状態フラグを増やさず DOM を正とする）。
export function projectViewClosed() {
  const overlay = document.getElementById("importOverlay");
  const setup = document.getElementById("importSetup");
  return !!(overlay && !overlay.hidden && setup && !setup.hidden);
}

// ジョブに文脈名（対象プロジェクト名）を添えるべきなら名前を、不要なら null を返す
// （純関数・テスト対象）。開いているプロジェクト自身のジョブは従来表示のまま = 冗長にしない。
// project_id を持たないジョブ（model_download）は常に null。
// project_name は persistence が job-progress に載せる（Issue #57。欠損時は汎用表現）。
export function jobContextName(job, currentProjectId, projectClosed) {
  if (!job || !job.project_id) return null;
  if (!projectClosed && job.project_id === currentProjectId) return null;
  return job.project_name || "別のプロジェクト";
}

// topbar ジョブチップの表示文言（純関数・テスト対象）。
// contextName あり: 「文字起こし中: 〈プロジェクト名〉 42%」（message は省く — チップ幅節約）
// なし（従来表示）: 「文字起こし 42% — message」
export function jobChipLabel(job, contextName) {
  const progress = Math.max(0, Math.min(1, Number(job?.progress) || 0));
  const pct = Math.round(progress * 100);
  const kindLabel = JOB_KIND_LABELS[job?.kind] || job?.kind || "ジョブ";
  if (contextName) return `${kindLabel}中: ${contextName} ${pct}%`;
  return `${kindLabel} ${pct}%${job?.message ? ` — ${job.message}` : ""}`;
}

// Issue #57: 採用（adoptServerProject → project-set）時に取込オーバーレイを畳んで
// 編集画面へ入れてよいか（純関数・テスト対象。判定は main が結線する）。
// 「閉じた状態（セットアップ表示中）でバックグラウンドジョブが完了したら編集画面へ
// 強制的に引き戻される」挙動の廃止がここ。#57 で並行編集構想を取り下げ「別プロジェクトを
// 開くときは中断する」方針にしたため、閉じている間の完了は**データだけ採用してビューは
// 動かさない**（次に開いたとき最新が見える + 完了トーストの「開き直すと反映されています」
// が文言どおりになる）。開いたまま待った場合の完了リフレッシュは viewClosed=false 側で従来どおり。
// - closable=false（未 ready / 取込ジョブ進行中）はそもそも畳めない
// - viewClosed=true（= 背後で走ったジョブの完了）は畳まない
//
// #57 QA（High）で「意図フラグ」方式を撤去した: 採用イベントは*誰の採用か*を持たないため、
// 「ユーザーが開こうとしている最中」を module 変数で表すと、その await 中に完了した無関係な
// ジョブの採用が意図に便乗して畳んでしまう（= 廃止したはずの引き戻しの復活）。入れ子の
// 復元でも共有フラグが先に解除される。よって**採用経路からは意図の概念を外し**、ユーザー
// 要求の「開く」は shouldCloseOverlayAfterOpen（open 呼び出しの成功が畳みのトリガ）で扱う。
export function shouldCloseOverlayOnAdopt({ closable, viewClosed } = {}) {
  if (!closable) return false;
  return !viewClosed;
}

// Issue #57 QA(High): ユーザー要求の「開く」経路（復元 / 再開 / 取込完了）で、その
// **open 呼び出し自身の成功**を根拠にオーバーレイを畳んでよいか（純関数・テスト対象）。
// 採用イベント（project-set）を待たずここで判定するのが要点:
// - opened=false（open が throw・キャンセル）なら畳まない = 失敗して編集画面に引き戻されない
// - closable=false（未 ready / 取込ジョブ進行中）は畳めない（overlayClosable と同じ規律）
// - 背後のジョブ完了はこの関数を呼ばない = 他人の意図に便乗できない（欠陥1）
// - 呼び出しごとに独立した判定なので入れ子・重複でも互いを打ち消さない（欠陥2）
export function shouldCloseOverlayAfterOpen({ closable, opened } = {}) {
  return !!closable && !!opened;
}

// ジョブの対象プロジェクトが「開かれていない」か（純関数・テスト対象）。
// 閉じた（オーバーレイ表示中）か、別プロジェクトに切り替わっていたら true。
// jobProjectId が無い（model_download・起票失敗）は常に false = 従来トーストのまま。
export function isJobDetached(jobProjectId, currentProjectId, projectClosed) {
  if (!jobProjectId) return false;
  return !!projectClosed || jobProjectId !== currentProjectId;
}

// ジョブ完了・失敗トーストの文脈付き文言（純関数・テスト対象）。
// detached でなければ null = 呼び出し側の従来文言のまま（挙動不変）。
// export は成果物がディスクに出ており「開き直すと反映」が当たらないため detail（出力先）を添える。
export function jobFinishMessage(kind, ok, { projectName, detached, detail } = {}) {
  if (!detached) return null;
  const label = JOB_KIND_LABELS[kind] || kind || "ジョブ";
  const name = projectName || "プロジェクト";
  if (!ok) return `「${name}」の${label}が失敗しました${detail ? `: ${detail}` : ""}`;
  if (kind === "export") {
    return `「${name}」のエクスポートが完了しました${detail ? `: ${detail}` : ""}`;
  }
  return `「${name}」の${label}が完了しました。開き直すと反映されています`;
}

function onJobProgress(job) {
  if (!els.jobProgress) return;
  if (!job || job.status !== "running") {
    els.jobProgress.hidden = true;
    return;
  }
  const progress = Math.max(0, Math.min(1, Number(job.progress) || 0));
  els.jobProgress.hidden = false;
  if (els.jobBar) els.jobBar.value = progress;
  if (els.jobLabel) {
    // Issue #57: 閉じた/切り替えたプロジェクトのジョブには対象プロジェクト名を添える
    const contextName = jobContextName(job, state.project?.id, projectViewClosed());
    els.jobLabel.textContent = jobChipLabel(job, contextName);
  }
}

function toastMsg(message, timeout = 4200) {
  const node = els?.toast;
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, timeout);
}

function askDuration(defaultValue = "1.0") {
  const value = window.prompt("秒数", defaultValue);
  if (value === null) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    toastMsg("正の秒数を入力してください");
    return null;
  }
  return seconds;
}
