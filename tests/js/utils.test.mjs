import test from "node:test";
import assert from "node:assert/strict";

import {
  fmt,
  fmtMs,
  dbToLinear,
  clamp,
  round3,
  round6,
  blockDuration,
  blockEnd,
  lowerBound,
  nearestScrollTop,
  LOUDNORM_DEFAULTS,
  applyLoudnormDefaults,
  parentDirOf,
} from "../../src/podcast_prep/static/js/utils.js";

test("fmt: HH:MM:SS", () => {
  assert.equal(fmt(0), "00:00:00");
  assert.equal(fmt(3661), "01:01:01");
  assert.equal(fmt(59.9), "00:00:59");
  assert.equal(fmt(-5), "00:00:00");
  assert.equal(fmt(undefined), "00:00:00");
});

test("fmtMs: 符号+3桁区切り", () => {
  assert.equal(fmtMs(1.234), "+1,234 ms");
  assert.equal(fmtMs(-0.5), "-500 ms");
  assert.equal(fmtMs(0), "+0 ms");
  assert.equal(fmtMs(12.3456789), "+12,346 ms");
  assert.equal(fmtMs(-1234.567), "-1,234,567 ms");
});

test("dbToLinear", () => {
  assert.equal(dbToLinear(0), 1);
  assert.ok(Math.abs(dbToLinear(-6) - 0.501187) < 1e-6);
  assert.ok(Math.abs(dbToLinear(6) - 1.995262) < 1e-6);
  assert.equal(dbToLinear(undefined), 1);
});

test("clamp / round3 / round6", () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
  assert.equal(round3(1.23456), 1.235);
  assert.equal(round3(97.1234567), 97.123);
  assert.equal(round6(0.30000000000000004), 0.3);
  assert.equal(round6(14.555000000000001), 14.555);
});

test("blockDuration / blockEnd", () => {
  const b = { source_start: 1.0, source_end: 3.5, start: 10.0 };
  assert.equal(blockDuration(b), 2.5);
  assert.equal(blockEnd(b), 12.5);
  assert.equal(blockDuration({ source_start: 5, source_end: 4, start: 0 }), 0);
});

test("lowerBound: 最初の key>=target 位置", () => {
  const arr = [1, 3, 3, 5, 9].map((v) => ({ k: v }));
  const key = (x) => x.k;
  assert.equal(lowerBound(arr, 0, key), 0);
  assert.equal(lowerBound(arr, 1, key), 0);
  assert.equal(lowerBound(arr, 2, key), 1);
  assert.equal(lowerBound(arr, 3, key), 1);
  assert.equal(lowerBound(arr, 4, key), 3);
  assert.equal(lowerBound(arr, 9, key), 4);
  assert.equal(lowerBound(arr, 10, key), 5);
  assert.equal(lowerBound([], 1, key), 0);
});

// buildExportOutputDir（Issue #18 のサブフォルダ名手書き入力）は Issue #32 で廃止
// （出力先はネイティブのフォルダ選択で絶対パスを渡す）

test("nearestScrollTop: コンテナ内 nearest スクロール計算（Issue #20 実機FB）", () => {
  // 行が全部見えている → 現状維持
  assert.equal(nearestScrollTop(100, 200, 150, 30), 100);
  assert.equal(nearestScrollTop(100, 200, 100, 30), 100); // 上端ぴったり
  assert.equal(nearestScrollTop(100, 200, 270, 30), 100); // 下端ぴったり
  // 上にはみ出し → 行頭を上端へ
  assert.equal(nearestScrollTop(100, 200, 60, 30), 60);
  // 下にはみ出し → 行末を下端へ（scrollTop = itemTop + itemH - viewportH）
  assert.equal(nearestScrollTop(100, 200, 290, 30), 120);
  // 行がビューポートより高い → 行頭優先（行頭が上端）
  assert.equal(nearestScrollTop(100, 200, 150, 400), 150);
  assert.equal(nearestScrollTop(300, 200, 150, 400), 150);
});

