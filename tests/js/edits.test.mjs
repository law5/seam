// edits.js — commitEdit 統一契約とラッパー群のユニットテスト。
// state/history/persistence は実物を使う（persistence.saveSoon の PUT は node では
// 相対URL fetch が失敗するが saveSoon 内で握りつぶされる）。

import test from "node:test";
import assert from "node:assert/strict";

import { state, on, emit } from "../../src/podcast_prep/static/js/state.js";
import * as edits from "../../src/podcast_prep/static/js/edits.js";
import {
  canUndo,
  canRedo,
  clearHistory,
} from "../../src/podcast_prep/static/js/history.js";
import { makeBlock } from "./helpers.mjs";

function freshProject() {
  return {
    id: "p1",
    name: "test",
    status: "ready",
    settings: { min_overlap_s: 0.3 },
    tracks: {
      A: { speaker: "A", label: "A", gain_db: 0, deesser: 0, offset_seconds: 0 },
      B: { speaker: "B", label: "B", gain_db: 0, deesser: 0, offset_seconds: 0 },
    },
    blocks: [
      makeBlock("a1", "A", 0, 2, 0),
      makeBlock("a2", "A", 10, 12, 5),
      makeBlock("b1", "B", 20, 22, 10),
    ],
    transcripts: [],
    overlaps: [],
  };
}

function setup() {
  state.project = freshProject();
  state.selectedBlockId = null;
  state.editVersion = 0;
  clearHistory();
}

function findBlock(id) {
  return state.project.blocks.find((b) => b.id === id);
}

function countEvents(name, fn) {
  let count = 0;
  const off = on(name, () => {
    count += 1;
  });
  try {
    fn();
  } finally {
    off();
  }
  return count;
}

test("commitEdit: pushHistory→mutate→sweep→editVersion++→blocks-changed→saveSoon の固定順", () => {
  setup();
  const events = countEvents("blocks-changed", () => {
    edits.commitEdit((project) => {
      project.blocks[0].start = 9.5; // a1 [9.5,11.5] × b1 [10,12] → 被り [10,11.5]
    });
  });
  assert.equal(events, 1);
  assert.equal(state.editVersion, 1);
  assert.equal(canUndo(), true);
  assert.equal(state.project.overlaps.length, 1);
  assert.equal(state.project.overlaps[0].start, 10);
  assert.equal(state.project.overlaps[0].end, 11.5);
  assert.deepEqual(state.project.overlaps[0].block_ids, ["a1", "b1"]);
});

test("commitEdit: project が無ければ mutate も呼ばれない", () => {
  setup();
  state.project = null;
  let called = false;
  edits.commitEdit(() => {
    called = true;
  });
  assert.equal(called, false);
});

test("moveBlock: round3+負クランプで確定し、無変更なら履歴を積まない", () => {
  setup();
  assert.equal(edits.moveBlock("a1", 1.23456), true);
  assert.equal(findBlock("a1").start, 1.235);
  assert.equal(state.editVersion, 1);

  // 同値への移動は no-op（履歴・editVersion 不変）
  assert.equal(edits.moveBlock("a1", 1.235), false);
  assert.equal(state.editVersion, 1);

  // 負値は 0 クランプ
  assert.equal(edits.moveBlock("a1", -3), true);
  assert.equal(findBlock("a1").start, 0);

  assert.equal(edits.moveBlock("nope", 1), false);
});

test("splitAtTime: 端50msガードで拒否・成功時は右ブロック選択", () => {
  setup();
  // 端から50ms以内は拒否（履歴なし）
  assert.equal(edits.splitAtTime("a1", 0.03), null);
  assert.equal(edits.splitAtTime("a1", 1.97), null);
  assert.equal(canUndo(), false);

  const right = edits.splitAtTime("a1", 1.0);
  assert.ok(right);
  assert.equal(findBlock("a1").source_end, 1.0);
  assert.equal(right.source_start, 1.0);
  assert.equal(right.start, 1.0);
  assert.equal(state.selectedBlockId, right.id);
  assert.equal(state.project.blocks.length, 4);
  assert.equal(canUndo(), true);
});

test("splitSelectedAtPlayhead: playhead-tick で追跡した位置で分割する", () => {
  setup();
  assert.equal(edits.splitSelectedAtPlayhead(), null); // 未選択
  edits.selectBlock("a1");
  emit("playhead-tick", 1.2);
  const right = edits.splitSelectedAtPlayhead();
  assert.ok(right);
  assert.equal(right.start, 1.2);
  emit("playhead-tick", 0); // 後続テストへの影響を戻す
});

test("deleteSelected: ソフト削除+選択解除", () => {
  setup();
  edits.selectBlock("a2");
  assert.equal(edits.deleteSelected(), true);
  assert.equal(findBlock("a2").deleted, true);
  assert.equal(state.selectedBlockId, null);
  assert.equal(edits.deleteSelected(), false); // 選択なし
});

