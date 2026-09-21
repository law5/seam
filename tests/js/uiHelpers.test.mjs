// UIモジュールの純関数ヘルパのテスト:
// - autoEdit.formatAutoEditSummary / formatSpan（summary 表示整形）
// - autoEdit.parseThresholdInput / thresholdValueToPersist
//   （Issue #36: 空入力・不正値を settings へ永続化しない。妥当性判定は
//    validateAutoEditThresholds に委ね、ルールの定義箇所を増やさない）
// - autoEdit.validateAutoEditThresholds の空欄検証
//   （Issue #37: 空欄が Number("") === 0 で素通りし、無音が全削除されていた。
//    読み取りを parseThresholdInput に統一。赤字表示と送信ゲートは同じ
//    errors 配列を見るので、この関数を直せば両方が同時に直る）
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
  thresholdValueToPersist,
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
});

// ── Issue #37: 空のギャップ欄が検証を素通りし、無音が全削除される ──
//
// 旧実装は各欄を `Number(opts?.max_gap_s)` で読んでいたため `Number("") === 0` が
// Number.isFinite を通過し、**空欄が「0 という妥当な入力」として素通り**していた。
// サーバの検証式（keep_gap < 0 / max_gap < keep_gap / max_ov < min_ov）は 0/0 を
// 合法として通すので、detect_silence_gaps(min_gap_s=0) が**すべての無音ギャップ**を
// 検出して詰める = 無警告で最も破壊的な編集が走っていた。
// 修正: 読み取りを parseThresholdInput に統一し、空欄は「未入力」エラーにする。

test("validateAutoEditThresholds: 空欄は 0 ではなく未入力エラー（#37 の本丸）", () => {
  // QA 実測の再現ケース: keep_gap だけ空 → 旧実装は errors: [] で素通りしていた
  assert.deepStrictEqual(
    validateAutoEditThresholds({ max_gap_s: "1.5", keep_gap_s: "", max_overlap_s: "3" }, 0.3).map(
      (e) => e.field,
    ),
    ["keepGap"],
  );
  // max_gap と keep_gap の両方が空 → 旧実装は 0/0 を送信し全無音を詰めていた
  assert.deepStrictEqual(
    validateAutoEditThresholds({ max_gap_s: "", keep_gap_s: "", max_overlap_s: "3" }, 0.3).map(
      (e) => e.field,
    ),
    ["maxGap", "keepGap"],
  );
});

test("validateAutoEditThresholds: 空文字・空白のみ・非数値が3欄それぞれでエラーになる", () => {
  const OK_RAW = { max_gap_s: "1.5", keep_gap_s: "0.5", max_overlap_s: "3" };
  const fields = [
    ["max_gap_s", "maxGap"],
    ["keep_gap_s", "keepGap"],
    ["max_overlap_s", "maxOv"],
  ];
  for (const [key, field] of fields) {
    for (const raw of ["", " ", "\t\n", "abc", "1.2.3", "3s", null, undefined]) {
      const errors = validateAutoEditThresholds({ ...OK_RAW, [key]: raw }, 0.3);
      assert.ok(
        errors.some((e) => e.field === field),
        `${key}=${JSON.stringify(raw)} は ${field} のエラーになるべき`,
      );
      assert.match(
        errors.find((e) => e.field === field).message,
        /数値を入力してください/,
        `${key}=${JSON.stringify(raw)} は「数値未入力」の文言`,
      );
    }
  }
});

test("validateAutoEditThresholds: 明示的な 0 は従来どおり通す（#37 で 0 の妥当性は変えない）", () => {
  // max_gap_s=0 + keep_gap_s=0 は現状のサーバ検証式でも合法。空欄だけを塞ぐ修正で
  // この挙動を壊さない（0 の妥当性そのものはサーバ側の別論点 = Issue 報告事項）。
  assert.deepStrictEqual(
    validateAutoEditThresholds({ max_gap_s: "0", keep_gap_s: "0", max_overlap_s: "3" }, 0.3),
    [],
  );
  assert.deepStrictEqual(
    validateAutoEditThresholds({ max_gap_s: 0, keep_gap_s: 0, max_overlap_s: 3 }, 0.3),
    [],
  );
  // 0 は「空」と違って keep_gap の 0 以上チェックも通る
  assert.deepStrictEqual(
    validateAutoEditThresholds({ max_gap_s: "1.5", keep_gap_s: "0", max_overlap_s: "3" }, 0.3),
    [],
  );
});

