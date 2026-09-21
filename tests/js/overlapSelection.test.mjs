// C/D/E/L/G のフロント純関数テスト（panels.js のエクスポート群）。
// panels.js はモジュールトップで DOM に触らないため node で import できる（回帰検知も兼ねる）。
//
// 固定したい契約:
// - C: category 欠損/未知は「不明」= 保護扱い（安全側フォールバック）
// - D: 既定チェックは `=== "resolvable"` の肯定形。undefined が ON にならないこと
// - D: target_pairs は**常に配列**（省略＝全件適用への化けを防ぐ。BE1 申し送り3）
// - D(#36): 触っていない行は**常に分類へ追従**し、touched な行だけユーザー意思が勝つ
// - D(#36): 分類スナップショットは category だけを固定し、区間（行の増減）は素通しする
// - E: Prev/Next は解消可の行だけに飛ぶ（#52）。端で止まりラップしない。0件は無反応
// - G: output_dir 欠損のジョブは表示対象にしない

import test from "node:test";
import assert from "node:assert/strict";

import { postAutoEdit } from "../../src/podcast_prep/static/js/api.js";
import {
  applyCategorySnapshot,
  applySelection,
  buildCategorySnapshot,
  buildOverlapRows,
  carryOverlapSelection,
  categoryInfo,
  defaultChecked,
  exportResultOf,
  formatOverlapSummary,
  freshOverlapState,
  normalizeStatusLabel,
  overlapKeyAction,
  pairKey,
  stepResolvableIndex,
  toTargetPairs,
} from "../../src/podcast_prep/static/js/panels.js";

const ov = (start, blockIds, category) => ({
  start,
  end: start + 1,
  duration: 1,
  block_ids: blockIds,
  ...(category === undefined ? {} : { category }),
});

// ── C: 分類チップ ────────────────────────────────────────

test("categoryInfo: 4分類の文言 + 保護フラグ", () => {
  assert.equal(categoryInfo("resolvable").label, "解消可");
  assert.equal(categoryInfo("resolvable").protected, false);
  assert.equal(categoryInfo("contained").label, "相槌");
  assert.equal(categoryInfo("too_long").label, "長尺");
  assert.equal(categoryInfo("same_start").label, "同時");
  for (const key of ["contained", "too_long", "same_start"]) {
    assert.equal(categoryInfo(key).protected, true, `${key} は保護`);
  }
});

test("categoryInfo: 欠損・未知の category は「不明」= 保護扱い", () => {
  for (const value of [undefined, null, "", "future_category", 0]) {
    const info = categoryInfo(value);
    assert.equal(info.label, "不明");
    assert.equal(info.protected, true);
  }
});

// ── D: 既定チェック（肯定形判定の固定） ──────────────────

test("defaultChecked: resolvable のみ ON", () => {
  assert.equal(defaultChecked({ category: "resolvable" }), true);
  assert.equal(defaultChecked({ category: "contained" }), false);
  assert.equal(defaultChecked({ category: "too_long" }), false);
  assert.equal(defaultChecked({ category: "same_start" }), false);
});

test("defaultChecked: category 欠損は OFF（否定形実装への回帰検知）", () => {
  // ここが true になったら「保護対象を自動編集してしまう」重大な退行。
  assert.equal(defaultChecked({}), false);
  assert.equal(defaultChecked({ category: undefined }), false);
  assert.equal(defaultChecked({ category: null }), false);
  assert.equal(defaultChecked({ category: "unknown_future" }), false);
  assert.equal(defaultChecked(null), false);
  assert.equal(defaultChecked(undefined), false);
});

test("pairKey: 順不同で同じキー・壊れたペアは null", () => {
  assert.equal(pairKey(["b1", "a1"]), pairKey(["a1", "b1"]));
  assert.equal(pairKey(["a1", "b1"]), "a1|b1");
  assert.equal(pairKey(["a1"]), null);
  assert.equal(pairKey([]), null);
  assert.equal(pairKey(undefined), null);
  assert.equal(pairKey(["a1", "b1", "c1"]), null);
  assert.equal(pairKey(["a1", ""]), null); // 空文字は id として不正
  assert.equal(pairKey(["a1", 3]), null);
});

// ── D: 行の構築と選択集合 ───────────────────────────────

test("buildOverlapRows: touched が無ければ resolvable だけ ON", () => {
  const overlaps = [
    ov(1, ["a1", "b1"], "resolvable"),
    ov(21, ["a2", "b2"], "contained"),
    ov(41, ["a3", "b3"], "too_long"),
    ov(60, ["a4", "b4"], "same_start"),
    ov(80, ["a5", "b5"]), // category 欠損
  ];
  const { rows, nextSelected } = buildOverlapRows(overlaps, new Set());
  assert.deepEqual(
    rows.map((r) => r.checked),
    [true, false, false, false, false],
  );
  assert.deepEqual([...nextSelected], ["a1|b1"]);
});

test("buildOverlapRows: touched なペアだけユーザーの選択をそのまま反映する", () => {
  const overlaps = [
    ov(1, ["a1", "b1"], "resolvable"),
    ov(21, ["a2", "b2"], "contained"),
  ];
  // ユーザーが resolvable を外し、保護対象を手動で入れた状態
  const selected = new Set(["a2|b2"]);
  const touched = new Set(["a1|b1", "a2|b2"]);
  const { rows, nextSelected } = buildOverlapRows(overlaps, selected, touched);
  assert.deepEqual(
    rows.map((r) => r.checked),
    [false, true],
  );
  assert.deepEqual([...nextSelected], ["a2|b2"]);
});

test("buildOverlapRows: 編集で新しく現れた被りには既定チェックが入る", () => {
  // a1|b1 は touched（ユーザーが外した）、a9|b9 は編集で新規に生まれた resolvable
  const overlaps = [
    ov(1, ["a1", "b1"], "resolvable"),
    ov(30, ["a9", "b9"], "resolvable"),
    ov(50, ["a8", "b8"], "contained"), // 新規だが保護 → OFF のまま
  ];
  const selected = new Set();
  const touched = new Set(["a1|b1"]);
  const { rows, nextSelected } = buildOverlapRows(overlaps, selected, touched);
  assert.deepEqual(
    rows.map((r) => r.checked),
    [false, true, false],
    "touched=選択尊重 / 新規resolvable=ON / 新規保護=OFF",
  );
  assert.deepEqual([...nextSelected], ["a9|b9"]);
});

