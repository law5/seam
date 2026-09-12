import test from "node:test";
import assert from "node:assert/strict";

import { recomputeOverlapsSweep } from "../../src/podcast_prep/static/js/timelineModel.js";
import { loadFixture, mulberry32, naiveOverlaps, randomProject, makeBlock } from "./helpers.mjs";

test("ゴールデン: overlaps_basic（deleted/zero-dur除外・境界・タイ順序・block_ids順）", () => {
  const fx = loadFixture("overlaps_basic.json");
  const project = { blocks: fx.blocks, settings: { min_overlap_s: fx.min_overlap_s } };
  assert.deepStrictEqual(recomputeOverlapsSweep(project), fx.expected_overlaps);
});

test("ゴールデン: overlaps_boundary（0.3境界のIEEE754実挙動がサーバと一致）", () => {
  const fx = loadFixture("overlaps_boundary.json");
  const project = { blocks: fx.blocks, settings: { min_overlap_s: fx.min_overlap_s } };
  const result = recomputeOverlapsSweep(project);
  assert.deepStrictEqual(result, fx.expected_overlaps);
  // 見かけ0.3ちょうど（100.5..100.8）は fp では 0.3 未満 → 除外されていることを固定
  assert.ok(!result.some((o) => o.block_ids[0] === "a-001" && o.block_ids[1] === "b-001"));
  // 0.7..1.0 は 0.30000000000000004 → 検出されていることを固定
  assert.ok(result.some((o) => o.block_ids[0] === "a-002" && o.block_ids[1] === "b-002"));
});

test("ゴールデン: random200 の overlaps 完全一致", () => {
  const fx = loadFixture("random200.json");
  const project = { blocks: fx.blocks, settings: { min_overlap_s: fx.min_overlap_s } };
  const result = recomputeOverlapsSweep(project);
  assert.ok(result.length > 0, "ランダムフィクスチャに被りが存在すること");
  assert.deepStrictEqual(result, fx.expected_overlaps);
});

test("project.overlaps を更新して同一配列を返す", () => {
  const project = {
    blocks: [
      makeBlock("a-1", "A", 0, 2, 0),
      makeBlock("b-1", "B", 0, 2, 1),
    ],
    overlaps: [],
    settings: { min_overlap_s: 0.3 },
  };
  const result = recomputeOverlapsSweep(project);
  assert.equal(project.overlaps, result);
  assert.equal(result.length, 1);
  assert.deepStrictEqual(result[0].block_ids, ["a-1", "b-1"]);
});

test("settings欠損時は min_overlap_s=0.3 フォールバック", () => {
  const project = {
    blocks: [
      makeBlock("a-1", "A", 0, 1, 0),
      makeBlock("b-1", "B", 10, 10.29, 0.5), // 0.29 < 0.3
      makeBlock("b-2", "B", 20, 21, 0.5), // 0.5 >= 0.3
    ],
  };
  const result = recomputeOverlapsSweep(project);
  assert.equal(result.length, 1);
  assert.deepStrictEqual(result[0].block_ids, ["a-1", "b-2"]);
});

test("プロパティ: sweep === ナイーブO(A×B)（ランダム・タイ多発・各種min）", () => {
  const mins = [0.3, 0, 0.05, 1.0];
  for (let seed = 1; seed <= 24; seed++) {
    const rand = mulberry32(seed * 7919);
    const minOv = mins[seed % mins.length];
    const n = 30 + Math.floor(rand() * 120);
    const project = randomProject(rand, n, { minOverlapS: minOv, quantize: seed % 2 === 0 });
    const expected = naiveOverlaps(project.blocks, minOv);
    const actual = recomputeOverlapsSweep(project);
    assert.deepStrictEqual(actual, expected, `seed=${seed} min=${minOv} n=${n}`);
  }
});

test("プロパティ: 2000ブロック規模でも一致（設計§13-1）", () => {
  const rand = mulberry32(20260731);
  const project = randomProject(rand, 1000, { minOverlapS: 0.3 });
  assert.deepStrictEqual(
    recomputeOverlapsSweep(project),
    naiveOverlaps(project.blocks, 0.3),
  );
});