test("validateAutoEditThresholds: 組み合わせエラーは空文字混じりでは出さない（#37）", () => {
  // max_gap < keep_gap の判定は両方が数値のときだけ。空欄を 0 とみなして
  // 「0 < 0.5 → 判定超過」という**誤った理由**の赤字を出すと、ユーザーは
  // 空欄が原因だと気づけない。空欄は空欄として報告する。
  const emptyMax = validateAutoEditThresholds(
    { max_gap_s: "", keep_gap_s: "0.5", max_overlap_s: "3" },
    0.3,
  );
  assert.deepStrictEqual(emptyMax.map((e) => e.field), ["maxGap"]);
  assert.match(emptyMax[0].message, /「超」の秒数に数値を入力してください/);

  // 両方数値なら従来どおり組み合わせエラーが出る
  const crossed = validateAutoEditThresholds(
    { max_gap_s: "0.5", keep_gap_s: "1.0", max_overlap_s: "3" },
    0.3,
  );
  assert.deepStrictEqual(crossed.map((e) => e.field), ["keepGap"]);
  assert.match(crossed[0].message, /以下にしてください/);

  // keep_gap が空 + max_gap が数値 → keepGap の未入力エラーのみ（重複して出さない）
  const emptyKeep = validateAutoEditThresholds(
    { max_gap_s: "1.5", keep_gap_s: "", max_overlap_s: "3" },
    0.3,
  );
  assert.equal(emptyKeep.length, 1, "未入力と組み合わせエラーが二重に出ない");
});

// 送信ゲート（#37）。renderThresholdErrors はモジュール内部の DOM 関数なので
// 直接は import できないが、その本体は
//   errors = validateAutoEditThresholds(入力欄の生値, min_overlap_s);
//   ... 赤字を描画 ...
//   return errors.length === 0;   ← プレビュー/適用はこれが false なら return
// であり、**赤字表示と送信ゲートは同じ errors 配列を読む**。したがって
// 「空欄で errors が非空になる」ことがそのまま「赤字が出る」かつ
// 「送信が止まる」の両方を意味する。ここではその不変条件を固定する。
test("送信ゲート: 空欄は errors 非空 = renderThresholdErrors が false を返す経路（#37）", () => {
  const gateWouldPass = (inputs, minOv = 0.3) =>
    validateAutoEditThresholds(inputs, minOv).length === 0;

  // 空欄 → ゲートで止まる（旧実装はここが true で 0/0 を送信していた）
  assert.equal(gateWouldPass({ max_gap_s: "", keep_gap_s: "", max_overlap_s: "3" }), false);
  assert.equal(gateWouldPass({ max_gap_s: "1.5", keep_gap_s: "", max_overlap_s: "3" }), false);
  assert.equal(gateWouldPass({ max_gap_s: "", keep_gap_s: "0.5", max_overlap_s: "3" }), false);
  assert.equal(gateWouldPass({ max_gap_s: "1.5", keep_gap_s: "0.5", max_overlap_s: "" }), false);
  assert.equal(gateWouldPass({ max_gap_s: " ", keep_gap_s: "0.5", max_overlap_s: "3" }), false);

  // 妥当な値 → 従来どおり通る（ゲートを過剰に閉めていない）
  assert.equal(gateWouldPass({ max_gap_s: "1.5", keep_gap_s: "0.5", max_overlap_s: "3" }), true);
  assert.equal(gateWouldPass({ max_gap_s: "0", keep_gap_s: "0", max_overlap_s: "3" }), true);
});

// 永続化ゲート（#36）との相互作用（#37）。thresholdValueToPersist は
// parseThresholdInput で一度弾き、さらに validateAutoEditThresholds の
// 自欄エラーでも弾く。#37 で空欄が errors に入るようになったため二重に弾くが、
// 結果は変わらない（どちらも null）= 永続化の挙動は退行しない。
test("thresholdValueToPersist: 空欄は #37 後も書かない（二重に弾くだけで無害）", () => {
  const empty = { max_gap_s: "", keep_gap_s: "", max_overlap_s: "" };
  assert.equal(thresholdValueToPersist("maxGap", empty, 0.3), null);
  assert.equal(thresholdValueToPersist("keepGap", empty, 0.3), null);
  assert.equal(thresholdValueToPersist("maxOv", empty, 0.3), null);

  // 他欄が空でも、自欄が妥当なら従来どおり書ける（組み合わせエラーは自欄には付かない）
  const onlyMaxGapFilled = { max_gap_s: "1.5", keep_gap_s: "", max_overlap_s: "3" };
  assert.equal(
    thresholdValueToPersist("maxGap", onlyMaxGapFilled, 0.3),
    1.5,
    "keep_gap が空でも max_gap 自体は妥当なので保存できる",
  );
  assert.equal(thresholdValueToPersist("keepGap", onlyMaxGapFilled, 0.3), null);
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
  assert.equal(parseThresholdInput("0"), 0, "明示的に打った 0 は通す（妥当性は別レイヤの責務）");
  assert.equal(parseThresholdInput(2.5), 2.5);
  assert.equal(parseThresholdInput(0), 0);
});