// Issue #45: 消えたペアの選択記録は保持する（頭出しのオーバーシュート→戻しで一時的に
// 消えたペアが、復活時にユーザーの選択を取り戻すため）。行としては自然消滅する。
test("buildOverlapRows: 一時的に消えたペアの選択記録を保持する（#45）", () => {
  const selected = new Set(["a1|b1", "gone1|gone2"]);
  const touched = new Set(["a1|b1", "gone1|gone2"]);
  const { rows, nextSelected } = buildOverlapRows(
    [ov(1, ["a1", "b1"], "resolvable")],
    selected,
    touched,
  );
  assert.equal(rows.length, 1, "行は現存ペアのみ（消えたペアは自然消滅）");
  assert.deepEqual(
    [...nextSelected].sort(),
    ["a1|b1", "gone1|gone2"],
    "現存しないペアの記録は消さない（復活時に復元するため）",
  );
});

// Issue #45 再現手順の固定（頭出し）: チェック編集 → ペアが一時消滅 → 復活
// （ローカルスイープ直後は category null）→ echo で分類が届く、の全描画をまたいで
// **ユーザーが触ったペアの**選択が維持されること。#36 後は touched がこの保証を担う。
test("buildOverlapRows: 消滅→復活→echo をまたいで touched のチェックが維持される（#45）", () => {
  // 初期: 3ペア。ユーザーが3つとも手で操作し k1=off / k2=off / k3=on にした
  let selected = new Set(["a3|b3"]);
  const touched = new Set(["a1|b1", "a2|b2", "a3|b3"]);
  // 頭出しオーバーシュート: 全ペア消滅（blocks-changed 描画）
  let built = buildOverlapRows([], selected, touched);
  selected = built.nextSelected;
  // 戻し: 全ペア復活。ローカルスイープは分類を引き継げない（category null）
  built = buildOverlapRows(
    [ov(1, ["a1", "b1"]), ov(21, ["a2", "b2"]), ov(41, ["a3", "b3"])],
    selected,
    touched,
  );
  assert.deepEqual(
    built.rows.map((r) => r.checked),
    [false, false, true],
    "復活直後からユーザーの選択が復元される",
  );
  selected = built.nextSelected;
  // ~1秒後: PUT echo がサーバ導出の category を届ける（overlaps-merged 描画）
  built = buildOverlapRows(
    [
      ov(1, ["a1", "b1"], "resolvable"),
      ov(21, ["a2", "b2"], "resolvable"),
      ov(41, ["a3", "b3"], "resolvable"),
    ],
    selected,
    touched,
  );
  assert.deepEqual(
    built.rows.map((r) => r.checked),
    [false, false, true],
    "echo 後も既定チェックに巻き戻らない（touched はユーザーの意思）",
  );
});

// Issue #45: category 未導出（サーバ echo 前）の触っていないペアは「不明」= 安全側 OFF。
// echo で resolvable が届いたら既定チェック（ON）が効く。#36 後は seen を介さず
// 「毎回分類から再評価する」だけで同じ保証になる。
test("buildOverlapRows: 分類未導出の新規ペアは echo 到着時に既定チェックが効く（#45）", () => {
  const touched = new Set();
  // 編集直後: 新規ペアは category null → 安全側 OFF
  let built = buildOverlapRows([ov(1, ["a9", "b9"])], new Set(), touched);
  assert.equal(built.rows[0].checked, false);
  // echo: resolvable → 既定 ON が入る
  built = buildOverlapRows([ov(1, ["a9", "b9"], "resolvable")], built.nextSelected, touched);
  assert.equal(built.rows[0].checked, true);
});

// Issue #45: ユーザー操作は分類未導出でも確定（touched 固定）。echo の既定チェックに負けない。
test("applySelection: 「不明」行のユーザーチェックが echo 後も維持される（#45）", () => {
  const selected = new Set();
  const touched = new Set();
  // 分類未導出の行（touched 未登録）をユーザーが ON にする
  assert.equal(applySelection(selected, touched, "a9|b9", true), true);
  assert.equal(touched.has("a9|b9"), true, "ユーザー操作で意思が記録される");
  // echo: contained（既定 OFF）が届いてもユーザーの ON が勝つ
  const built = buildOverlapRows([ov(1, ["a9", "b9"], "contained")], selected, touched);
  assert.equal(built.rows[0].checked, true);
  // OFF 操作も対称に動く
  applySelection(selected, touched, "a9|b9", false);
  assert.equal(selected.has("a9|b9"), false);
  assert.equal(touched.has("a9|b9"), true);
  // 壊れたペア（key null）は何もしない
  assert.equal(applySelection(selected, touched, null, true), false);
});

// ── Issue #36 改修①: 触っていない行は常に分類へ追従する ──
//
// 実機FB の症状そのもの: 自動調整の「被りを解消（N秒まで）」を下げると分類は
// 「解消可 → 長尺」へ変わるのに、元 resolvable でチェック済みだった行のチェックが残る。
// 旧実装は「一度描画した（seen）」と「ユーザーが触った」を区別しておらず、既定チェックで
// 入れた ON を意思として固定していた = 保護対象が自動編集の対象に混ざっていた。
test("buildOverlapRows: 触っていない行は分類変更に追従してチェックが外れる（#36）", () => {
  const touched = new Set(); // ユーザーは一度も触っていない
  // 閾値が広い状態: resolvable → 既定 ON
  let built = buildOverlapRows([ov(1, ["a1", "b1"], "resolvable")], new Set(), touched);
  assert.equal(built.rows[0].checked, true);
  assert.deepEqual([...built.nextSelected], ["a1|b1"]);
  // 閾値を下げた → サーバ分類が too_long（保護）へ変わる
  built = buildOverlapRows([ov(1, ["a1", "b1"], "too_long")], built.nextSelected, touched);
  assert.equal(built.rows[0].checked, false, "分類が保護側へ変われば自動で外れる");
  assert.equal(built.nextSelected.has("a1|b1"), false, "選択集合からも落ちる（target_pairs に残さない）");
});

test("buildOverlapRows: 触っていない行は保護→解消可の変化にも追従する（#36）", () => {
  const touched = new Set();
  let built = buildOverlapRows([ov(1, ["a1", "b1"], "too_long")], new Set(), touched);
  assert.equal(built.rows[0].checked, false);
  built = buildOverlapRows([ov(1, ["a1", "b1"], "resolvable")], built.nextSelected, touched);
  assert.equal(built.rows[0].checked, true, "解消可へ戻れば既定チェックも戻る");
});

test("buildOverlapRows: touched な行は分類が変わってもユーザー意思を保つ（#36）", () => {
  // ユーザーが保護対象（相槌）を手で ON にした → 分類が変わっても ON のまま
  const touched = new Set(["a1|b1"]);
  const selected = new Set(["a1|b1"]);
  for (const category of ["contained", "too_long", "same_start", "resolvable", undefined]) {
    const { rows } = buildOverlapRows([ov(1, ["a1", "b1"], category)], selected, touched);
    assert.equal(rows[0].checked, true, `category=${category} でもユーザーの ON が勝つ`);
  }
  // 逆向き（ユーザーが resolvable を手で OFF）も同じく固定される
  const off = new Set(["a2|b2"]);
  const { rows } = buildOverlapRows([ov(1, ["a2", "b2"], "resolvable")], new Set(), off);
  assert.equal(rows[0].checked, false, "手で外した解消可は既定 ON に巻き戻らない");
});

