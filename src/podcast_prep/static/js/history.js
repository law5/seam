// history.js — 軽量スナップショットUndo/Redo。
// Snapshot = {blocks: structuredClone, tracks: {A,B: {gain_db, deesser, offset_seconds, label}}}。
// transcripts（編集不変）と peaks（project.jsonから追放済み）は含めない。上限20。
// name は含めない（契約§10.2からの意図的逸脱・QA指摘対応）: topbar リネームは
// commitEdit を通らず履歴に積まれないため、name を復元するとブロック編集の undo が
// 無関係なリネームを黙って巻き戻し、入力欄表示とモデル/保存内容が乖離する。
// リネームは undo 対象外と割り切る。
// undo/redo は blocks/tracksメタ書き戻し + editVersion++ のみ行う。
// emit("blocks-changed") と入力欄同期は main 結線（呼び出し側の責務）。

import { state } from "./state.js";

const MAX_HISTORY = 20;
const SPEAKERS = ["A", "B"];
const undoStack = [];
const redoStack = [];

function trackMeta(track) {
  return {
    gain_db: track?.gain_db ?? 0,
    deesser: track?.deesser ?? 0,
    offset_seconds: track?.offset_seconds ?? 0,
    label: track?.label ?? "",
  };
}

// テスト用にexport（内部形式。契約§10.2のSnapshotから name を除外 — 冒頭コメント参照）
export function _makeSnapshot(project) {
  return {
    blocks: structuredClone(project.blocks),
    tracks: {
      A: trackMeta(project.tracks?.A),
      B: trackMeta(project.tracks?.B),
    },
  };
}

function restore(snapshot) {
  const project = state.project;
  project.blocks = structuredClone(snapshot.blocks);
  for (const sp of SPEAKERS) {
    const track = project.tracks?.[sp];
    const meta = snapshot.tracks[sp];
    if (!track || !meta) continue;
    track.gain_db = meta.gain_db;
    track.deesser = meta.deesser;
    track.offset_seconds = meta.offset_seconds;
    track.label = meta.label;
  }
  state.editVersion++;
}

export function pushHistory() {
  if (!state.project) return;
  undoStack.push(_makeSnapshot(state.project));
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
}

export function undo() {
  if (!state.project || undoStack.length === 0) return false;
  redoStack.push(_makeSnapshot(state.project));
  restore(undoStack.pop());
  return true;
}

export function redo() {
  if (!state.project || redoStack.length === 0) return false;
  undoStack.push(_makeSnapshot(state.project));
  restore(redoStack.pop());
  return true;
}

export function canUndo() {
  return undoStack.length > 0;
}

export function canRedo() {
  return redoStack.length > 0;
}

// プロジェクト切替（project-set）時に main が呼ぶ
export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
}
