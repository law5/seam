// interactions.js — タイムラインのポインタ/キーボード/コンテキストメニュー/M/S/ズーム操作。
// 座標→時刻は waveform.xToTime / hitTest に一元化（右クリック座標バグの根治）。
// ドラッグ中は waveform.setDragOverride の仮描画のみでモデル非破壊、確定時に edits.* を呼ぶ
// （履歴・保存・被り再計算は edits.commitEdit が面倒を見る）。
// #dragReadout の表示・文言は waveform.setDragOverride が担当するため、ここでは触らない。
// Ctrl/⌘+wheel ズームは waveform が所有済み（二重バインドしない）。
// ズーム系で結線するのは #zoom スライダーと #fitZoom（全体俯瞰）の2つ。
// #59 PR4: Seam Strip（#seamStrip）のクリックシークもここが結線する
// （時刻の解決は waveform.seamStripTimeAt、seek の呼び出しはこちら）。

import { state, emit, on } from "./state.js";
import { blockDuration } from "./utils.js";
import {
  getIndex,
  recomputeOverlapsSweep,
  computeSnap,
  computeGapAt,
  computePlayheadSplitGuard,
} from "./timelineModel.js";
import * as waveform from "./waveform.js";
import * as player from "./player.js";
import * as edits from "./edits.js";

// waveform.js 内の RULER_H / TRACK_H と同値（レイアウト変更時は両方を揃えること）
const RULER_H = 24;
const TRACK_H = 150;
const DRAG_THRESHOLD_PX = 4;
const SWEEP_THROTTLE_MS = 100; // ドラッグ中のローカルsweep = 10Hz
const SCRUB_THROTTLE_MS = 100;
const ZOOM_KEY_FACTOR = 1.25;
const GAP_TARGETS = [
  ["A", "(A)"],
  ["B", "(B)"],
  [null, "(両方)"],
];

let els = null;
let drag = null; // ドラッグ状態機械（mode: scrub | block-pending | block | offset-pending | offset | empty）
let userMute = { A: false, B: false };
let solo = null; // null | "A" | "B"
const msButtons = { mute: {}, solo: {} };

function toast(message, timeout) {
  emit("toast", { message, timeout });
}

function projectReady() {
  return !!state.project && state.project.status === "ready";
}

export function initInteractions() {
  els = {
    scroll: document.getElementById("tlScroll"),
    menu: document.getElementById("contextMenu"),
    zoom: document.getElementById("zoom"),
    fitZoom: document.getElementById("fitZoom"),
    seamStrip: document.getElementById("seamStrip"),
  };
  const scroll = els.scroll;
  scroll.addEventListener("pointerdown", onPointerDown);
  scroll.addEventListener("pointermove", onPointerMove);
  scroll.addEventListener("pointerup", onPointerUp);
  scroll.addEventListener("pointercancel", () => cancelDrag());
  scroll.addEventListener("dblclick", onDblClick);
  scroll.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onKeyDown);

  for (const btn of document.querySelectorAll("[data-mute]")) {
    msButtons.mute[btn.dataset.mute] = btn;
    btn.addEventListener("click", () => {
      userMute[btn.dataset.mute] = !userMute[btn.dataset.mute];
      applyMuteSolo();
    });
  }
  for (const btn of document.querySelectorAll("[data-solo]")) {
    msButtons.solo[btn.dataset.solo] = btn;
    btn.addEventListener("click", () => {
      solo = solo === btn.dataset.solo ? null : btn.dataset.solo;
      applyMuteSolo();
    });
  }
  if (els.zoom) {
    els.zoom.addEventListener("input", () => waveform.setZoom(Number(els.zoom.value)));
  }
  // 「全体」= フィットズームのトグル（Issue #21）。活性条件は #zoom スライダーと同じ常時活性
  // （プロジェクト未ロード時は timelineEnd=0 の空タイムラインにフィットするだけで無害）。
  // フィット中にもう一度押すと直前のズームへ復帰し再生ヘッドを中央へ（実機FB対応）。
  // ボタンの押下状態（aria-pressed）は zoom-changed でも同期する —
  // スライダー / Ctrl/⌘+wheel / ⌘± の通常ズーム操作によるフィット解除を拾うため。
  // フィット倍率が現在ズームと一致して zoom-changed が出ないケースはクリック直後の同期が拾う。
  if (els.fitZoom) {
    els.fitZoom.addEventListener("click", () => {
      waveform.fitToWindow();
      syncFitZoomButton();
    });
    on("zoom-changed", syncFitZoomButton);
  }

  // Seam Strip のクリックシーク（#59 PR4）。ドラッグ（スクラブ）は付けない —
  // スクラブはルーラーの役割で、transport の帯は「俯瞰から飛ぶ」ためのもの。
  // 契約 §5「waveform は player を import しない」を守るため、時刻の解決だけを
  // waveform.seamStripTimeAt に任せ、seek の呼び出しはここで行う
  // （ルーラー/空き領域のクリックが xToTime を外付けしているのと同じ構造）。
  if (els.seamStrip) {
    els.seamStrip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !projectReady()) return;
      const time = waveform.seamStripTimeAt(event.clientX);
      if (time === null) return;
      player.seek(Math.max(0, time));
      waveform.scrollToTime(time, "center"); // 飛んだ先を波形側にも見せる
    });
  }

  // 自モジュール内のUI状態リセット（player.preparePlayback も mute を初期化するため同期させる）
  on("project-set", () => {
    hideMenu();
    cancelDrag();
    userMute = { A: false, B: false };
    solo = null;
    applyMuteSolo();
    syncFitZoomButton(); // waveform 側の resetFitState（先に購読登録済み）を反映
  });
}