// Issue #45: 分割（ブロックIDが変わる）— 旧ペアと片IDを共有し区間が交差する新ペアへ
// 引き継ぐ（43b5b09 の分類引き継ぎと同じ考え方）。#36 で引き継ぐ対象を
// **touched な旧ペアだけ**に限定した（下の専用テストを参照）。
test("carryOverlapSelection: 分割相当のID変化ペアへユーザー意思を引き継ぐ（#45）", () => {
  // 直前描画: a2|b2（区間15-16）はユーザーが手で ON、a1|b1（区間1-2）は手で OFF
  const prevRows = [
    { overlap: ov(1, ["a1", "b1"], "resolvable"), key: "a1|b1" },
    { overlap: ov(15, ["a2", "b2"], "resolvable"), key: "a2|b2" },
  ];
  const selected = new Set(["a2|b2"]);
  const touched = new Set(["a1|b1", "a2|b2"]);
  // 分割: a2 → a2-r（右半分）。新ペア a2-r|b2 は同区間・b2 を共有
  const next = [ov(15, ["a2-r", "b2"])];
  const carried = carryOverlapSelection(prevRows, next, selected, touched);
  assert.equal(carried.touched.has("a2-r|b2"), true);
  assert.equal(carried.selected.has("a2-r|b2"), true, "ON の引き継ぎ");
  // 引き継ぎ後の行構築でチェック済みとして現れる（分類未導出でも維持される）
  const built = buildOverlapRows(next, carried.selected, carried.touched);
  assert.equal(built.rows[0].checked, true);
});

test("carryOverlapSelection: OFF の意思も引き継ぐ / 無関係な新規ペアには波及しない（#45）", () => {
  const prevRows = [{ overlap: ov(15, ["a2", "b2"], "resolvable"), key: "a2|b2" }];
  const selected = new Set(); // a2|b2 はユーザーが手で OFF にした
  const touched = new Set(["a2|b2"]);
  const next = [
    ov(15, ["a2-r", "b2"]), // 分割相当: b2 共有・区間交差 → OFF の意思を引き継ぐ
    ov(40, ["a7", "b7"]), // 無関係の新規ペア → 引き継がない（既定チェック経路へ）
    ov(15, ["a5", "b5"]), // 区間は重なるが ID 非共有 → 引き継がない
  ];
  const carried = carryOverlapSelection(prevRows, next, selected, touched);
  assert.equal(carried.touched.has("a2-r|b2"), true, "OFF の意思も引き継ぐ");
  assert.equal(carried.selected.has("a2-r|b2"), false);
  assert.equal(carried.touched.has("a7|b7"), false);
  assert.equal(carried.touched.has("a5|b5"), false);
  const built = buildOverlapRows(next, carried.selected, carried.touched);
  assert.deepEqual(
    built.rows.map((r) => r.checked),
    [false, false, false],
    "引き継ぎOFF / 新規は分類未導出のためOFF（echo後に既定が入る）",
  );
});

// Issue #36 改修①: 引き継ぎ対象は touched な旧ペアだけ。
//
// 【旧テスト「OFF も引き継ぐ」を書き直した理由】
// 旧仕様は「seen な旧ペア（= 一度描画しただけのペアを含む）」のチェックを、新ペアの
// category を**一切見ずに**引き継いでいた。分割した瞬間に旧ペアの既定チェックが
// 新ペアへ固定され、その後 echo で分類が届いても再評価されない = 改修①の症状が
// 分割経路でも再現する。守りたい契約は「ユーザーが手で決めたことは ID が変わっても
// 失われない」であって「一度描画した行のチェックを凍結する」ことではない。
// よって引き継ぐのは意思（touched）だけに絞り、意思でない既定チェックは新ペア側の
// 分類から導出し直す（buildOverlapRows の既定チェック経路）ことを固定する。
test("carryOverlapSelection: touched でない旧ペアからは引き継がない（#36）", () => {
  // 旧ペア a2|b2 は「既定チェックで ON になっていただけ」= ユーザーは触っていない
  const prevRows = [{ overlap: ov(15, ["a2", "b2"], "resolvable"), key: "a2|b2" }];
  const selected = new Set(["a2|b2"]);
  const touched = new Set(); // 空 = 意思なし
  const next = [ov(15, ["a2-r", "b2"])]; // 分割相当の新ペア
  const carried = carryOverlapSelection(prevRows, next, selected, touched);
  assert.equal(carried.touched.has("a2-r|b2"), false, "意思でないものは意思として刻まない");
  assert.equal(carried.selected.has("a2-r|b2"), false, "チェックも引き継がない");
  // 新ペアは自分の分類で決まる: 分類未導出なら安全側 OFF、echo で resolvable なら ON
  let built = buildOverlapRows(next, carried.selected, carried.touched);
  assert.equal(built.rows[0].checked, false, "分類が届くまでは保護側");
  built = buildOverlapRows([ov(15, ["a2-r", "b2"], "resolvable")], built.nextSelected, carried.touched);
  assert.equal(built.rows[0].checked, true, "echo で解消可が届けば既定 ON");
  // 保護分類が届いた場合は ON にならない（旧仕様なら引き継ぎ ON で固定されていた）
  built = buildOverlapRows([ov(15, ["a2-r", "b2"], "too_long")], built.nextSelected, carried.touched);
  assert.equal(built.rows[0].checked, false, "保護分類が届けば OFF へ追従する");
});

test("carryOverlapSelection: 空・壊れた入力でも安全", () => {
  const selected = new Set(["a1|b1"]);
  const touched = new Set(["a1|b1"]);
  // prevRows なし → そのままコピー
  let carried = carryOverlapSelection([], [ov(1, ["a2", "b2"])], selected, touched);
  assert.deepEqual([...carried.touched], ["a1|b1"]);
  // 壊れたペア（key null）や key 無し prevRow を混ぜても落ちない
  carried = carryOverlapSelection(
    [{ overlap: ov(1, ["a1"], "resolvable"), key: null }],
    [ov(1, ["a1"]), ov(2, ["a2", "b2"])],
    selected,
    touched,
  );
  assert.equal(carried.touched.has("a2|b2"), false);
  // 引数省略（touched/selected 未指定）でも落ちない
  assert.doesNotThrow(() => carryOverlapSelection(null, null, null, null));
});

test("buildOverlapRows: 選択キーは順不同で一致する（block_ids の並びに依存しない）", () => {
  const selected = new Set(["a1|b1"]);
  const touched = new Set(["a1|b1"]);
  const { rows } = buildOverlapRows([ov(1, ["b1", "a1"], "resolvable")], selected, touched);
  assert.equal(rows[0].checked, true);
});

