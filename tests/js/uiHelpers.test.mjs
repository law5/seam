// UIモジュールの純関数ヘルパのテスト:
// - autoEdit.formatAutoEditSummary / formatSpan（summary 表示整形）
// - autoEdit.parseThresholdInput（Issue #36: 空入力で settings に 0 を保存しない）
// - autoEdit.shouldConfirmOverlapReset / overlapResetChoice / awaitOverlapResetChoice
//   （Issue #36: チェック編集後のプレビュー確認ダイアログの条件と Promise 契約）
// - transcriptPanel._findRowAt（現在行の二分探索 + 有界後方走査）
// 各モジュールはモジュールトップで DOM に触らないため node で import できること自体も回帰検知になる。

import test from "node:test";
import assert from "node:assert/strict";

import {
  awaitOverlapResetChoice,
  formatAutoEditSummary,
  formatSpan,
  overlapResetChoice,
  parseThresholdInput,
  shouldConfirmOverlapReset,
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

// ── Issue #36 補足バグ: 閾値入力を空にした瞬間 settings に 0 が保存される ──
//
// 旧実装は `Number(input.value)` を Number.isFinite に掛けるだけだったため、
// 入力欄を空にした瞬間 Number("") === 0 が検証を通過し settings へ 0 が保存され、
// 350ms 後の PUT でサーバへ飛んでいた。サーバ側では max_ov < min_ov となり
// classify_overlaps が ValueError → 分類を放棄し、被り一覧が**全行「不明」**に化ける。
// （インライン赤字は入力欄の生値を見るので、そちらの表示は従来どおり出る）

test("parseThresholdInput: 空文字・空白のみは null（settings を汚さない）", () => {
  assert.equal(parseThresholdInput(""), null, "ここが 0 を返したら settings に 0 が飛ぶ");
  assert.equal(parseThresholdInput(" "), null, "Number(' ') も 0 になる同じ穴");
  assert.equal(parseThresholdInput("\t\n"), null);
});

test("parseThresholdInput: 数値にならない入力も null", () => {
  for (const raw of ["abc", "1.2.3", "--3", "1,5", "3s", null, undefined, {}, []]) {
    assert.equal(parseThresholdInput(raw), null, String(raw));
  }
  assert.equal(parseThresholdInput(NaN), null);
  assert.equal(parseThresholdInput(Infinity), null);
});

test("parseThresholdInput: 妥当な数値はそのまま通す（従来挙動を変えない）", () => {
  assert.equal(parseThresholdInput("3"), 3);
  assert.equal(parseThresholdInput("0.3"), 0.3);
  assert.equal(parseThresholdInput(" 1.5 "), 1.5); // number input の前後空白
  assert.equal(parseThresholdInput("0"), 0, "明示的に打った 0 は通す（検証は別レイヤの責務）");
  assert.equal(parseThresholdInput(2.5), 2.5);
  assert.equal(parseThresholdInput(0), 0);
});

// ── Issue #36 改修③: プレビュー前の確認ダイアログを出す条件 ──
//
// 出すのは「ユーザーが被り一覧のチェックを手で変更している」ときだけ。
// 触っていなければ失われるものが無いので、従来どおり無確認で即プレビューする
// （毎回確認を挟むと自動調整のテンポが壊れる）。

test("shouldConfirmOverlapReset: touched が無ければ確認しない", () => {
  assert.equal(shouldConfirmOverlapReset(false), false);
  assert.equal(shouldConfirmOverlapReset(undefined), false);
  assert.equal(shouldConfirmOverlapReset(null), false);
});

test("shouldConfirmOverlapReset: touched があれば確認する", () => {
  assert.equal(shouldConfirmOverlapReset(true), true);
});

test("overlapResetChoice: 「はい」だけが真・未知値と Esc は実行しない側へ倒す", () => {
  assert.equal(overlapResetChoice("yes"), true);
  assert.equal(overlapResetChoice("no"), false);
  // 他ダイアログの値が紛れても勝手に実行しない（workdirConflictChoice と同じ安全側）
  for (const value of ["resume", "overwrite", "discard", "archive", "", undefined, null]) {
    assert.equal(overlapResetChoice(value), false, String(value));
  }
});

// ── Issue #36 改修③: 確認ダイアログの Promise 契約 ──
//
// DOM 要素形の最小スタブ（EventTarget 相当）で <dialog> / <form> を代用する。
// 固定したい規律:
// - returnValue ではなく event.submitter?.value を読む
// - Esc（cancel イベント）は「いいえ」
// - settle で submit / cancel の**両方**のリスナーを外す（片方だけ once で残すと
//   次回表示時に前回の残骸が発火して、押していないのに解決してしまう）

function makeDialogStub() {
  const listeners = new Map();
  let shown = 0;
  return {
    shown: () => shown,
    listenerCount: (type) => (listeners.get(type) || []).length,
    showModal() {
      shown += 1;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    fire(type, event) {
      for (const fn of [...(listeners.get(type) || [])]) fn(event);
    },
  };
}

test("awaitOverlapResetChoice: 「はい」で true・リスナーは両方外れる", async () => {
  const dialog = makeDialogStub();
  const form = makeDialogStub();
  const promise = awaitOverlapResetChoice(dialog, form);
  assert.equal(dialog.shown(), 1, "showModal は1回だけ");
  form.fire("submit", { submitter: { value: "yes" } });
  assert.equal(await promise, true);
  assert.equal(form.listenerCount("submit"), 0, "submit リスナーが残っていない");
  assert.equal(dialog.listenerCount("cancel"), 0, "cancel リスナーも必ず外す");
});

test("awaitOverlapResetChoice: 「いいえ」で false", async () => {
  const dialog = makeDialogStub();
  const form = makeDialogStub();
  const promise = awaitOverlapResetChoice(dialog, form);
  form.fire("submit", { submitter: { value: "no" } });
  assert.equal(await promise, false);
  assert.equal(form.listenerCount("submit"), 0);
  assert.equal(dialog.listenerCount("cancel"), 0);
});

test("awaitOverlapResetChoice: Esc（cancel イベント）は「いいえ」扱い", async () => {
  const dialog = makeDialogStub();
  const form = makeDialogStub();
  const promise = awaitOverlapResetChoice(dialog, form);
  dialog.fire("cancel", {});
  assert.equal(await promise, false);
  assert.equal(form.listenerCount("submit"), 0, "cancel 経路でも submit リスナーを外す");
  assert.equal(dialog.listenerCount("cancel"), 0);
});

test("awaitOverlapResetChoice: submitter 欠落（Enter 送信等）も「いいえ」", async () => {
  const dialog = makeDialogStub();
  const form = makeDialogStub();
  const promise = awaitOverlapResetChoice(dialog, form);
  form.fire("submit", {});
  assert.equal(await promise, false);
});

test("awaitOverlapResetChoice: 前回の残骸が次回に発火しない", async () => {
  const dialog = makeDialogStub();
  const form = makeDialogStub();
  await (async () => {
    const p = awaitOverlapResetChoice(dialog, form);
    dialog.fire("cancel", {});
    return p;
  })();
  // 2回目: 「はい」で解決すること（1回目の cancel リスナーが残っていると
  // 次の cancel で二重 resolve し、片方だけ once の実装では取りこぼす）
  const second = awaitOverlapResetChoice(dialog, form);
  assert.equal(dialog.shown(), 2);
  assert.equal(form.listenerCount("submit"), 1, "現行の1件だけ");
  assert.equal(dialog.listenerCount("cancel"), 1);
  form.fire("submit", { submitter: { value: "yes" } });
  assert.equal(await second, true);
});

test("awaitOverlapResetChoice: ダイアログ未設置なら従来どおり即実行（true）", async () => {
  assert.equal(await awaitOverlapResetChoice(null, null), true);
  assert.equal(await awaitOverlapResetChoice(makeDialogStub(), null), true);
  assert.equal(await awaitOverlapResetChoice(null, makeDialogStub()), true);
});
