import test from "node:test";
import assert from "node:assert/strict";

import { state, on } from "../../src/podcast_prep/static/js/state.js";
import {
  pushHistory,
  undo,
  redo,
  canUndo,
  canRedo,
  clearHistory,
  _makeSnapshot,
} from "../../src/podcast_prep/static/js/history.js";
import { makeBlock } from "./helpers.mjs";

function freshProject() {
  return {
    id: "p1",
    name: "test project",
    blocks: [
      makeBlock("a-1", "A", 0.0, 2.0, 0.5),
      makeBlock("b-1", "B", 1.0, 2.5, 2.0),
    ],
    tracks: {
      A: {
        speaker: "A",
        label: "Alice",
        gain_db: -2,
        deesser: 0.4,
        offset_seconds: 0.1,
        original_file: "a.mp3",
        normalized_wav: "a.wav",
        peaks: [],
      },
      B: {
        speaker: "B",
        label: "Bob",
        gain_db: 1,
        deesser: 0,
        offset_seconds: 0,
        original_file: "b.mp3",
        normalized_wav: "b.wav",
        peaks: [],
      },
    },
    transcripts: [
      { id: "a-tr-1", speaker: "A", source_start: 0, source_end: 1, text: "x".repeat(5000) },
    ],
    overlaps: [],
    settings: { min_overlap_s: 0.3 },
  };
}

function setup() {
  clearHistory();
  state.project = freshProject();
  state.editVersion = 0;
}

test("スナップショットは blocks/tracksメタのみ（name/transcripts/peaks不含・サイズ検証）", () => {
  setup();
  // 重いフィールドを意図的に膨らませる
  state.project.transcripts = Array.from({ length: 200 }, (_, i) => ({
    id: `tr-${i}`,
    speaker: "A",
    source_start: i,
    source_end: i + 1,
    text: "long transcript text ".repeat(50),
  }));
  state.project.tracks.A.peaks = Array.from({ length: 6000 }, () => 0.12345);
  const snap = _makeSnapshot(state.project);
  assert.deepEqual(Object.keys(snap).sort(), ["blocks", "tracks"]);
  assert.ok(!("name" in snap)); // リネームはundo対象外（QA指摘: 履歴に積まれないtopbarリネームを巻き戻さない）
  assert.deepEqual(Object.keys(snap.tracks.A).sort(), [
    "deesser",
    "gain_db",
    "label",
    "offset_seconds",
  ]);
  assert.ok(!("transcripts" in snap));
  assert.ok(!("peaks" in snap.tracks.A));
  const snapSize = JSON.stringify(snap).length;
  const projectSize = JSON.stringify(state.project).length;
  assert.ok(
    snapSize < projectSize / 10,
    `snapshot ${snapSize}B は project ${projectSize}B の1/10未満であること`,
  );
});

test("undo→redo 往復完全復元 + editVersion++・blocks-changedは発火しない（main結線）", () => {
  setup();
  const original = structuredClone(state.project);
  pushHistory();
  // 編集: 移動 + 削除 + トラックメタ変更 + 名前変更（nameは履歴対象外）
  state.project.blocks[0].start = 9.999;
  state.project.blocks[1].deleted = true;
  state.project.tracks.A.gain_db = 5;
  state.project.tracks.A.offset_seconds = 1.5;
  state.project.name = "renamed";
  const edited = structuredClone(state.project);
  const v1 = state.editVersion;
  let emitted = 0;
  const off = on("blocks-changed", () => emitted++);

  assert.equal(undo(), true);
  assert.ok(state.editVersion > v1);
  assert.equal(emitted, 0); // emitはmain結線の責務（history自身は発火しない）
  off();
  assert.deepStrictEqual(state.project.blocks, original.blocks);
  assert.equal(state.project.name, "renamed"); // nameはスナップショット対象外 → undoで巻き戻らない
  assert.equal(state.project.tracks.A.gain_db, -2);
  assert.equal(state.project.tracks.A.offset_seconds, 0.1);
  // スナップショット外のフィールドは無傷
  assert.equal(state.project.tracks.A.original_file, "a.mp3");
  assert.deepStrictEqual(state.project.transcripts, original.transcripts);

  assert.equal(canRedo(), true);
  assert.equal(redo(), true);
  assert.deepStrictEqual(state.project.blocks, edited.blocks);
  assert.equal(state.project.name, "renamed");
  assert.equal(state.project.tracks.A.gain_db, 5);
});

test("undoはtopbarリネームを巻き戻さない（履歴外のname変更を保持・QA回帰）", () => {
  setup();
  pushHistory(); // ブロック編集相当のスナップショット（当時 name = "test project"）
  state.project.blocks[0].start = 9.9;
  state.project.name = "renamed after edit"; // topbarリネーム（commitEditを通らず履歴に積まれない）
  assert.equal(undo(), true); // ブロック編集のundo
  assert.equal(state.project.blocks[0].start, 0.5); // ブロックは復元
  assert.equal(state.project.name, "renamed after edit"); // リネームは巻き添えにしない
  assert.equal(redo(), true);
  assert.equal(state.project.name, "renamed after edit");
});

test("上限20件（それ以前の履歴は捨てられる）", () => {
  setup();
  for (let i = 0; i < 25; i++) {
    pushHistory();
    state.project.blocks[0].start = i + 1;
  }
  let count = 0;
  while (undo()) count++;
  assert.equal(count, 20);
  assert.equal(canUndo(), false);
  // 25回編集 - 20履歴 → 最古に戻っても start は 5（=25-20番目の編集後）
  assert.equal(state.project.blocks[0].start, 5);
});

test("pushHistory は redo をクリアする", () => {
  setup();
  pushHistory();
  state.project.blocks[0].start = 1;
  assert.equal(undo(), true);
  assert.equal(canRedo(), true);
  pushHistory();
  assert.equal(canRedo(), false);
});

test("復元後の再編集がスナップショットを汚さない（エイリアシング防止）", () => {
  setup();
  pushHistory();
  state.project.blocks[0].start = 1;
  pushHistory();
  state.project.blocks[0].start = 2;
  assert.equal(undo(), true); // start=1
  state.project.blocks[0].start = 7; // 復元後にin-place編集
  assert.equal(undo(), true); // start=0.5（最初のスナップショットが無傷であること）
  assert.equal(state.project.blocks[0].start, 0.5);
});

test("project未設定/履歴空は false・pushHistoryはno-op", () => {
  clearHistory();
  state.project = null;
  pushHistory();
  assert.equal(canUndo(), false);
  assert.equal(undo(), false);
  assert.equal(redo(), false);
});