test("buildOverlapRows: ペアが壊れた行は選択不能（key=null・常に未チェック）", () => {
  const { rows, nextSelected } = buildOverlapRows([ov(1, ["a1"], "resolvable")], new Set());
  assert.equal(rows[0].key, null);
  assert.equal(rows[0].checked, false);
  assert.equal(nextSelected.size, 0);
});

test("buildOverlapRows: 空・未定義の入力でも落ちない", () => {
  assert.deepEqual(buildOverlapRows([], new Set()).rows, []);
  assert.deepEqual(buildOverlapRows(null, new Set()).rows, []);
  assert.deepEqual(buildOverlapRows(undefined, new Set(), new Set()).rows, []);
  assert.deepEqual(buildOverlapRows(null, null, null).rows, []);
});

// ── Issue #36 改修②: 分類スナップショット（プレビュー起点の確定） ──
//
// 固定したい契約:
// - 確定済みペアの category はサーバ echo（閾値変更由来）で書き換わらない
// - 区間（start/end/block_ids・行の増減）は素通し = 従来どおり即時反映
// - スナップショットに無いペア（編集で新しく現れた被り）はサーバの category を採用する
// - 分類未導出（「不明」）は確定しない（確定すると echo が来ても永久に不明で固定される）

test("buildCategorySnapshot: 表示中の分類を pairKey → category で確定する（#36）", () => {
  const snapshot = buildCategorySnapshot([
    ov(1, ["a1", "b1"], "resolvable"),
    ov(21, ["a2", "b2"], "contained"),
    ov(41, ["a3", "b3"]), // 分類未導出 → 確定しない
    ov(60, ["a4"], "resolvable"), // 壊れたペア → 確定しない
  ]);
  assert.equal(snapshot.get("a1|b1"), "resolvable");
  assert.equal(snapshot.get("a2|b2"), "contained");
  assert.equal(snapshot.has("a3|b3"), false, "「不明」は確定しない（echo で分類が届く余地を残す）");
  assert.equal(snapshot.size, 2);
  // 空・未定義でも落ちない
  assert.equal(buildCategorySnapshot([]).size, 0);
  assert.equal(buildCategorySnapshot(null).size, 0);
});

test("applyCategorySnapshot: 閾値変更の echo では分類が変わらない（#36 の主眼）", () => {
  // プレビュー時点: a1|b1 = 解消可 で確定
  const snapshot = buildCategorySnapshot([ov(1, ["a1", "b1"], "resolvable")]);
  // 閾値を下げた直後の echo: サーバは too_long を返してくる
  const echoed = [ov(1, ["a1", "b1"], "too_long")];
  const shown = applyCategorySnapshot(echoed, snapshot);
  assert.equal(shown[0].category, "resolvable", "確定した分類のまま（プレビューまで待つ）");
  assert.equal(echoed[0].category, "too_long", "元配列（state 側の生データ）は壊さない");
});

test("applyCategorySnapshot: 区間・行の増減は素通しする（#36 の線引き）", () => {
  const snapshot = buildCategorySnapshot([ov(1, ["a1", "b1"], "resolvable")]);
  const echoed = [
    { ...ov(1, ["a1", "b1"], "contained"), start: 5, end: 7, duration: 2 }, // 区間が動いた
    ov(30, ["a9", "b9"], "contained"), // 編集で新しく現れた被り
  ];
  const shown = applyCategorySnapshot(echoed, snapshot);
  assert.equal(shown.length, 2, "行の増減は即時反映");
  assert.equal(shown[0].start, 5, "区間はスナップショットで固定しない");
  assert.equal(shown[0].end, 7);
  assert.equal(shown[0].category, "resolvable", "分類だけ確定値");
  assert.equal(shown[1].category, "contained", "スナップショットに無いペアはサーバの分類を採用");
});

test("applyCategorySnapshot: 分類未導出のサーバ応答にも確定値をかぶせる（#36）", () => {
  // 閾値を 0 にして classify_overlaps が ValueError → 全行「不明」になった場合でも
  // 確定済みの分類は見えたまま（補足バグを塞いだ後も安全側に倒れる二重の備え）
  const snapshot = buildCategorySnapshot([ov(1, ["a1", "b1"], "resolvable")]);
  const shown = applyCategorySnapshot([ov(1, ["a1", "b1"])], snapshot);
  assert.equal(shown[0].category, "resolvable");
});

test("applyCategorySnapshot: 空スナップショットは入力をそのまま返す（#36）", () => {
  const echoed = [ov(1, ["a1", "b1"], "resolvable")];
  assert.equal(applyCategorySnapshot(echoed, new Map()), echoed, "同一参照 = 無駄なコピーをしない");
  assert.equal(applyCategorySnapshot(echoed, null), echoed);
  assert.deepEqual(applyCategorySnapshot(null, new Map()), []);
});

test("applyCategorySnapshot: 確定分類は既定チェックにもそのまま効く（#36）", () => {
  // 一覧の見た目（チップ）とチェックの根拠が食い違わないこと。
  // 確定 = 解消可 なら、echo が too_long を返していてもチェックは ON のまま。
  const snapshot = buildCategorySnapshot([ov(1, ["a1", "b1"], "resolvable")]);
  const shown = applyCategorySnapshot([ov(1, ["a1", "b1"], "too_long")], snapshot);
  const { rows } = buildOverlapRows(shown, new Set(), new Set());
  assert.equal(rows[0].category, "resolvable");
  assert.equal(rows[0].checked, true);
  assert.deepEqual(toTargetPairs(rows), [["a1", "b1"]]);
});

// ── Issue #36: panels.renderOverlaps の手順を素の関数で再現したシナリオテスト ──
//
// renderOverlaps は DOM を触るので node から直接は呼べない。代わりに同じ順序
// （applyCategorySnapshot → carryOverlapSelection → buildOverlapRows）を組んだ
// ミニ実装で実機の流れを再現する。ここが実機FBの再現テスト本体。
// 手順を変えたらこのヘルパも合わせること（順序自体が契約の一部）。
// openingOverlaps: project-set 時点（プロジェクトを開いた瞬間）の overlaps。
// 実機と同じく、ここでスナップショットがシードされる（#36 QA）。
function makeList(openingOverlaps = null) {
  const s = freshOverlapState(openingOverlaps);
  let rows = [];
  return {
    // 1描画ぶん: サーバ由来の overlaps を受けて行を作る
    render(serverOverlaps) {
      const shown = applyCategorySnapshot(serverOverlaps, s.snapshot);
      const carried = carryOverlapSelection(rows, shown, s.selected, s.touched);
      const built = buildOverlapRows(shown, carried.selected, carried.touched);
      rows = built.rows;
      s.selected = built.nextSelected;
      s.touched = carried.touched;
      return rows;
    },
    // ユーザーがチェックを操作した（panels.setRowChecked 相当）
    check(key, checked) {
      applySelection(s.selected, s.touched, key, checked);
      const row = rows.find((r) => r.key === key);
      if (row) row.checked = checked;
    },
    // プレビュー/適用の成功（panels.confirmOverlapCategories 相当。
    // 元にするのは**サーバ由来の生データ**であって表示中の行ではない）
    confirm(serverOverlaps) {
      s.snapshot = buildCategorySnapshot(serverOverlaps);
      return this.render(serverOverlaps);
    },
    // プレビュー実行時の touched クリア（panels.clearOverlapTouched 相当）
    clearTouched(serverOverlaps) {
      s.touched = new Set();
      return this.render(serverOverlaps);
    },
    touchedCount: () => s.touched.size,
    state: () => s,
  };
}