// ── Issue #36 QA: 不正値も settings に永続化されていた（穴の残り半分） ──
//
// 空文字バグ（Number("") === 0）だけを塞いでも、ユーザーが明示的に `0` と打つと
// parseThresholdInput は素直に 0 を返すので settings へ保存され、サーバで
// max_ov < min_ov → classify_overlaps が ValueError → 一覧が全行「不明」になる。
// 空文字のときと同一症状・同一経路なので、永続化ゲートで両方まとめて塞ぐ。
//
// レイヤ分離: 妥当性ルールは validateAutoEditThresholds（= サーバ検証式のミラー）に
// 委ね、thresholdValueToPersist は「自分の欄にエラーがあるか」だけを見る。
// 妥当性ルールの定義箇所は増えない。

const OK = { max_gap_s: "1.5", keep_gap_s: "0.5", max_overlap_s: "3.0" };

test("thresholdValueToPersist: 妥当な値は settings へ書く", () => {
  assert.equal(thresholdValueToPersist("maxGap", OK, 0.3), 1.5);
  assert.equal(thresholdValueToPersist("keepGap", OK, 0.3), 0.5);
  assert.equal(thresholdValueToPersist("maxOv", OK, 0.3), 3);
  // keep_gap の 0 は妥当（0 以上・max_gap 以下）なので書ける
  assert.equal(
    thresholdValueToPersist("keepGap", { ...OK, keep_gap_s: "0" }, 0.3),
    0,
    "妥当な 0 まで弾いてはいけない",
  );
});

test("thresholdValueToPersist: 明示的な 0 でも範囲外なら settings に書かない（#36 QA）", () => {
  // max_overlap_s = 0 は min_overlap_s(0.3) 未満 → サーバが 400 で撥ねる値
  const zeroOv = { ...OK, max_overlap_s: "0" };
  assert.equal(thresholdValueToPersist("maxOv", zeroOv, 0.3), null, "ここが 0 を返すと全行「不明」に化ける");
  // 赤字は従来どおり出る（保存されないが理由は画面で分かる）
  const errors = validateAutoEditThresholds(zeroOv, 0.3);
  assert.deepStrictEqual(errors.map((e) => e.field), ["maxOv"]);
});

test("thresholdValueToPersist: 空文字・非数値も書かない（従来の修正を維持）", () => {
  for (const raw of ["", " ", "abc", "1.2.3"]) {
    assert.equal(thresholdValueToPersist("maxOv", { ...OK, max_overlap_s: raw }, 0.3), null, raw);
  }
});

test("thresholdValueToPersist: keep_gap の負値も書かない（#36 QA）", () => {
  const negative = { ...OK, keep_gap_s: "-1" };
  assert.equal(thresholdValueToPersist("keepGap", negative, 0.3), null);
  assert.ok(validateAutoEditThresholds(negative, 0.3).some((e) => e.field === "keepGap"), "赤字は出る");
});

test("thresholdValueToPersist: 組み合わせエラーは該当欄だけを止める（#36 QA）", () => {
  // max_gap < keep_gap → validateAutoEditThresholds は keepGap にエラーを付ける。
  // サーバも3値まとめて 400 を返すので、ここも同じ粒度で止める。
  const crossed = { max_gap_s: "0.5", keep_gap_s: "2.0", max_overlap_s: "3.0" };
  assert.equal(thresholdValueToPersist("keepGap", crossed, 0.3), null, "不整合な組み合わせは保存しない");
  // maxGap 欄自体にはエラーが付かないので、そちらは保存できる
  assert.equal(thresholdValueToPersist("maxGap", crossed, 0.3), 0.5);
  assert.equal(thresholdValueToPersist("maxOv", crossed, 0.3), 3);
});