test("insertGapAt / deleteGapAt: 旧実装と同じシフト意味論と入力検証", () => {
  setup();
  assert.equal(edits.insertGapAt(4, 2, ["A"]), true);
  assert.equal(findBlock("a1").start, 0); // start < at は不動
  assert.equal(findBlock("a2").start, 7); // 5 >= 4 → +2
  assert.equal(findBlock("b1").start, 10); // 話者B対象外

  assert.equal(edits.deleteGapAt(0, 2, ["A", "B"]), true);
  assert.equal(findBlock("a2").start, 5); // 7 >= 2 → -2
  assert.equal(findBlock("b1").start, 8);
  assert.equal(findBlock("a1").start, 0); // 0 < 0+2 → 不動

  assert.equal(edits.insertGapAt(0, 0, ["A"]), false);
  assert.equal(edits.insertGapAt(0, -1, ["A"]), false);
  assert.equal(edits.deleteGapAt(0, Number.NaN, ["A"]), false);
});

test("closeGapAt: t を含む両話者空き区間を全閉じ・被り時は null", () => {
  setup();
  // A: [0,2],[5,7] / B: [10,12] → t=3 のギャップは [2,5]
  const gap = edits.closeGapAt(3, ["A", "B"]);
  assert.deepEqual(gap, { gapStart: 2, gapEnd: 5 });
  assert.equal(findBlock("a2").start, 2); // 5-3
  assert.equal(findBlock("b1").start, 7); // 10-3

  assert.equal(edits.closeGapAt(1, ["A", "B"]), null); // a1 が被る
});

test("applyTrackOffset: ミューテータのクランプ結果を返し、無変更要求は履歴を積まない", () => {
  setup();
  const result = edits.applyTrackOffset("B", -11); // B の最小 start=10 → delta は -10 でクランプ
  assert.ok(result);
  assert.equal(result.clamped, true);
  assert.equal(result.delta, -10);
  assert.equal(result.offset, -10);
  assert.equal(findBlock("b1").start, 0);
  assert.equal(state.editVersion, 1);

  // 現在値と同じ要求は no-op
  const noop = edits.applyTrackOffset("B", -10);
  assert.deepEqual(noop, { offset: -10, delta: 0, clamped: false });
  assert.equal(state.editVersion, 1);

  assert.equal(edits.applyTrackOffset("C", 1), null);
});

test("setTrackField: gain_db/deesser のみ・同値は no-op", () => {
  setup();
  assert.equal(edits.setTrackField("A", "gain_db", -6), true);
  assert.equal(state.project.tracks.A.gain_db, -6);
  assert.equal(state.editVersion, 1);
  assert.equal(edits.setTrackField("A", "gain_db", -6), false);
  assert.equal(state.editVersion, 1);
  assert.equal(edits.setTrackField("A", "offset_seconds", 1), false); // 対象外フィールド
  assert.equal(edits.setTrackField("A", "gain_db", "abc"), false);
});

test("selectBlock: 変更時のみ selection-changed を emit", () => {
  setup();
  let events = 0;
  const off = on("selection-changed", () => {
    events += 1;
  });
  edits.selectBlock("a1");
  edits.selectBlock("a1"); // 同一 → emit なし
  edits.selectBlock(null);
  off();
  assert.equal(events, 2);
});

test("undoEdit/redoEdit: blocks/tracksメタ復元 + overlaps再計算 + blocks-changed", () => {
  setup();
  edits.moveBlock("a1", 9.5); // 被り1件になる
  assert.equal(state.project.overlaps.length, 1);
  edits.setTrackField("A", "gain_db", -6);

  let events = 0;
  const off = on("blocks-changed", () => {
    events += 1;
  });
  assert.equal(edits.undoEdit(), true); // gain 戻し
  assert.equal(state.project.tracks.A.gain_db, 0);
  assert.equal(edits.undoEdit(), true); // 移動戻し
  assert.equal(findBlock("a1").start, 0);
  assert.equal(state.project.overlaps.length, 0); // スナップショット外の overlaps も再導出される
  assert.equal(edits.undoEdit(), false); // 履歴なし
  assert.equal(canRedo(), true);

  assert.equal(edits.redoEdit(), true);
  assert.equal(findBlock("a1").start, 9.5);
  assert.equal(state.project.overlaps.length, 1);
  assert.equal(edits.redoEdit(), true);
  assert.equal(state.project.tracks.A.gain_db, -6);
  off();
  assert.equal(events, 4);
});

test("undoEdit: 分割Undoで消えたブロックの選択を解除する", () => {
  setup();
  const right = edits.splitAtTime("a1", 1.0);
  assert.equal(state.selectedBlockId, right.id);
  assert.equal(edits.undoEdit(), true);
  assert.equal(state.selectedBlockId, null);
  assert.equal(state.project.blocks.length, 3);
});