// 改修① 実機FB の再現: 「被りを解消（N秒まで）」を下げると分類が 解消可 → 長尺 に
// 変わるのに、既定チェックで ON だった行のチェックが残っていた。
// 分類が実際に入れ替わる経路は**プレビューによる確定**（改修② の線引き）なので、
// ここも confirm() で新分類を通してからチェックの追従を見る。
test("シナリオ: 分類が保護側へ変わると、触っていない行のチェックは外れる（#36①）", () => {
  const opening = [ov(1, ["a1", "b1"], "resolvable"), ov(21, ["a2", "b2"], "resolvable")];
  const list = makeList(opening);
  // 初期描画: 2件とも解消可 → 既定 ON
  let rows = list.render(opening);
  assert.deepEqual(rows.map((r) => r.checked), [true, true]);
  assert.deepEqual(toTargetPairs(rows), [["a1", "b1"], ["a2", "b2"]]);
  // 閾値を下げて プレビュー → a1|b1 が長尺（保護）で確定
  rows = list.confirm([
    ov(1, ["a1", "b1"], "too_long"),
    ov(21, ["a2", "b2"], "resolvable"),
  ]);
  assert.deepEqual(rows.map((r) => r.checked), [false, true], "分類に追従して外れる");
  assert.deepEqual(toTargetPairs(rows), [["a2", "b2"]], "保護対象を自動編集へ送らない");
  assert.equal(list.touchedCount(), 0, "自動追従は touched を作らない");
});

test("シナリオ: 手で触った行は分類が変わってもユーザー意思のまま（#36①）", () => {
  const opening = [ov(1, ["a1", "b1"], "resolvable"), ov(21, ["a2", "b2"], "contained")];
  const list = makeList(opening);
  let rows = list.render(opening);
  // ユーザーが解消可を外し、相槌を手で入れた
  list.check("a1|b1", false);
  list.check("a2|b2", true);
  assert.equal(list.touchedCount(), 2);
  // プレビューで分類が総入れ替えされても意思は動かない
  rows = list.confirm([
    ov(1, ["a1", "b1"], "too_long"),
    ov(21, ["a2", "b2"], "resolvable"),
  ]);
  assert.deepEqual(rows.map((r) => r.checked), [false, true]);
  assert.deepEqual(toTargetPairs(rows), [["a2", "b2"]]);
});

// 改修②: プレビューを押すまで分類ラベルは動かない。押したら確定し直す。
test("シナリオ: 確定後は閾値変更の echo で分類が動かず、プレビューで確定し直す（#36②）", () => {
  const list = makeList();
  list.render([ov(1, ["a1", "b1"], "resolvable")]);
  // プレビュー成功 → 解消可で確定
  let rows = list.confirm([ov(1, ["a1", "b1"], "resolvable")]);
  assert.equal(rows[0].category, "resolvable");
  // 閾値をいじる → echo は too_long を返すが一覧は動かない
  rows = list.render([ov(1, ["a1", "b1"], "too_long")]);
  assert.equal(rows[0].category, "resolvable", "キーストロークで分類が書き換わらない");
  assert.equal(rows[0].checked, true);
  // もう一度プレビュー → その時点のサーバ分類で確定し直す
  rows = list.confirm([ov(1, ["a1", "b1"], "too_long")]);
  assert.equal(rows[0].category, "too_long", "プレビューが確定のトリガ");
  assert.equal(rows[0].checked, false, "確定分類に既定チェックも追従する");
});

test("シナリオ: 確定後でも編集で現れた新しい被りはサーバの分類で出る（#36②）", () => {
  const list = makeList();
  list.confirm([ov(1, ["a1", "b1"], "resolvable")]);
  // 編集で被りが1件増えた（閾値変更由来ではないので確定値と矛盾しない）
  const rows = list.render([
    ov(1, ["a1", "b1"], "too_long"), // 確定済み → 解消可のまま
    ov(30, ["a9", "b9"], "contained"), // 新規 → サーバの分類を採用
  ]);
  assert.deepEqual(rows.map((r) => r.category), ["resolvable", "contained"]);
  assert.deepEqual(rows.map((r) => r.checked), [true, false]);
});

test("シナリオ: 確定後も被り区間の増減は即時反映される（#36② の線引き）", () => {
  const list = makeList();
  list.confirm([ov(1, ["a1", "b1"], "resolvable"), ov(21, ["a2", "b2"], "resolvable")]);
  // 編集で a2|b2 の被りが解消された（行が消える）
  const rows = list.render([ov(1, ["a1", "b1"], "resolvable")]);
  assert.equal(rows.length, 1, "区間はスナップショットで固定しない");
});

// 改修③: 「はい」= touched をクリアして既定へ戻してからプレビューする
test("シナリオ: 確認ダイアログ「はい」でチェックが既定へ戻る（#36③）", () => {
  const list = makeList();
  const server = [ov(1, ["a1", "b1"], "resolvable"), ov(21, ["a2", "b2"], "contained")];
  list.render(server);
  // ユーザーが既定を崩した
  list.check("a1|b1", false);
  list.check("a2|b2", true);
  assert.equal(list.touchedCount(), 2, "この状態でプレビューを押すと確認が出る");
  // 「はい」→ touched クリア → 既定（解消可のみ ON）へ
  const rows = list.clearTouched(server);
  assert.equal(list.touchedCount(), 0);
  assert.deepEqual(rows.map((r) => r.checked), [true, false]);
  assert.deepEqual(toTargetPairs(rows), [["a1", "b1"]], "既定の内容でプレビューが走る");
});