// 「全体」ボタンの押下表示（#21）。見た目は styles.css の #fitZoom[aria-pressed="true"]
function syncFitZoomButton() {
  if (!els || !els.fitZoom) return;
  els.fitZoom.setAttribute("aria-pressed", String(waveform.fitState.active));
}

// ── M/S（solo = 相手を mute。player は mute しか持たない契約） ──

function applyMuteSolo() {
  for (const sp of ["A", "B"]) {
    player.setTrackMute(sp, userMute[sp] || (solo !== null && solo !== sp));
    if (msButtons.mute[sp]) msButtons.mute[sp].classList.toggle("active", userMute[sp]);
    if (msButtons.solo[sp]) msButtons.solo[sp].classList.toggle("active", solo === sp);
  }
}

// ── ポインタ ────────────────────────────────────────────

// y座標の帯判定。hitTest の speaker=null がルーラーか帯外（スクロールバー等）かを区別する。
function yBand(clientY) {
  const rect = els.scroll.getBoundingClientRect();
  const y = clientY - rect.top;
  if (y < 0) return null;
  if (y < RULER_H) return "ruler";
  if (y < RULER_H + TRACK_H) return "A";
  if (y < RULER_H + TRACK_H * 2) return "B";
  return null;
}

function offsetInput(speaker) {
  return document.querySelector(`[data-field="offset_seconds"][data-speaker="${speaker}"]`);
}

// applyTrackOffsetMut と同じ述語（非削除・zero-duration 含む）での最小 start
function minStartOf(speaker) {
  let min = Infinity;
  for (const block of state.project?.blocks || []) {
    if (block.speaker === speaker && !block.deleted && block.start < min) min = block.start;
  }
  return min;
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  hideMenu();
  if (!projectReady()) return;
  const band = yBand(event.clientY);
  if (!band) return;
  const hit = waveform.hitTest(event.clientX, event.clientY);
  if (!hit) return;
  try {
    els.scroll.setPointerCapture(event.pointerId);
  } catch {
    /* no-op */
  }
  const base = { pointerId: event.pointerId, x0: event.clientX, lastSweepAt: 0 };

  if (band === "ruler") {
    // ルーラー: クリック=seek+選択解除、pointerdown中ドラッグでスクラブ
    drag = { ...base, mode: "scrub", lastSeekAt: performance.now() };
    edits.selectBlock(null);
    player.seek(Math.max(0, hit.time));
    return;
  }
  if (event.shiftKey) {
    // R2 頭出し: トラック帯のどこでも Shift+ドラッグ
    const track = state.project.tracks?.[band];
    drag = {
      ...base,
      mode: "offset-pending",
      speaker: band,
      baseOffset: Number(track?.offset_seconds || 0),
      minStart: minStartOf(band),
      delta: 0,
      clampToasted: false,
      input: offsetInput(band),
    };
    return;
  }
  if (hit.block) {
    // クリップ: 選択（playhead 追従はクリック確定時 = onPointerUp の block-pending。
    // 再生中は追従しない — 分割ワークフロー・聴きながらの選択を壊さない）
    edits.selectBlock(hit.block.id);
    drag = {
      ...base,
      mode: "block-pending",
      speaker: band,
      block: hit.block,
      grabOffset: hit.time - hit.block.start,
      tempStart: hit.block.start,
      time: hit.time, // クリック確定時の追従先（Issue #20 実機FB: クリック位置）
    };
    return;
  }
  // 空き領域: pointerup（移動なし）で seek + 選択解除
  drag = { ...base, mode: "empty", time: hit.time };
}

