import test from "node:test";
import assert from "node:assert/strict";

import {
  getIndex,
  visibleBlocks,
  findBlockAt,
  computeGapAt,
  computeSnap,
} from "../../src/podcast_prep/static/js/timelineModel.js";
import { makeBlock } from "./helpers.mjs";

function indexOf(blocks) {
  return getIndex({ blocks, transcripts: [] }, Math.random());
}

test("visibleBlocks: カリング（長尺ブロックはmaxDur境界で拾う）", () => {
  const blocks = [
    makeBlock("a-long", "A", 0, 100, 0), // 0..100
    makeBlock("a-1", "A", 200, 201, 55), // 55..56
    makeBlock("a-2", "A", 210, 211, 70), // 70..71
    makeBlock("a-3", "A", 220, 221, 300), // 可視範囲外
  ];
  const index = indexOf(blocks);
  const vis = visibleBlocks(index, "A", 50, 60);
  assert.deepEqual(vis.map((b) => b.id), ["a-long", "a-1"]);
});

test("visibleBlocks: 境界（start==t1は除外・end==t0は除外）", () => {
  const blocks = [
    makeBlock("a-1", "A", 0, 2, 8), // 8..10 → end==t0 除外
    makeBlock("a-2", "A", 10, 12, 10), // 10..12 可視
    makeBlock("a-3", "A", 20, 21, 20), // start==t1 除外
  ];
  const index = indexOf(blocks);
  assert.deepEqual(visibleBlocks(index, "A", 10, 20).map((b) => b.id), ["a-2"]);
});

test("findBlockAt: 含有は start<=t<end・重なりはstart最大が最前面", () => {
  const blocks = [
    makeBlock("a-under", "A", 0, 10, 5), // 5..15
    makeBlock("a-over", "A", 20, 22, 8), // 8..10（後発=最前面）
  ];
  const index = indexOf(blocks);
  assert.equal(findBlockAt(index, "A", 9), blocks[1]);
  assert.equal(findBlockAt(index, "A", 11), blocks[0]); // a-overは10で終わる
  assert.equal(findBlockAt(index, "A", 5), blocks[0]); // t==start 含む
  assert.equal(findBlockAt(index, "A", 15), null); // t==end 含まない
  assert.equal(findBlockAt(index, "A", 4.9), null);
  assert.equal(findBlockAt(index, "B", 9), null);
});

test("computeGapAt: 話者組合せ・被り時null・境界", () => {
  // A: 1..3, 5..8 / B: 2..6, 9..10
  const blocks = [
    makeBlock("a-1", "A", 0, 2, 1),
    makeBlock("a-2", "A", 10, 13, 5),
    makeBlock("b-1", "B", 20, 24, 2),
    makeBlock("b-2", "B", 30, 31, 9),
  ];
  const index = indexOf(blocks);
  assert.deepEqual(computeGapAt(index, 4, ["A"]), { gapStart: 3, gapEnd: 5 });
  assert.equal(computeGapAt(index, 4, ["A", "B"]), null); // Bのb-1が被る
  assert.deepEqual(computeGapAt(index, 8.5, ["A", "B"]), { gapStart: 8, gapEnd: 9 });
  assert.equal(computeGapAt(index, 8.5, ["A"]), null); // A後続なし → 詰め対象なし
  assert.deepEqual(computeGapAt(index, 0.5, ["A"]), { gapStart: 0, gapEnd: 1 });
  assert.deepEqual(computeGapAt(index, 0.5, ["A", "B"]), { gapStart: 0, gapEnd: 1 });
  assert.equal(computeGapAt(index, 2, ["A"]), null); // ブロック内
  assert.deepEqual(computeGapAt(index, 3, ["A"]), { gapStart: 3, gapEnd: 5 }); // t==end は空き
  assert.equal(computeGapAt(index, 5, ["A"]), null); // t==start はブロック上
  assert.equal(computeGapAt(index, 100, ["A", "B"]), null); // 全ブロック後
});

test("computeSnap: ブロック端/playhead/0への磁着と8px閾値境界", () => {
  const blocks = [makeBlock("a-1", "A", 0, 2, 10)]; // 10..12
  const index = indexOf(blocks);
  const px = 80; // threshold = 0.1s
  assert.equal(computeSnap(index, "A", 12.05, 1, px, null), 12); // 左端→ブロック右端
  assert.equal(computeSnap(index, "A", 8.95, 1, px, null), 9); // 右端→ブロック左端(10-1)
  assert.equal(computeSnap(index, "A", 12.2, 1, px, null), null); // 閾値外
  assert.equal(computeSnap(index, "A", 50.08, 1, px, 50), 50); // playhead
  assert.equal(computeSnap(index, "A", 0.06, 1, px, null), 0); // 0
  assert.equal(computeSnap(index, "A", 5, 1, px, null), null); // 候補なし
  // 閾値ちょうど（8px = 1s @ pxPerSec 8）は磁着する
  assert.equal(computeSnap(index, "A", 13, 1, 8, null), 12);
  // 等距離（左端→10 と 右端→12 が両方 d=0.5）は左端スナップ優先
  assert.equal(computeSnap(index, "A", 10.5, 1, 8, null), 10);
});

test("computeSnap: 最近傍優先・負のstartになる右端候補は除外", () => {
  const blocks = [
    makeBlock("a-1", "A", 0, 1, 10), // 端: 10, 11
    makeBlock("a-2", "A", 5, 6, 11.05), // 端: 11.05, 12.05
  ];
  const index = indexOf(blocks);
  // 11.02 は 11(d=0.02) と 11.05(d=0.03) の間 → 11 に磁着
  assert.equal(computeSnap(index, "A", 11.02, 2, 80, null), 11);
  // 右端スナップで start が負になる候補はスキップ（target 0 に dur 5 → start -5）
  assert.equal(computeSnap(index, "A", -4.95, 5, 80, null), null);
});