test("freshOverlapState: 選択・touched・カーソルは空でリセットされる（#36）", () => {
  const fresh = freshOverlapState();
  assert.equal(fresh.selected.size, 0);
  assert.equal(fresh.touched.size, 0);
  assert.equal(fresh.snapshot.size, 0, "overlaps 未指定なら空スナップショット");
  assert.equal(fresh.cursorIndex, -1);
  // 呼ぶたびに独立したインスタンス（使い回すと世代間で状態が漏れる）
  const other = freshOverlapState();
  other.touched.add("a1|b1");
  other.snapshot.set("a1|b1", "resolvable");
  assert.equal(fresh.touched.size, 0);
  assert.equal(fresh.snapshot.size, 0);
});

// #36 QA（最優先指摘）: 空スナップショットで始めると、プロジェクトを開いて
// 一度もプレビューせずに閾値を触った場合に限り echo の新分類が素通りし、
// 「プレビューを押すまで分類は動かない」が**初回だけ成立しない**。
// project-set で開いた時点の分類をシードして塞ぐ。
test("freshOverlapState: 開いた時点の分類でスナップショットをシードする（#36 QA）", () => {
  const fresh = freshOverlapState([
    ov(1, ["a1", "b1"], "resolvable"),
    ov(21, ["a2", "b2"], "contained"),
    ov(41, ["a3", "b3"]), // 分類未導出 → 確定しない（echo で分類が届く余地を残す）
  ]);
  assert.equal(fresh.snapshot.get("a1|b1"), "resolvable");
  assert.equal(fresh.snapshot.get("a2|b2"), "contained");
  assert.equal(fresh.snapshot.has("a3|b3"), false);
  // シードしても他の状態は空のまま（リセット契約は変わらない）
  assert.equal(fresh.selected.size, 0);
  assert.equal(fresh.touched.size, 0);
  assert.equal(fresh.cursorIndex, -1);
  // null / 空でも落ちない
  assert.equal(freshOverlapState(null).snapshot.size, 0);
  assert.equal(freshOverlapState([]).snapshot.size, 0);
});

// #36 QA 再現手順の固定（**この改修の主目的が初回に効くこと**）:
// プロジェクトを開く → 一度もプレビューしない → 閾値を触る → echo で too_long が届く。
// 修正前はここで表示分類が変わり、プレビュー起点の確定が初回だけ破れていた。
test("シナリオ: 開いた直後・プレビュー未実行でも echo で分類が変わらない（#36 QA）", () => {
  const opening = [ov(1, ["a1", "b1"], "resolvable"), ov(21, ["a2", "b2"], "resolvable")];
  const list = makeList(opening); // project-set でシード済み
  let rows = list.render(opening);
  assert.deepEqual(rows.map((r) => r.category), ["resolvable", "resolvable"]);
  assert.deepEqual(rows.map((r) => r.checked), [true, true]);
  // プレビューを一度も押さずに閾値を下げた → echo が保護分類を返してくる
  rows = list.render([
    ov(1, ["a1", "b1"], "too_long"),
    ov(21, ["a2", "b2"], "same_start"),
  ]);
  assert.deepEqual(
    rows.map((r) => r.category),
    ["resolvable", "resolvable"],
    "初回でもキーストロークで分類は動かない（ここが QA 最優先指摘の再現点）",
  );
  assert.deepEqual(rows.map((r) => r.checked), [true, true], "チェックも動かない");
  // プレビューを押して初めて確定し直す
  rows = list.confirm([
    ov(1, ["a1", "b1"], "too_long"),
    ov(21, ["a2", "b2"], "same_start"),
  ]);
  assert.deepEqual(rows.map((r) => r.category), ["too_long", "same_start"]);
  assert.deepEqual(rows.map((r) => r.checked), [false, false]);
});

test("シナリオ: 開いた時点で分類未導出の行は echo の分類を受け取れる（#36 QA）", () => {
  // シードは「不明」を確定しないので、開いた直後に分類が無かった行は
  // echo が届いた時点で正しい分類・既定チェックになる（#45 の保証を壊さない）
  const opening = [ov(1, ["a9", "b9"])];
  const list = makeList(opening);
  let rows = list.render(opening);
  assert.equal(rows[0].category, null);
  assert.equal(rows[0].checked, false, "分類が届くまでは安全側 OFF");
  rows = list.render([ov(1, ["a9", "b9"], "resolvable")]);
  assert.equal(rows[0].category, "resolvable", "シードに無い行は echo の分類を採用");
  assert.equal(rows[0].checked, true);
});

test("シナリオ: project-set 後は前プロジェクトの touched・確定分類が残らない（#36）", () => {
  const opening = [ov(1, ["a1", "b1"], "resolvable")];
  const list = makeList(opening);
  list.render(opening);
  list.check("a1|b1", false);
  list.confirm(opening);
  assert.equal(list.touchedCount(), 1);
  // project-set 相当: 新プロジェクトの overlaps で一時状態を丸ごと入れ替える
  const s = list.state();
  const nextProject = [ov(1, ["a1", "b1"], "contained")];
  const fresh = freshOverlapState(nextProject);
  s.selected = fresh.selected;
  s.touched = fresh.touched;
  s.snapshot = fresh.snapshot;
  // 別プロジェクトで**たまたま同じペアキー**が現れても、意思も前世代の確定分類も持ち越さない
  const rows = list.render(nextProject);
  assert.equal(list.touchedCount(), 0);
  assert.equal(rows[0].category, "contained", "前プロジェクトの確定分類を持ち越さない");
  assert.equal(rows[0].checked, false, "前プロジェクトの OFF 意思を持ち越さない");
});

// ── D: target_pairs（省略 vs 空配列の事故防止） ──────────

test("toTargetPairs: チェック済みの行だけをペア配列で返す", () => {
  const { rows } = buildOverlapRows(
    [ov(1, ["a1", "b1"], "resolvable"), ov(21, ["a2", "b2"], "contained"), ov(41, ["a3", "b3"], "resolvable")],
    new Set(),
    false,
  );
  assert.deepEqual(toTargetPairs(rows), [
    ["a1", "b1"],
    ["a3", "b3"],
  ]);
});

test("toTargetPairs: 全解除でも undefined ではなく空配列を返す（全件適用への化け防止）", () => {
  const { rows } = buildOverlapRows([ov(1, ["a1", "b1"], "contained")], new Set());
  const pairs = toTargetPairs(rows);
  assert.ok(Array.isArray(pairs), "配列であること");
  assert.equal(pairs.length, 0);
  // 空・null 入力でも配列（サーバ契約: 省略/null=全件、[]=0件）
  assert.deepEqual(toTargetPairs([]), []);
  assert.deepEqual(toTargetPairs(null), []);
  assert.deepEqual(toTargetPairs(undefined), []);
});

test("toTargetPairs: 壊れたペアは送らない", () => {
  const rows = [
    { key: null, checked: true },
    { key: "a1|b1", checked: true },
  ];
  assert.deepEqual(toTargetPairs(rows), [["a1", "b1"]]);
});

// ── D: 送信ペイロード（api.postAutoEdit の許可キー） ────