function onPointerMove(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const dx = event.clientX - drag.x0;

  if (drag.mode === "scrub") {
    const now = performance.now();
    if (now - drag.lastSeekAt < SCRUB_THROTTLE_MS) return;
    drag.lastSeekAt = now;
    player.seek(Math.max(0, waveform.xToTime(event.clientX)));
    return;
  }

  if (drag.mode === "block-pending") {
    if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    drag.mode = "block";
  }
  if (drag.mode === "block") {
    let proposed = Math.max(0, waveform.xToTime(event.clientX) - drag.grabOffset);
    if (!event.altKey) {
      // スナップ: 同トラック隣接ブロック端 / playhead / 0（8px閾値、Altで解除）
      const index = getIndex(state.project, state.editVersion);
      const snapped = computeSnap(
        index,
        drag.speaker,
        proposed,
        blockDuration(drag.block),
        state.zoom,
        player.getCurrentTime(),
      );
      if (snapped !== null && snapped !== undefined) proposed = Math.max(0, snapped);
    }
    drag.tempStart = proposed;
    waveform.setDragOverride({ type: "block", blockId: drag.block.id, tempStart: proposed });
    const now = performance.now();
    if (now - drag.lastSweepAt >= SWEEP_THROTTLE_MS) {
      drag.lastSweepAt = now;
      liveSweepWithTempStart(drag.block, proposed);
    }
    return;
  }

  if (drag.mode === "offset-pending") {
    if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    drag.mode = "offset";
  }
  if (drag.mode === "offset") {
    let delta = dx / state.zoom;
    if (Number.isFinite(drag.minStart) && drag.minStart + delta < 0) {
      delta = -drag.minStart; // 最小 block.start + delta >= 0 クランプ
      if (!drag.clampToasted) {
        drag.clampToasted = true;
        toast("先頭が 0 秒に到達しました。これ以上早められません（相手トラックを右にずらしてください）");
      }
    }
    drag.delta = delta;
    waveform.setDragOverride({ type: "offset", speaker: drag.speaker, delta });
    // settings-panel の ms 入力もライブ更新（§6）。確定値は blocks-changed 後に panels が同期する
    if (drag.input) drag.input.value = String(Math.round((drag.baseOffset + delta) * 1000));
  }
}

// ドラッグ中のライブ被り帯: 仮 start を一時適用して sweep → 元に戻す（モデル非破壊）。
// project.overlaps だけが仮位置の内容になり、waveform が描画に使う。
function liveSweepWithTempStart(block, tempStart) {
  const saved = block.start;
  block.start = tempStart;
  recomputeOverlapsSweep(state.project);
  block.start = saved;
  waveform.invalidate();
}

function onPointerUp(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;

  if (d.mode === "scrub") {
    player.seek(Math.max(0, waveform.xToTime(event.clientX)));
    return;
  }
  if (d.mode === "block") {
    waveform.setDragOverride(null);
    const committed = edits.moveBlock(d.block.id, d.tempStart);
    if (!committed && state.project) {
      // 元位置に戻った等の無変更確定: ライブsweepの仮被りを実座標へ戻す
      recomputeOverlapsSweep(state.project);
      waveform.invalidate();
    }
    return;
  }
  if (d.mode === "offset") {
    waveform.setDragOverride(null);
    if (Math.abs(d.delta) > 1e-6) {
      edits.applyTrackOffset(d.speaker, d.baseOffset + d.delta);
    } else if (d.input) {
      d.input.value = String(Math.round(d.baseOffset * 1000));
    }
    return;
  }
  if (d.mode === "empty" && Math.abs(event.clientX - d.x0) < DRAG_THRESHOLD_PX) {
    player.seek(Math.max(0, d.time));
    edits.selectBlock(null);
    return;
  }
  if (d.mode === "block-pending") {
    // クリック確定（ドラッグ非成立）: **クリック位置**へヘッドを追従させる
    // （Issue #20 実機FB。ブロック先頭へ寄せると「任意ブロックを選択し、ブロック内の
    //   任意ヘッド位置で S 分割」のワークフローが壊れる — クリックのたびに頭が先頭へ
    //   リセットされてしまう。再生中は player 側で無視。ドラッグ成立時はここに来ない
    //   = 追従しない。ダブルクリックは従来どおり onDblClick がクリック位置へ seek）
    player.seekToSelectionStart(d.time);
  }
  // offset-pending はクリック確定（何もしない）
}

function cancelDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  waveform.setDragOverride(null);
  if (d.mode === "block" && state.project) {
    recomputeOverlapsSweep(state.project);
    waveform.invalidate();
  } else if (d.mode === "offset" && d.input) {
    d.input.value = String(Math.round(d.baseOffset * 1000));
  }
}

function onDblClick(event) {
  if (!projectReady()) return;
  const hit = waveform.hitTest(event.clientX, event.clientY);
  if (hit && hit.block) {
    edits.selectBlock(hit.block.id);
    player.seek(Math.max(0, hit.time));
  }
}

// ── コンテキストメニュー（#contextMenu へ動的生成、textContent規律） ──

