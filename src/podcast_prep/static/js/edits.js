// edits.js — 編集フロー統一。ミューテーションの唯一の入口。
// commitEdit: pushHistory → mutate → recomputeOverlapsSweep → editVersion++
//             → emit("blocks-changed") → saveSoon() の固定順。
// DOM には触らない（node --test 対象）。失敗の提示（toast）は呼び出し側の責務で、
// 各関数は成功/失敗を戻り値で返す。
//
// 追加export:
//   undoEdit()/redoEdit() — history.undo/redo の後始末（overlaps再計算 + blocks-changed
//   emit + saveSoon + 消えた選択の解除）を一本化する。⌘Z（interactions）と
//   undo/redoボタン（panels）が同じ経路を通るために必要。

import { state, emit, on } from "./state.js";
import { round3 } from "./utils.js";
import * as model from "./timelineModel.js";
import { pushHistory, undo, redo } from "./history.js";
import { saveSoon } from "./persistence.js";

const TRACK_FIELDS = new Set(["gain_db", "deesser"]);

// splitSelectedAtPlayhead 用に再生ヘッド位置を追跡する。
// 依存図で edits → player は禁止のため playhead-tick イベント経由で受ける
// （player.seek は停止中でも tick を emit する）。
let playheadT = 0;
on("playhead-tick", (t) => {
  if (Number.isFinite(t)) playheadT = t;
});

function findBlock(blockId) {
  if (!blockId) return null;
  for (const block of state.project?.blocks || []) {
    if (block.id === blockId) return block;
  }
  return null;
}

// ── 統一契約（§6） ──────────────────────────────────────

export function commitEdit(mutate) {
  if (!state.project) return;
  pushHistory();
  mutate(state.project);
  model.recomputeOverlapsSweep(state.project);
  state.editVersion++;
  emit("blocks-changed");
  saveSoon();
}

// ── ブロック操作 ────────────────────────────────────────

// 確定移動（ドラッグ pointerup / 将来の数値入力）。実変更があったときのみ true。
// 無変更（スナップで元位置に戻った等）は履歴・PUT を発生させない。
export function moveBlock(blockId, newStart) {
  const block = findBlock(blockId);
  if (!block || block.deleted || !Number.isFinite(newStart)) return false;
  const target = Math.max(0, round3(newStart));
  if (target === block.start) return false;
  commitEdit((project) => model.moveBlock(project, blockId, target));
  return true;
}

// 分割 + 右ブロック選択。端50msガードに掛かる場合は null（履歴も積まない）。
export function splitAtTime(blockId, atTimeline) {
  const block = findBlock(blockId);
  if (!model.computePlayheadSplitGuard(block, atTimeline)) return null;
  let right = null;
  commitEdit((project) => {
    right = model.splitBlockAt(project, blockId, atTimeline);
  });
  if (right) selectBlock(right.id);
  return right;
}

export function splitSelectedAtPlayhead() {
  if (!state.selectedBlockId) return null;
  return splitAtTime(state.selectedBlockId, playheadT);
}

export function deleteSelected() {
  const block = findBlock(state.selectedBlockId);
  if (!block || block.deleted) return false;
  commitEdit((project) => model.softDeleteBlock(project, block.id));
  selectBlock(null);
  return true;
}

// ── ギャップ操作 ────────────────────────────────────────

export function insertGapAt(at, duration, speakers) {
  if (!state.project || !Number.isFinite(at) || !(duration > 0)) return false;
  commitEdit((project) => model.insertGap(project, at, duration, speakers));
  return true;
}

export function deleteGapAt(at, duration, speakers) {
  if (!state.project || !Number.isFinite(at) || !(duration > 0)) return false;
  commitEdit((project) => model.deleteGap(project, at, duration, speakers));
  return true;
}

// 右クリック「このギャップを詰める」: t を含む空き区間を全閉じ。
// 対象話者のブロックが t に被る／後続ブロックが無い場合は null。
// 成功時は閉じた {gapStart, gapEnd} を返す（メニュー表示・toast用）。
export function closeGapAt(t, speakers) {
  if (!state.project) return null;
  const index = model.getIndex(state.project, state.editVersion);
  const gap = model.computeGapAt(index, t, speakers);
  if (!gap) return null;
  commitEdit((project) =>
    model.deleteGap(project, gap.gapStart, gap.gapEnd - gap.gapStart, speakers),
  );
  return gap;
}

// ── トラック操作 ────────────────────────────────────────

// R2 頭出し（ドラッグ確定と数値入力の共通経路）。
// クランプ（最小 block.start + delta >= 0）は timelineModel 側のミューテータが行う。
// 戻り値 {offset, delta, clamped} / 対象なしは null。無変更要求は履歴を積まない。
export function applyTrackOffset(speaker, newOffsetSeconds) {
  const track = state.project?.tracks?.[speaker];
  if (!track || !Number.isFinite(newOffsetSeconds)) return null;
  const oldOffset = Number(track.offset_seconds || 0);
  if (Math.abs(newOffsetSeconds - oldOffset) < 5e-7) {
    return { offset: oldOffset, delta: 0, clamped: false };
  }
  let delta = 0;
  commitEdit((project) => {
    delta = model.applyTrackOffsetMut(project, speaker, newOffsetSeconds);
  });
  const offset = Number(track.offset_seconds || 0);
  return { offset, delta, clamped: Math.abs(offset - newOffsetSeconds) > 1e-6 };
}

// gain_db / deesser のみ（offset_seconds は applyTrackOffset 経由）。
// player.setGainDb 連動は依存図の都合で panels 側が行う（契約 §10.3 注記どおり）。
export function setTrackField(speaker, field, value) {
  const track = state.project?.tracks?.[speaker];
  if (!track || !TRACK_FIELDS.has(field)) return false;
  const v = Number(value);
  if (!Number.isFinite(v) || track[field] === v) return false;
  commitEdit((project) => {
    project.tracks[speaker][field] = v;
  });
  return true;
}

// ── 選択 ────────────────────────────────────────────────

export function selectBlock(blockIdOrNull) {
  const next = blockIdOrNull ?? null;
  if (state.selectedBlockId === next) return;
  state.selectedBlockId = next;
  emit("selection-changed");
}

// ── Undo / Redo（追加export） ───────────────────────────
// history.restore は blocks/tracksメタ書き戻し + editVersion++ のみ行う（スナップショットに
// overlaps は含まれない）ため、ここで overlaps 再計算・emit・保存を行う。

function restoreHistory(step) {
  if (!state.project || !step()) return false;
  model.recomputeOverlapsSweep(state.project);
  const selected = findBlock(state.selectedBlockId);
  if (state.selectedBlockId && (!selected || selected.deleted)) {
    selectBlock(null); // 分割Undo等で消えた/削除に戻ったブロックの選択を解除
  }
  emit("blocks-changed");
  saveSoon();
  return true;
}

export function undoEdit() {
  return restoreHistory(undo);
}

export function redoEdit() {
  return restoreHistory(redo);
}