test("thresholdValueToPersist: min_overlap_s に追随する（欄の妥当範囲は固定値ではない）", () => {
  const ov1 = { ...OK, max_overlap_s: "0.5" };
  assert.equal(thresholdValueToPersist("maxOv", ov1, 0.3), 0.5, "min_ov=0.3 なら妥当");
  assert.equal(thresholdValueToPersist("maxOv", ov1, 1.0), null, "min_ov=1.0 なら範囲外");
  // min_ov 欠損は validateAutoEditThresholds と同じ 0.3 フォールバック
  assert.equal(thresholdValueToPersist("maxOv", ov1, undefined), 0.5);
});

test("thresholdValueToPersist: 未知の欄・入力欠落は書かない（安全側）", () => {
  assert.equal(thresholdValueToPersist("unknownField", OK, 0.3), null);
  assert.equal(thresholdValueToPersist(undefined, OK, 0.3), null);
  assert.equal(thresholdValueToPersist("maxOv", null, 0.3), null);
  assert.equal(thresholdValueToPersist("maxOv", undefined, 0.3), null);
});

test("thresholdValueToPersist: サーバ検証式と同じ値を弾く（ミラーの境界一致）", () => {
  // server.auto_edit_project: keep_gap < 0 or max_gap < keep_gap or max_ov < min_ov
  // 「サーバが 400 にする値は settings にも書かない」が揃っていること。
  //
  // このミラーの対象は**数値として解釈できる入力**に限る（#37）。空欄は
  // 「サーバに送る値」ではなく「まだ入力されていない」状態であり、サーバの
  // 検証式と突き合わせる対象ではない。空欄はフロントのゲートで送信ごと止まる
  // （上の「送信ゲート」テスト）。ここに空文字ケースを足すと、サーバ側の
  // float("") が 400 になる挙動とフロントの未入力エラーを混同することになる。
  const minOv = 0.3;
  const cases = [
    { inputs: { max_gap_s: "1.5", keep_gap_s: "0.5", max_overlap_s: "0.3" }, ok: true }, // 境界（等号は妥当）
    { inputs: { max_gap_s: "0.5", keep_gap_s: "0.5", max_overlap_s: "0.3" }, ok: true }, // 境界
    { inputs: { max_gap_s: "1.5", keep_gap_s: "0.5", max_overlap_s: "0.29" }, ok: false },
    { inputs: { max_gap_s: "0.49", keep_gap_s: "0.5", max_overlap_s: "3" }, ok: false },
    { inputs: { max_gap_s: "1.5", keep_gap_s: "-0.01", max_overlap_s: "3" }, ok: false },
  ];
  for (const { inputs, ok } of cases) {
    const serverWouldReject =
      Number(inputs.keep_gap_s) < 0 ||
      Number(inputs.max_gap_s) < Number(inputs.keep_gap_s) ||
      Number(inputs.max_overlap_s) < minOv;
    assert.equal(serverWouldReject, !ok, `前提: ${JSON.stringify(inputs)}`);
    const persisted = ["maxGap", "keepGap", "maxOv"].map((f) =>
      thresholdValueToPersist(f, inputs, minOv),
    );
    if (ok) {
      assert.ok(persisted.every((v) => v !== null), `妥当なら全欄書ける: ${JSON.stringify(inputs)}`);
    } else {
      assert.ok(persisted.some((v) => v === null), `不正なら該当欄を止める: ${JSON.stringify(inputs)}`);
    }
  }
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

// #36 QA: DOM 欠損（HTML / ID の退行）は **fail-closed**。
// ここが true（fail-open）だと、確認ダイアログが出ないまま
// ユーザーが手で付けたチェックを無確認で破棄する方向に倒れる。
// 他のダイアログ helper（confirmExportOverwrite 等）は DOM 欠損ガードを持たず
// throw して止まる = 破壊的操作へ倒れないので、流儀としても揃う。
test("awaitOverlapResetChoice: ダイアログ未設置なら実行しない（fail-closed / #36 QA）", async () => {
  assert.equal(await awaitOverlapResetChoice(null, null), false);
  assert.equal(await awaitOverlapResetChoice(makeDialogStub(), null), false);
  assert.equal(await awaitOverlapResetChoice(null, makeDialogStub()), false);
  assert.equal(await awaitOverlapResetChoice(undefined, undefined), false);
});