function onContextMenu(event) {
  if (!projectReady()) return;
  const band = yBand(event.clientY);
  if (!band) return;
  event.preventDefault();
  cancelDrag();
  const hit = waveform.hitTest(event.clientX, event.clientY);
  if (!hit) return;
  buildMenu(hit);
  showMenuAt(event.clientX, event.clientY);
}

function menuItem(label, onClick, disabled = false) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.disabled = disabled;
  btn.addEventListener("click", () => {
    hideMenu();
    onClick();
  });
  return btn;
}

function askDuration(defaultValue = "1.0") {
  const value = window.prompt("秒数", defaultValue);
  if (value === null) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    toast("正の秒数を入力してください");
    return null;
  }
  return seconds;
}

function buildMenu(hit) {
  const menu = els.menu;
  menu.replaceChildren();
  const time = hit.time;

  if (hit.block) {
    const block = hit.block;
    menu.append(
      menuItem(
        "この位置で分割",
        () => {
          if (!edits.splitAtTime(block.id, time)) toast("ブロック端から50ms以内では分割できません");
        },
        !computePlayheadSplitGuard(block, time),
      ),
      menuItem("ブロックを削除", () => {
        edits.selectBlock(block.id);
        edits.deleteSelected();
      }),
    );
  } else {
    // 空き領域: クリック時刻を含む両話者空き区間を自動算出（被りがあれば非表示）
    const index = getIndex(state.project, state.editVersion);
    const gap = computeGapAt(index, time, ["A", "B"]);
    if (gap) {
      const len = gap.gapEnd - gap.gapStart;
      menu.append(
        menuItem(`このギャップを詰める (${len.toFixed(1)}s)`, () => {
          if (!edits.closeGapAt(time, ["A", "B"])) toast("ギャップを詰められませんでした");
        }),
      );
    }
  }

  menu.append(
    menuItem("ここから再生", () => {
      player.seek(Math.max(0, time));
      player.play().catch(() => {});
    }),
  );
  for (const [sp, label] of GAP_TARGETS) {
    menu.append(
      menuItem(`ギャップ挿入 ${label}`, () => {
        const dur = askDuration("1.0");
        if (dur) edits.insertGapAt(time, dur, sp ? [sp] : ["A", "B"]);
      }),
    );
  }
  if (!hit.block) {
    // 既存UI互換の prompt 秒数指定削除（§6）
    for (const [sp, label] of GAP_TARGETS) {
      menu.append(
        menuItem(`ギャップ削除 ${label}`, () => {
          const dur = askDuration("1.0");
          if (dur) edits.deleteGapAt(time, dur, sp ? [sp] : ["A", "B"]);
        }),
      );
    }
  }
}

function showMenuAt(x, y) {
  const menu = els.menu;
  menu.hidden = false;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 8))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 8))}px`;
}

function hideMenu() {
  if (els && !els.menu.hidden) els.menu.hidden = true;
}

function onDocumentPointerDown(event) {
  if (!els || els.menu.hidden) return;
  if (!event.target.closest("#contextMenu")) hideMenu();
}

// ── キーボード（input/textarea/select 内は全無効） ──────

function isEditableTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function onKeyDown(event) {
  if (event.key === "Escape") {
    hideMenu();
    cancelDrag();
    return;
  }
  if (event.isComposing || isEditableTarget(event.target)) return;

  const meta = event.metaKey || event.ctrlKey;
  if (meta && (event.key === "z" || event.key === "Z")) {
    event.preventDefault();
    if (event.shiftKey) edits.redoEdit();
    else edits.undoEdit();
    return;
  }
  if (meta && (event.key === "y" || event.key === "Y")) {
    event.preventDefault();
    edits.redoEdit();
    return;
  }
  if (meta) return;

  switch (event.key) {
    case " ":
      event.preventDefault();
      player.toggle().catch(() => {});
      break;
    case "s":
    case "S":
      event.preventDefault();
      if (!edits.splitSelectedAtPlayhead()) {
        toast("分割できません（ブロックを選択し、再生ヘッドを端から50ms以上内側へ）");
      }
      break;
    case "Delete":
    case "Backspace":
      event.preventDefault();
      if (!edits.deleteSelected()) toast("削除するブロックを選択してください");
      break;
    case "ArrowLeft":
      event.preventDefault();
      player.seek(player.getCurrentTime() - 5);
      break;
    case "ArrowRight":
      event.preventDefault();
      player.seek(player.getCurrentTime() + 5);
      break;
    case "+":
    case "=":
      event.preventDefault();
      waveform.setZoom(state.zoom * ZOOM_KEY_FACTOR);
      break;
    case "-":
    case "_":
      event.preventDefault();
      waveform.setZoom(state.zoom / ZOOM_KEY_FACTOR);
      break;
    case "0":
      event.preventDefault();
      player.seek(0);
      break;
    default:
      break;
  }
}
