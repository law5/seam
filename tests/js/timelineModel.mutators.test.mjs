import test from "node:test";
import assert from "node:assert/strict";

import {
  moveBlock,
  splitBlockAt,
  softDeleteBlock,
  insertGap,
  deleteGap,
  applyTrackOffsetMut,
  computePlayheadSplitGuard,
} from "../../src/podcast_prep/static/js/timelineModel.js";
import { makeBlock } from "./helpers.mjs";

function sampleProject() {
  return {
    blocks: [
      makeBlock("a-1", "A", 0.0, 2.0, 0.5),
      makeBlock("a-2", "A", 3.0, 5.0, 4.0),
      makeBlock("a-del", "A", 6.0, 7.0, 9.0, { deleted: true }),
      makeBlock("b-1", "B", 1.0, 2.5, 2.0),
      makeBlock("b-2", "B", 4.0, 6.0, 8.0),
    ],
    tracks: {
      A: { speaker: "A", label: "A", gain_db: 0, deesser: 0, offset_seconds: 0, original_file: "a.mp3" },
      B: { speaker: "B", label: "B", gain_db: 0, deesser: 0, offset_seconds: 0, original_file: "b.mp3" },
    },
    transcripts: [],
    overlaps: [],
    settings: { min_overlap_s: 0.3 },
  };
}

function sourceMap(project) {
  return new Map(project.blocks.map((b) => [b.id, [b.source_start, b.source_end]]));
}

test("不変条件: move/insertGap/deleteGap/offset は source座標を一切変えない", () => {
  const project = sampleProject();
  const before = sourceMap(project);
  moveBlock(project, "a-1", 10.0);
  insertGap(project, 2.0, 1.5, ["A", "B"]);
  deleteGap(project, 0.0, 0.5, ["A"]);
  applyTrackOffsetMut(project, "B", 1.25);
  assert.deepStrictEqual(sourceMap(project), before);
});

test("moveBlock: round3・負値0クランプ・不明IDはfalse", () => {
  const project = sampleProject();
  assert.equal(moveBlock(project, "a-1", 12.3456789), true);
  assert.equal(project.blocks[0].start, 12.346);
  assert.equal(moveBlock(project, "a-1", -3), true);
  assert.equal(project.blocks[0].start, 0);
  assert.equal(moveBlock(project, "nope", 1), false);
});

test("splitBlockAt: source分割の整合・右は末尾追加・text空", () => {
  const project = sampleProject();
  const right = splitBlockAt(project, "a-1", 1.3); // a-1: start 0.5, end 2.5
  assert.ok(right);
  const left = project.blocks.find((b) => b.id === "a-1");
  assert.equal(left.source_end, 0.8); // 0.0 + (1.3 - 0.5)
  assert.equal(right.source_start, 0.8);
  assert.equal(right.source_end, 2.0);
  assert.equal(right.start, 1.3);
  assert.equal(right.speaker, "A");
  assert.equal(right.text, "");
  assert.equal(right.deleted, false);
  assert.equal(project.blocks[project.blocks.length - 1], right);
  assert.ok(right.id.startsWith("a-1-split-"));
});

test("splitBlockAt: 50msガード（端50ms以内は拒否）・deleted/不明IDはnull", () => {
  const project = sampleProject();
  // a-2: start 4.0, end 6.0
  assert.equal(splitBlockAt(project, "a-2", 4.049), null);
  assert.equal(splitBlockAt(project, "a-2", 4.05), null); // ちょうど50msは「以内」で拒否
  assert.equal(splitBlockAt(project, "a-2", 5.951), null);
  assert.ok(splitBlockAt(project, "a-2", 4.06));
  assert.equal(splitBlockAt(project, "a-del", 9.5), null);
  assert.equal(splitBlockAt(project, "nope", 1.0), null);
  assert.equal(splitBlockAt(project, "b-1", 100.0), null); // ブロック外
});

test("splitBlockAt: 同ms連打でもID一意（セッション内連番）", () => {
  const project = {
    blocks: [makeBlock("a-1", "A", 0.0, 100.0, 0.0)],
    tracks: {},
  };
  const ids = new Set(["a-1"]);
  let targetId = "a-1";
  for (let i = 0; i < 50; i++) {
    const right = splitBlockAt(project, targetId, 1.0 + i * 1.5);
    assert.ok(right, `split ${i}`);
    assert.ok(!ids.has(right.id), `ID重複: ${right.id}`);
    ids.add(right.id);
    targetId = right.id; // 右側をさらに分割し続ける（同一ms内で連番が効く）
  }
});