// ── Issue #37: ラウドネス設定のリセット ──

test("LOUDNORM_DEFAULTS: サーバ側 models.py default_settings と同値", () => {
  // models.py 側を変えたらこの定数（と本テスト）も揃えること
  assert.deepEqual(
    { ...LOUDNORM_DEFAULTS },
    { target_lufs: -16, true_peak: -1.5, tolerance: 0.5 },
  );
  assert.ok(Object.isFrozen(LOUDNORM_DEFAULTS));
});

test("applyLoudnormDefaults: 変更済みの3項目を既定値へ戻して true を返す", () => {
  const settings = { target_lufs: -14, true_peak: -2, tolerance: 0, export_format: "mp3" };
  assert.equal(applyLoudnormDefaults(settings), true);
  assert.equal(settings.target_lufs, -16);
  assert.equal(settings.true_peak, -1.5);
  assert.equal(settings.tolerance, 0.5);
  assert.equal(settings.export_format, "mp3"); // ラウドネス以外の設定には触らない
});

test("applyLoudnormDefaults: 一部だけ変更されていても全項目を既定値に揃える", () => {
  const settings = { target_lufs: -16, true_peak: -2, tolerance: 0.5 };
  assert.equal(applyLoudnormDefaults(settings), true);
  assert.deepEqual(settings, { target_lufs: -16, true_peak: -1.5, tolerance: 0.5 });
});

test("applyLoudnormDefaults: 既に既定値なら false（保存不要の判断に使う）", () => {
  const settings = { target_lufs: -16, true_peak: -1.5, tolerance: 0.5 };
  assert.equal(applyLoudnormDefaults(settings), false);
});

test("applyLoudnormDefaults: 未設定キーは補完し、settings が無ければ false", () => {
  const settings = {};
  assert.equal(applyLoudnormDefaults(settings), true);
  assert.deepEqual(settings, { target_lufs: -16, true_peak: -1.5, tolerance: 0.5 });
  assert.equal(applyLoudnormDefaults(null), false);
  assert.equal(applyLoudnormDefaults(undefined), false);
});

// Issue #36: 復元導線の親フォルダ算出。win32 chooser はバックスラッシュ区切りを返す
test("parentDirOf: POSIX パス", () => {
  assert.equal(parentDirOf("/Users/example/EP01/project.json"), "/Users/example/EP01");
  assert.equal(parentDirOf("/project.json"), "/"); // ルート直下は "/" に倒す
});

test("parentDirOf: Windows パス（バックスラッシュ区切り）", () => {
  assert.equal(parentDirOf("C:\\Users\\law\\EP31\\project.json"), "C:\\Users\\law\\EP31");
  assert.equal(parentDirOf("C:/mixed\\sep/project.json"), "C:/mixed\\sep");
});

test("parentDirOf: ドライブ/ルート直下は区切りを保ったルートを返す", () => {
  // "C:" だけ返すと drive-relative パス（C: の現在ディレクトリ）になり意味が変わる
  assert.equal(parentDirOf("C:\\project.json"), "C:\\");
  assert.equal(parentDirOf("C:/project.json"), "C:/");
  assert.equal(parentDirOf("/project.json"), "/"); // POSIX ルートは現行維持
  // 通常パス・UNC は回帰させない
  assert.equal(parentDirOf("D:\\EP31\\project.json"), "D:\\EP31");
  assert.equal(parentDirOf("\\\\server\\share\\project.json"), "\\\\server\\share");
});

test("parentDirOf: 区切りなしは null（壊れた source_dir を作らない）", () => {
  assert.equal(parentDirOf("project.json"), null);
  assert.equal(parentDirOf(""), null);
  assert.equal(parentDirOf(null), null);
});

test("parentDirOf: 末尾区切りは末尾を落とした親を返す", () => {
  assert.equal(parentDirOf("/Users/example/EP01/"), "/Users/example/EP01");
  assert.equal(parentDirOf("C:\\Users\\EP31\\"), "C:\\Users\\EP31");
});
