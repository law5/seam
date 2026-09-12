// player.computePlaybackSegments の純関数テスト。
// AudioContext 依存部はテスト対象外（player.js はモジュールトップで AudioContext に触らない）。
//
// 注意: player.js は state.js / utils.js / timelineModel.js / pcm.js / api.js を
// 契約シグネチャで import する。並行実装中でファイル未着の場合のみ skip する
// （ERR_MODULE_NOT_FOUND 以外の import 失敗 = 実バグはそのまま落とす）。

import { test } from "node:test";
import assert from "node:assert/strict";

let player = null;
let loadFailure = null;
try {
  player = await import("../../src/podcast_prep/static/js/player.js");
} catch (err) {
  if (err && err.code === "ERR_MODULE_NOT_FOUND") {
    loadFailure = err;
  } else {
    throw err;
  }
}

const opts = player
  ? {}
  : { skip: `依存モジュールを読み込めないため skip: ${loadFailure.message}` };

// ── フィクスチャ ──────────────────────────────────────────

function block(id, start, srcStart, srcEnd, speaker = "A") {
  return {
    id,
    speaker,
    source_start: srcStart,
    source_end: srcEnd,
    start,
    text: "",
    deleted: false,
  };
}

const dur = (b) => Math.max(0, b.source_end - b.source_start);
const end = (b) => b.start + dur(b);

// 手組みの最小 TimelineIndex（timelineModel.getIndex と同形）
function makeIndex(blocksA, blocksB = []) {
  const sortByStart = (arr) =>
    [...arr].sort(
      (a, b) =>
        a.start - b.start ||
        a.source_start - b.source_start ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const sortBySource = (arr) => [...arr].sort((a, b) => a.source_start - b.source_start);
  const A = sortByStart(blocksA);
  const B = sortByStart(blocksB);
  return {
    byStart: { A, B },
    bySource: { A: sortBySource(blocksA), B: sortBySource(blocksB) },
    maxDur: {
      A: A.reduce((m, b) => Math.max(m, dur(b)), 0),
      B: B.reduce((m, b) => Math.max(m, dur(b)), 0),
    },
    timelineEnd: Math.max(0, ...A.map(end), ...B.map(end)),
  };
}

// ── テスト ─────────────────────────────────────────────

test("ギャップ跨ぎ窓: ギャップは無出力・両ブロックが窓でクリップされる", opts, () => {
  // b1: [0,2) src[10,12) / ギャップ[2,5) / b2: [5,7) src[20,22)
  const index = makeIndex([block("b1", 0, 10, 12), block("b2", 5, 20, 22)]);
  const segs = player.computePlaybackSegments(index, "A", 1, 6);
  assert.deepEqual(segs, [
    { blockId: "b1", timelineStart: 1, srcStart: 11, dur: 1, fadeIn: false, fadeOut: true },
    { blockId: "b2", timelineStart: 5, srcStart: 20, dur: 1, fadeIn: true, fadeOut: false },
  ]);
});

test("ブロック途中再開: fadeIn=false・srcStart がオフセット写像される", opts, () => {
  const index = makeIndex([block("b1", 0, 0, 10)]);
  const segs = player.computePlaybackSegments(index, "A", 3, 20);
  assert.deepEqual(segs, [
    { blockId: "b1", timelineStart: 3, srcStart: 3, dur: 7, fadeIn: false, fadeOut: true },
  ]);
});

test("窓端クリップ: 両端とも窓内クリップなら fadeIn/fadeOut とも false", opts, () => {
  const index = makeIndex([block("b1", 0, 100, 110)]);
  const segs = player.computePlaybackSegments(index, "A", 2, 4);
  assert.deepEqual(segs, [
    { blockId: "b1", timelineStart: 2, srcStart: 102, dur: 2, fadeIn: false, fadeOut: false },
  ]);
});

test("空タイムライン: 空配列を返す", opts, () => {
  const index = makeIndex([], []);
  assert.deepEqual(player.computePlaybackSegments(index, "A", 0, 10), []);
  assert.deepEqual(player.computePlaybackSegments(index, "B", 0, 10), []);
});

test("同話者重なり: 両ブロックとも出力される（加算ミックス前提）", opts, () => {
  // b1: [0,4) / b2: [2,6) — 同一話者Aで重なる
  const index = makeIndex([block("b1", 0, 0, 4), block("b2", 2, 100, 104)]);
  const segs = player.computePlaybackSegments(index, "A", 0, 10);
  assert.deepEqual(segs, [
    { blockId: "b1", timelineStart: 0, srcStart: 0, dur: 4, fadeIn: true, fadeOut: true },
    { blockId: "b2", timelineStart: 2, srcStart: 100, dur: 4, fadeIn: true, fadeOut: true },
  ]);
});

test("半開区間境界: end==fromT のブロックと start==toT のブロックは含まれない", opts, () => {
  const index = makeIndex([
    block("before", 0, 0, 2), // end=2 == fromT → 除外
    block("inside", 3, 50, 51), // 完全内包
    block("after", 5, 60, 62), // start=5 == toT → 除外
  ]);
  const segs = player.computePlaybackSegments(index, "A", 2, 5);
  assert.deepEqual(segs, [
    { blockId: "inside", timelineStart: 3, srcStart: 50, dur: 1, fadeIn: true, fadeOut: true },
  ]);
});

test("話者選択: byStart の指定話者側のみ列挙される", opts, () => {
  const index = makeIndex(
    [block("a1", 0, 0, 2)],
    [block("b1", 1, 10, 13, "B")],
  );
  const segsB = player.computePlaybackSegments(index, "B", 0, 10);
  assert.deepEqual(segsB, [
    { blockId: "b1", timelineStart: 1, srcStart: 10, dur: 3, fadeIn: true, fadeOut: true },
  ]);
});

test("不正窓: fromT >= toT は空配列", opts, () => {
  const index = makeIndex([block("b1", 0, 0, 10)]);
  assert.deepEqual(player.computePlaybackSegments(index, "A", 5, 5), []);
  assert.deepEqual(player.computePlaybackSegments(index, "A", 6, 4), []);
});

test("カリング: 窓より十分手前・後ろのブロックを含む長い配列でも正しい部分列", opts, () => {
  const blocks = [];
  for (let i = 0; i < 200; i++) {
    // start = i*2, dur=1 → [i*2, i*2+1)
    blocks.push(block(`b${String(i).padStart(3, "0")}`, i * 2, i * 10, i * 10 + 1));
  }
  const index = makeIndex(blocks);
  const segs = player.computePlaybackSegments(index, "A", 100, 106.5);
  // 窓 [100,106.5): b050[100,101) b051[102,103) b052[104,105) b053[106,106.5窓クリップ)
  assert.deepEqual(segs, [
    { blockId: "b050", timelineStart: 100, srcStart: 500, dur: 1, fadeIn: true, fadeOut: true },
    { blockId: "b051", timelineStart: 102, srcStart: 510, dur: 1, fadeIn: true, fadeOut: true },
    { blockId: "b052", timelineStart: 104, srcStart: 520, dur: 1, fadeIn: true, fadeOut: true },
    { blockId: "b053", timelineStart: 106, srcStart: 530, dur: 0.5, fadeIn: true, fadeOut: false },
  ]);
});