async function capturePayload(opts) {
  const original = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ dry_run: true }) };
  };
  try {
    await postAutoEdit("proj-x", opts);
  } finally {
    globalThis.fetch = original;
  }
  return sent;
}

test("postAutoEdit: target_pairs をそのまま送る（空配列も落とさない）", async () => {
  const sent = await capturePayload({ dry_run: true, target_pairs: [] });
  assert.ok("target_pairs" in sent, "空配列でもキーが残ること（省略=全件適用への化け防止）");
  assert.deepEqual(sent.target_pairs, []);
});

test("postAutoEdit: 選択したペアが送られる", async () => {
  const sent = await capturePayload({
    dry_run: false,
    tighten_overlaps: true,
    target_pairs: [["a1", "b1"], ["a3", "b3"]],
  });
  assert.deepEqual(sent.target_pairs, [["a1", "b1"], ["a3", "b3"]]);
});

test("postAutoEdit: target_pairs 未指定なら送らない（= サーバ側は全件）", async () => {
  const sent = await capturePayload({ dry_run: true, tighten_gaps: true });
  assert.equal("target_pairs" in sent, false);
});

// ── C/D: サマリー整形 ───────────────────────────────────

test("formatOverlapSummary: 解消可 / 保護 / 選択中の件数", () => {
  const { rows } = buildOverlapRows(
    [
      ov(1, ["a1", "b1"], "resolvable"),
      ov(21, ["a2", "b2"], "resolvable"),
      ov(41, ["a3", "b3"], "contained"),
      ov(60, ["a4", "b4"], "too_long"),
      ov(80, ["a5", "b5"]), // 欠損 → 保護側に数える
    ],
    new Set(),
    false,
  );
  assert.equal(formatOverlapSummary(rows), "解消可 2件 / 保護 3件 — 選択中 2件");
});

test("formatOverlapSummary: 空リスト・未定義", () => {
  assert.equal(formatOverlapSummary([]), "解消可 0件 / 保護 0件 — 選択中 0件");
  assert.equal(formatOverlapSummary(null), "解消可 0件 / 保護 0件 — 選択中 0件");
});

// ── E: Prev/Next インデックス（Issue #52: 解消可の行だけに飛ぶ） ──

// rows は panels の overlapRows 形式のうちナビが読む category だけを持てばよい
const R = { category: "resolvable" };
const C = { category: "contained" }; // 相槌
const L = { category: "too_long" };  // 長尺
const U = {};                        // 不明（category 未導出 = echo 前。#45 と整合）

test("stepResolvableIndex: 解消可の行だけが選ばれる（保護・不明はスキップ）", () => {
  const rows = [C, R, U, L, R, C];
  assert.equal(stepResolvableIndex(rows, -1, 1), 1);
  assert.equal(stepResolvableIndex(rows, 1, 1), 4); // 不明・長尺を飛び越える
  assert.equal(stepResolvableIndex(rows, 4, -1), 1);
});

test("stepResolvableIndex: 未選択(-1)からは next=先頭側 / prev=末尾側の解消可", () => {
  const rows = [C, R, L, R, U];
  assert.equal(stepResolvableIndex(rows, -1, 1), 1);
  assert.equal(stepResolvableIndex(rows, -1, -1), 3);
});

test("stepResolvableIndex: 現在位置が非解消可でも次/前の解消可へ飛ぶ", () => {
  const rows = [R, C, U, R];
  assert.equal(stepResolvableIndex(rows, 1, 1), 3);
  assert.equal(stepResolvableIndex(rows, 2, -1), 0);
});

test("stepResolvableIndex: 解消可0件は常に -1（無反応）", () => {
  const rows = [C, U, L];
  assert.equal(stepResolvableIndex(rows, -1, 1), -1);
  assert.equal(stepResolvableIndex(rows, -1, -1), -1);
  assert.equal(stepResolvableIndex(rows, 1, 1), -1);
  assert.equal(stepResolvableIndex([], -1, 1), -1);
  assert.equal(stepResolvableIndex(null, 0, -1), -1);
});

test("stepResolvableIndex: その方向に解消可が無ければ -1（端で止まる。ラップしない）", () => {
  const rows = [C, R, R, U];
  assert.equal(stepResolvableIndex(rows, 2, 1), -1);  // 末尾側に解消可なし
  assert.equal(stepResolvableIndex(rows, 1, -1), -1); // 先頭側に解消可なし
  assert.equal(stepResolvableIndex(rows, 3, 1), -1);  // 非解消可の末尾からも同じ
});

test("stepResolvableIndex: 範囲外・非整数の current は端から入り直す", () => {
  const rows = [C, R, R, C];
  assert.equal(stepResolvableIndex(rows, 99, 1), 1); // 一覧が縮んだ後
  assert.equal(stepResolvableIndex(rows, 99, -1), 2);
  assert.equal(stepResolvableIndex(rows, 1.5, 1), 1);
  assert.equal(stepResolvableIndex(rows, NaN, -1), 2);
});

// Prev/Next ボタンの disabled 判定（panels.updateOverlapNav）と境界が一致すること:
// disabled = stepResolvableIndex < 0 をそのまま使うため「押せるのに動かない」
// 「動けるのに押せない」を作らない。解消可0件では両方向 disabled になる。
test("stepResolvableIndex: ボタンの有効/無効判定と境界が一致する", () => {
  for (const rows of [[C, R, U, R, L], [C, U, L], []]) {
    for (let cur = -1; cur < rows.length; cur += 1) {
      for (const delta of [-1, 1]) {
        const target = stepResolvableIndex(rows, cur, delta);
        const disabled = target < 0;
        if (!disabled) {
          assert.equal(rows[target].category, "resolvable", `rows@${cur} delta=${delta}`);
          assert.notEqual(target, cur, "移動先は必ず現在位置と異なる");
        }
      }
    }
  }
});

test("stepResolvableIndex: 連打で解消可だけを順に巡回できる（往復で元に戻る）", () => {
  const rows = [C, R, U, R, L, R];
  const seen = [];
  let i = -1;
  for (;;) {
    const next = stepResolvableIndex(rows, i, 1);
    if (next < 0) break;
    i = next;
    seen.push(i);
  }
  assert.deepEqual(seen, [1, 3, 5]);
  for (let n = 0; n < 2; n += 1) i = stepResolvableIndex(rows, i, -1);
  assert.equal(i, 1);
});

// ── E+: 一覧フォーカス時のキー → アクション（Issue #20） ──

test("overlapKeyAction: 矢印キーの割り当て（←→=移動 / ↑=再生 / ↓=チェック切替）", () => {
  assert.equal(overlapKeyAction("ArrowLeft"), "prev");
  assert.equal(overlapKeyAction("ArrowRight"), "next");
  assert.equal(overlapKeyAction("ArrowUp"), "play");
  assert.equal(overlapKeyAction("ArrowDown"), "toggle");
});

