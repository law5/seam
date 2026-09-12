import test from "node:test";
import assert from "node:assert/strict";

import {
  projectTimelineTranscripts,
  getIndex,
} from "../../src/podcast_prep/static/js/timelineModel.js";
import { loadFixture } from "./helpers.mjs";

function projectFrom(fx) {
  return { blocks: fx.blocks, transcripts: fx.transcripts, settings: {} };
}

test("ゴールデン: 移動後射影（順序逆転・部分クリップ・ブロック外除外）", () => {
  const fx = loadFixture("transcripts_moved.json");
  const rows = projectTimelineTranscripts(projectFrom(fx), 1);
  assert.deepStrictEqual(rows, fx.expected_segments);
});

test("ゴールデン: 分割跨ぎは複数行に割れる（行キー=id+blockId）", () => {
  const fx = loadFixture("transcripts_split.json");
  const rows = projectTimelineTranscripts(projectFrom(fx), 1);
  assert.deepStrictEqual(rows, fx.expected_segments);
  const spanRows = rows.filter((r) => r.id === "a-tr-1");
  assert.equal(spanRows.length, 2);
  assert.notEqual(spanRows[0].blockId, spanRows[1].blockId);
});

test("ゴールデン: deletedブロック上の行は消える", () => {
  const fx = loadFixture("transcripts_deleted.json");
  const rows = projectTimelineTranscripts(projectFrom(fx), 1);
  assert.deepStrictEqual(rows, fx.expected_segments);
  assert.ok(!rows.some((r) => r.blockId === "a-002"));
  assert.ok(!rows.some((r) => r.id === "a-tr-2"));
});

test("ゴールデン: words分配（3ブロック跨ぎ・最近傍割当・フォールバック・空白正規化）", () => {
  const fx = loadFixture("transcripts_words.json");
  const rows = projectTimelineTranscripts(projectFrom(fx), 1);
  assert.deepStrictEqual(rows, fx.expected_segments);

  // 実バグ形: 3ブロック跨ぎでも各行には自分の単語だけ（全行複製が直っている）
  const span = rows.filter((r) => r.id === "b-tr-1").map((r) => r.text);
  assert.deepStrictEqual(span, ["はいで", "で", "行ってみて"]);
  // 取りこぼし・二重割当ゼロ: 連結が元テキストに一致
  assert.equal(span.join(""), "はいでで行ってみて");

  // words無し旧データの跨ぎは先頭断片にのみ全文
  const fallback = rows.filter((r) => r.id === "b-tr-2").map((r) => r.text);
  assert.deepStrictEqual(fallback, ["words無しの旧データ跨ぎ", "", ""]);

  // 単一断片は segment.text をそのまま / 先頭空白つき words は正規化
  assert.deepStrictEqual(rows.filter((r) => r.id === "a-tr-1").map((r) => r.text), ["single block"]);
  assert.deepStrictEqual(rows.filter((r) => r.id === "a-tr-2").map((r) => r.text), ["hello", "world"]);
});

test("words分配: 境界跨ぎ単語は中点で所属決定（Python _word_fragment_index と同値）", () => {
  const project = {
    blocks: [
      { id: "a1", speaker: "A", source_start: 0.0, source_end: 2.0, start: 0.0, deleted: false },
      { id: "a2", speaker: "A", source_start: 2.0, source_end: 4.0, start: 10.0, deleted: false },
    ],
    transcripts: [
      {
        id: "t1", speaker: "A", source_start: 1.0, source_end: 3.0, text: "left right",
        words: [
          { start: 1.5, end: 2.25, text: " left" },  // 中点1.875 < 2.0 → 左
          { start: 1.9, end: 2.5, text: " right" },  // 中点2.2 >= 2.0 → 右
        ],
      },
    ],
    settings: {},
  };
  const rows = projectTimelineTranscripts(project, 1);
  assert.deepStrictEqual(rows.map((r) => r.text), ["left", "right"]);
});

test("ゴールデン: random200 の射影完全一致（(start,end,speaker)ソート含む）", () => {
  const fx = loadFixture("random200.json");
  const rows = projectTimelineTranscripts(projectFrom(fx), 1);
  assert.ok(rows.length > 100, "ランダムフィクスチャに十分な行数があること");
  assert.deepStrictEqual(rows, fx.expected_segments);
});

test("メモ化: 同一(project, editVersion)は同一参照、version更新で再計算", () => {
  const fx = loadFixture("transcripts_split.json");
  const project = projectFrom(fx);
  const first = projectTimelineTranscripts(project, 5);
  assert.equal(projectTimelineTranscripts(project, 5), first);
  const recomputed = projectTimelineTranscripts(project, 6);
  assert.notEqual(recomputed, first);
  assert.deepStrictEqual(recomputed, first);
});

test("transcripts空/プロジェクトnullは空配列", () => {
  assert.deepStrictEqual(projectTimelineTranscripts({ blocks: [], transcripts: [] }, 1), []);
  assert.deepStrictEqual(projectTimelineTranscripts(null, 2), []);
});

test("getIndex: ソート順・除外・maxDur・timelineEnd・メモ化", () => {
  const blocks = [
    { id: "a-2", speaker: "A", source_start: 10, source_end: 11, start: 5, deleted: false },
    { id: "a-1", speaker: "A", source_start: 0, source_end: 4, start: 5, deleted: false }, // 同start→source_startで整列
    { id: "a-3", speaker: "A", source_start: 20, source_end: 20, start: 0, deleted: false }, // zero-dur除外
    { id: "a-4", speaker: "A", source_start: 30, source_end: 31, start: 0, deleted: true }, // deleted除外
    { id: "b-1", speaker: "B", source_start: 0, source_end: 2, start: 100, deleted: false },
  ];
  const project = { blocks, transcripts: [] };
  const index = getIndex(project, 1);
  assert.deepEqual(index.byStart.A.map((b) => b.id), ["a-1", "a-2"]);
  assert.deepEqual(index.bySource.A.map((b) => b.id), ["a-1", "a-2"]);
  assert.equal(index.maxDur.A, 4);
  assert.equal(index.maxDur.B, 2);
  assert.equal(index.timelineEnd, 102); // b-1: 100 + 2
  assert.equal(getIndex(project, 1), index); // 単一スロットメモ
  assert.notEqual(getIndex(project, 2), index);
});
