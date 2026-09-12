// UIモジュールの純関数ヘルパのテスト:
// - autoEdit.formatAutoEditSummary / formatSpan（summary 表示整形）
// - transcriptPanel._findRowAt（現在行の二分探索 + 有界後方走査）
// 各モジュールはモジュールトップで DOM に触らないため node で import できること自体も回帰検知になる。

import test from "node:test";
import assert from "node:assert/strict";

import {
  formatAutoEditSummary,
  formatSpan,
  validateAutoEditThresholds,
} from "../../src/podcast_prep/static/js/autoEdit.js";
import { _findRowAt } from "../../src/podcast_prep/static/js/transcriptPanel.js";

test("formatSpan: 60秒未満は0.1s精度・以上は m:ss", () => {
  assert.equal(formatSpan(0), "0.0s");
  assert.equal(formatSpan(12.34), "12.3s");
  assert.equal(formatSpan(59.94), "59.9s");
  assert.equal(formatSpan(59.96), "1:00"); // 丸めで60秒に到達したら m:ss 側
  assert.equal(formatSpan(192.6), "3:13");
  assert.equal(formatSpan(119.7), "2:00");
  assert.equal(formatSpan(-5), "0.0s");
});

test("formatAutoEditSummary: 件数・短縮量・skip内訳", () => {
  const text = formatAutoEditSummary({
    gaps_closed: 3,
    overlaps_resolved: 1,
    overlaps_skipped: 2,
    skipped_reasons: { contained: 1, too_long: 1, same_start: 0 },
    duration_before: 100,
    duration_after: 87.6,
    would_change: true,
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "適用予定: ギャップ 3件 / 被り 1件（−12.4s）");
  assert.equal(lines[1], "スキップ 2件（相槌1 / 長尺1 / 同時0）");
  assert.equal(lines.length, 2);
});

test("formatAutoEditSummary: 変更なし・時間が延びるケース（+表示）", () => {
  const text = formatAutoEditSummary({
    gaps_closed: 0,
    overlaps_resolved: 2,
    overlaps_skipped: 0,
    duration_before: 100,
    duration_after: 104.2,
    would_change: false,
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "適用予定: ギャップ 0件 / 被り 2件（+4.2s）");
  assert.equal(lines[1], "変更はありません");
  assert.equal(formatAutoEditSummary(null), "");
});

test("_findRowAt: start<=t<end の行を返す（重なりは後発行優先・半開区間）", () => {
  const rows = [
    { start: 0, end: 5 },
    { start: 1, end: 2 },
    { start: 6, end: 8 },
  ];
  assert.equal(_findRowAt(rows, 1.5), 1); // 重なり: 後発（startが大きい）行
  assert.equal(_findRowAt(rows, 3), 0); // 後方走査で外側の行に到達
  assert.equal(_findRowAt(rows, 0), 0);
  assert.equal(_findRowAt(rows, 2), 0); // rows[1] は end=2 で半開区間の外
  assert.equal(_findRowAt(rows, 5.5), -1); // ギャップ
  assert.equal(_findRowAt(rows, 6), 2);
  assert.equal(_findRowAt(rows, 8), -1); // 終端も半開区間の外
  assert.equal(_findRowAt([], 1), -1);
});

// ── validateAutoEditThresholds（実機FB #20: 閾値エラーのフロント事前検証） ──
// サーバ auto_edit_project の検証式（keep_gap < 0 / max_gap < keep_gap /
// max_ov < min_ov）の UI 3欄ぶんミラー。

test("validateAutoEditThresholds: 妥当な既定値は空配列", () => {
  assert.deepStrictEqual(
    validateAutoEditThresholds({ max_gap_s: 1.5, keep_gap_s: 0.5, max_overlap_s: 3.0 }, 0.3),
    [],
  );
  // 境界は許容（keep == max / max_ov == min_ov）
  assert.deepStrictEqual(
    validateAutoEditThresholds({ max_gap_s: 0.5, keep_gap_s: 0.5, max_overlap_s: 0.3 }, 0.3),
    [],
  );
});

test("validateAutoEditThresholds: 詰めた後の値が判定値より大きい（実機FBの再現ケース）", () => {
  const errors = validateAutoEditThresholds(
    { max_gap_s: 1.0, keep_gap_s: 2.0, max_overlap_s: 3.0 },
    0.3,
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "keepGap");
  assert.match(errors[0].message, /以下にしてください/);
});

test("validateAutoEditThresholds: keep_gap 負値 / max_ov が min_ov 未満", () => {
  const negative = validateAutoEditThresholds(
    { max_gap_s: 1.5, keep_gap_s: -0.1, max_overlap_s: 3.0 },
    0.3,
  );
  assert.deepStrictEqual(negative.map((e) => e.field), ["keepGap"]);
  assert.match(negative[0].message, /0 以上/);

  const smallOv = validateAutoEditThresholds(
    { max_gap_s: 1.5, keep_gap_s: 0.5, max_overlap_s: 0.2 },
    0.3,
  );
  assert.deepStrictEqual(smallOv.map((e) => e.field), ["maxOv"]);
  assert.match(smallOv[0].message, /0\.3 秒以上/);
});

test("validateAutoEditThresholds: 非数と複数エラーの同時報告・min_ov 欠損は 0.3 フォールバック", () => {
  const errors = validateAutoEditThresholds(
    { max_gap_s: "abc", keep_gap_s: -1, max_overlap_s: 0.1 },
    undefined,
  );
  assert.deepStrictEqual(errors.map((e) => e.field), ["maxGap", "keepGap", "maxOv"]);
  // 空文字は Number("") === 0 なので数値として扱われる（サーバ float() と同じ着地）
  const empty = validateAutoEditThresholds(
    { max_gap_s: "", keep_gap_s: "0.5", max_overlap_s: "3" },
    0.3,
  );
  assert.deepStrictEqual(empty.map((e) => e.field), ["keepGap"]); // 0 < 0.5 → 判定超過
});