test("overlapKeyAction: A/D/W/S は矢印キーの別名（大文字・小文字とも）", () => {
  const alias = [
    ["a", "prev"],
    ["A", "prev"],
    ["d", "next"],
    ["D", "next"],
    ["w", "play"],
    ["W", "play"],
    ["s", "toggle"],
    ["S", "toggle"],
  ];
  for (const [key, action] of alias) {
    assert.equal(overlapKeyAction(key), action, `${key} → ${action}`);
  }
});

test("overlapKeyAction: S はグローバルの分割ではなくチェック切替に割り当てる", () => {
  // フォーカス中は stopPropagation で interactions の S=分割 を抑止する前提の契約。
  // ここが "toggle" 以外になったら一覧フォーカス中の S の意味が壊れている。
  assert.equal(overlapKeyAction("s"), "toggle");
  assert.equal(overlapKeyAction("S"), "toggle");
});

test("overlapKeyAction: 割り当て外のキーは null（グローバルキーを奪わない）", () => {
  // Space（再生/停止）・Delete（ブロック削除）等はフォーカス中もグローバルへ素通しする
  for (const key of [" ", "Enter", "Delete", "Backspace", "0", "+", "-", "z", "Escape", "Tab", "", undefined, null]) {
    assert.equal(overlapKeyAction(key), null, String(key));
  }
});

// ── L: 正規化状態の表示 ─────────────────────────────────

test("normalizeStatusLabel: トップレベル loudness_normalized を読む", () => {
  const t = { original_file: "a.mp3", normalized_wav: "a_norm.wav" };
  assert.equal(normalizeStatusLabel({ ...t, loudness_normalized: true }), "正規化済み");
  assert.equal(normalizeStatusLabel({ ...t, loudness_normalized: false }), "未正規化");
  assert.equal(normalizeStatusLabel(t), "未正規化");
});

test("normalizeStatusLabel: 未取込トラック", () => {
  assert.equal(normalizeStatusLabel({ original_file: "", normalized_wav: "" }), "未取込");
  assert.equal(normalizeStatusLabel(null), "未取込");
  assert.equal(normalizeStatusLabel(undefined), "未取込");
});

test("normalizeStatusLabel: 原音なしで開いても正規化済みの事実が残る", () => {
  // 可搬エクスポートを normalized_wav だけで開いたケース（QA指摘）。
  // 判定を original_file 基準にすると「未取込」に化けて正規化済みの事実が失われる。
  assert.equal(
    normalizeStatusLabel({
      original_file: "",
      normalized_wav: "speakerA_normalized.wav",
      loudness_normalized: true,
    }),
    "正規化済み（元音源なし）",
  );
});

// ── Issue #44-2: 許容量スキップ（#37）を「正規化済み」と区別する ──

test("normalizeStatusLabel: 許容量スキップは計測値付きで区別する", () => {
  const t = {
    original_file: "a.mp3",
    normalized_wav: "a_norm.wav",
    loudness_normalized: true,
  };
  // loudness.input は ffmpeg loudnorm JSON そのまま = 値は文字列（"-16.30"）
  assert.equal(
    normalizeStatusLabel({
      ...t,
      loudness: { normalization_skipped: true, input: { input_i: "-16.30" } },
    }),
    "許容量内・スキップ（計測 -16.3 LUFS）",
  );
  // 数値でも同じ表示（1桁丸め）
  assert.equal(
    normalizeStatusLabel({
      ...t,
      loudness: { normalization_skipped: true, input: { input_i: -15.97 } },
    }),
    "許容量内・スキップ（計測 -16.0 LUFS）",
  );
});

test("normalizeStatusLabel: スキップだが計測値が引けない場合は計測部を省く", () => {
  const t = {
    original_file: "a.mp3",
    normalized_wav: "a_norm.wav",
    loudness_normalized: true,
  };
  for (const loudness of [
    { normalization_skipped: true },
    { normalization_skipped: true, input: {} },
    { normalization_skipped: true, input: { input_i: "not-a-number" } },
  ]) {
    assert.equal(normalizeStatusLabel({ ...t, loudness }), "許容量内・スキップ");
  }
});

test("normalizeStatusLabel: スキップ + 元音源なしは両方の情報を残す", () => {
  assert.equal(
    normalizeStatusLabel({
      original_file: "",
      normalized_wav: "a_norm.wav",
      loudness_normalized: true,
      loudness: { normalization_skipped: true, input: { input_i: "-16.10" } },
    }),
    "許容量内・スキップ（計測 -16.1 LUFS）（元音源なし）",
  );
});

test("normalizeStatusLabel: スキップフラグなしの loudness は従来表示のまま", () => {
  // 通常の正規化完了（normalization_skipped 無し）が誤ってスキップ表示に化けないこと
  assert.equal(
    normalizeStatusLabel({
      original_file: "a.mp3",
      normalized_wav: "a_norm.wav",
      loudness_normalized: true,
      loudness: { input: { input_i: "-18.20" }, normalized: { input_i: "-16.05" } },
    }),
    "正規化済み",
  );
  // 未正規化判定（loudness_normalized: false）はスキップフラグより優先される
  // （convert_to_pcm 経路は normalization_skipped を立てないが、安全側の固定）
  assert.equal(
    normalizeStatusLabel({
      original_file: "a.mp3",
      normalized_wav: "a_norm.wav",
      loudness_normalized: false,
      loudness: { normalization_skipped: true },
    }),
    "未正規化",
  );
});

// ── G: エクスポート結果 ─────────────────────────────────

test("exportResultOf: output_dir と files を取り出す", () => {
  const job = {
    result: {
      output_dir: "/tmp/proj/exports/take2",
      files: ["overlaps.csv", "speakerA.wav"],
      file_paths: { "speakerA.wav": "/tmp/proj/exports/take2/speakerA.wav" },
    },
  };
  assert.deepEqual(exportResultOf(job), {
    dir: "/tmp/proj/exports/take2",
    files: ["overlaps.csv", "speakerA.wav"],
  });
});

test("exportResultOf: output_dir が無い/空なら null", () => {
  assert.equal(exportResultOf(null), null);
  assert.equal(exportResultOf({}), null);
  assert.equal(exportResultOf({ result: {} }), null);
  assert.equal(exportResultOf({ result: { output_dir: "" } }), null);
  assert.equal(exportResultOf({ result: { output_dir: 42 } }), null);
});

test("exportResultOf: files が dict/欠損でも落ちない（旧形式互換）", () => {
  assert.deepEqual(exportResultOf({ result: { output_dir: "/x" } }), { dir: "/x", files: [] });
  assert.deepEqual(exportResultOf({ result: { output_dir: "/x", files: { a: "/x/a" } } }), {
    dir: "/x",
    files: [],
  });
});