test("min=0 で接触ブロック（duration 0）も一致（恒久スキップの境界）", () => {
  // a: [0,1)@0, b は a.end ちょうどに接触
  const project = {
    blocks: [
      makeBlock("a-1", "A", 0, 1, 0),
      makeBlock("b-1", "B", 10, 11, 1), // b.start == a.end → duration 0
      makeBlock("b-2", "B", 12, 13, 5),
    ],
    settings: { min_overlap_s: 0 },
  };
  assert.deepStrictEqual(
    recomputeOverlapsSweep(project),
    naiveOverlaps(project.blocks, 0),
  );
});

test("blocks空/片話者のみは空配列", () => {
  assert.deepStrictEqual(recomputeOverlapsSweep({ blocks: [], settings: {} }), []);
  assert.deepStrictEqual(
    recomputeOverlapsSweep({
      blocks: [makeBlock("a-1", "A", 0, 5, 0)],
      settings: {},
    }),
    [],
  );
});

// ── category 引き継ぎ（Issue #20 実機FB: 分類チップの「不明」退行防止） ──
// 分類はサーバ導出（server._project_payload）。ローカルスイープは同一ペア
// （block_ids）の旧被りから category を引き継ぎ、無いペアには発明しない。

test("category 引き継ぎ: 同一ペアは分類が生き残り、分類なしペアには付けない", () => {
  const project = {
    blocks: [
      makeBlock("a-1", "A", 0, 2, 0),
      makeBlock("b-1", "B", 10, 12, 1), // a-1 × b-1: [1,2)
      makeBlock("a-2", "A", 3, 5, 10),
      makeBlock("b-2", "B", 20, 22, 11), // a-2 × b-2: [11,12)
    ],
    overlaps: [
      { start: 1, end: 2, duration: 1, block_ids: ["a-1", "b-1"], category: "resolvable" },
      { start: 11, end: 12, duration: 1, block_ids: ["a-2", "b-2"] }, // 分類なし（サーバ未反映）
    ],
    settings: { min_overlap_s: 0.3 },
  };
  const result = recomputeOverlapsSweep(project);
  assert.equal(result.length, 2);
  assert.equal(result[0].category, "resolvable");
  assert.ok(!("category" in result[1]), "分類なしの旧被りに category を発明しない");
});

test("category 引き継ぎ: 時間シフト後（頭出し相当）も同一ペアなら分類が残る", () => {
  const project = {
    blocks: [
      makeBlock("a-1", "A", 0, 2, 0.5), // 頭出しで +0.5 シフト済みの想定
      makeBlock("b-1", "B", 10, 12, 1),
    ],
    overlaps: [
      // 旧座標（シフト前）の被り。ペアが同じなら座標が違っても引き継ぐ
      { start: 1, end: 2, duration: 1, block_ids: ["a-1", "b-1"], category: "contained" },
    ],
    settings: { min_overlap_s: 0.3 },
  };
  const result = recomputeOverlapsSweep(project);
  assert.equal(result.length, 1);
  assert.equal(result[0].category, "contained");
  assert.equal(result[0].start, 1); // 座標は現在の blocks から再計算される
});

test("category 引き継ぎ: 消えたペアの分類は残らない（新ペアは分類なし）", () => {
  const project = {
    blocks: [
      makeBlock("a-1", "A", 0, 2, 0),
      makeBlock("b-2", "B", 10, 12, 1), // 新ペア a-1 × b-2
    ],
    overlaps: [
      { start: 1, end: 2, duration: 1, block_ids: ["a-1", "b-1"], category: "resolvable" },
    ],
    settings: { min_overlap_s: 0.3 },
  };
  const result = recomputeOverlapsSweep(project);
  assert.equal(result.length, 1);
  assert.deepStrictEqual(result[0].block_ids, ["a-1", "b-2"]);
  assert.ok(!("category" in result[0]), "別ペアの分類を引き継がない");
});