test("softDeleteBlock: tombstone・不明IDはfalse", () => {
  const project = sampleProject();
  assert.equal(softDeleteBlock(project, "b-1"), true);
  assert.equal(project.blocks.find((b) => b.id === "b-1").deleted, true);
  assert.equal(project.blocks.length, 5); // 物理削除しない
  assert.equal(softDeleteBlock(project, "nope"), false);
});

test("insertGap: start>=at のみ・deleted除外・話者フィルタ・round3", () => {
  const project = sampleProject();
  insertGap(project, 2.0, 1.0005, ["A"]);
  const byId = new Map(project.blocks.map((b) => [b.id, b]));
  assert.equal(byId.get("a-1").start, 0.5); // 2.0未満 → 不動
  assert.equal(byId.get("a-2").start, 5.001); // 4.0 + 1.0005 → round3
  assert.equal(byId.get("a-del").start, 9.0); // deleted → 不動
  assert.equal(byId.get("b-1").start, 2.0); // 話者B → 不動
  assert.equal(byId.get("b-2").start, 8.0);
});

test("insertGap: 境界 start==at はシフトする・空speakers配列はno-op", () => {
  const project = sampleProject();
  insertGap(project, 2.0, 0.5, ["B"]);
  assert.equal(project.blocks.find((b) => b.id === "b-1").start, 2.5); // == at
  const before = project.blocks.map((b) => b.start);
  insertGap(project, 0.0, 1.0, []);
  assert.deepEqual(project.blocks.map((b) => b.start), before);
});

test("deleteGap: start>=at+duration のみ左シフト", () => {
  const project = sampleProject();
  deleteGap(project, 2.0, 2.0, ["A", "B"]);
  const byId = new Map(project.blocks.map((b) => [b.id, b]));
  assert.equal(byId.get("a-1").start, 0.5); // < 4.0 → 不動
  assert.equal(byId.get("a-2").start, 2.0); // 4.0 - 2.0（== at+duration 境界もシフト）
  assert.equal(byId.get("b-1").start, 2.0); // < 4.0 → 不動
  assert.equal(byId.get("b-2").start, 6.0);
  assert.equal(byId.get("a-del").start, 9.0); // deleted → 不動
});

test("applyTrackOffsetMut: シフト・offset更新・deltaを返す", () => {
  const project = sampleProject();
  const delta = applyTrackOffsetMut(project, "A", 0.25);
  assert.equal(delta, 0.25);
  assert.equal(project.tracks.A.offset_seconds, 0.25);
  const byId = new Map(project.blocks.map((b) => [b.id, b]));
  assert.equal(byId.get("a-1").start, 0.75);
  assert.equal(byId.get("a-2").start, 4.25);
  assert.equal(byId.get("a-del").start, 9.0); // deletedはシフトしない
  assert.equal(byId.get("b-1").start, 2.0); // 他話者不動
});

test("applyTrackOffsetMut: 負方向クランプ（最小start+delta>=0）", () => {
  const project = sampleProject();
  const delta = applyTrackOffsetMut(project, "A", -3.0); // 最小start 0.5 → delta = -0.5 に制限
  assert.equal(delta, -0.5);
  assert.equal(project.tracks.A.offset_seconds, -0.5);
  const byId = new Map(project.blocks.map((b) => [b.id, b]));
  assert.equal(byId.get("a-1").start, 0);
  assert.equal(byId.get("a-2").start, 3.5);
});

test("applyTrackOffsetMut: ブロックなし話者はクランプなし・track欠損は0", () => {
  const project = sampleProject();
  project.blocks = project.blocks.filter((b) => b.speaker !== "B");
  const delta = applyTrackOffsetMut(project, "B", -2.5);
  assert.equal(delta, -2.5);
  assert.equal(project.tracks.B.offset_seconds, -2.5);
  assert.equal(applyTrackOffsetMut({ blocks: [], tracks: {} }, "A", 1.0), 0);
});

test("computePlayheadSplitGuard: 端50ms境界", () => {
  const block = makeBlock("a-1", "A", 0.0, 2.0, 4.0); // 4.0..6.0
  assert.equal(computePlayheadSplitGuard(block, 5.0), true);
  assert.equal(computePlayheadSplitGuard(block, 4.049), false);
  assert.equal(computePlayheadSplitGuard(block, 4.06), true);
  assert.equal(computePlayheadSplitGuard(block, 5.951), false);
  assert.equal(computePlayheadSplitGuard(block, 5.94), true);
  assert.equal(computePlayheadSplitGuard(block, 3.0), false); // ブロック外
  assert.equal(computePlayheadSplitGuard(block, 7.0), false);
  assert.equal(computePlayheadSplitGuard(null, 5.0), false);
  assert.equal(
    computePlayheadSplitGuard(makeBlock("d", "A", 0, 2, 4, { deleted: true }), 5.0),
    false,
  );
});
