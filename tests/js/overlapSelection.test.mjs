// C/D/E/L/G のフロント純関数テスト（panels.js のエクスポート群）。
// panels.js はモジュールトップで DOM に触らないため node で import できる（回帰検知も兼ねる）。
//
// 固定したい契約:
// - C: category 欠損/未知は「不明」= 保護扱い（安全側フォールバック）
// - D: 既定チェックは `=== "resolvable"` の肯定形。undefined が ON にならないこと
// - D: target_pairs は**常に配列**（省略＝全件適用への化けを防ぐ。BE1 申し送り3）
// - E: Prev/Next は解消可の行だけに飛ぶ（#52）。端で止まりラップしない。0件は無反応
// - G: output_dir 欠損のジョブは表示対象にしない

import test from "node:test";
import assert from "node:assert/strict";

import { postAutoEdit } from "../../src/podcast_prep/static/js/api.js";
import {
  applySelection,
  buildOverlapRows,
  carryOverlapSelection,
  categoryInfo,
  defaultChecked,
  exportResultOf,
  formatOverlapSummary,
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

test("buildOverlapRows: 未シード時は resolvable だけ ON", () => {
  const overlaps = [
    ov(1, ["a1", "b1"], "resolvable"),
    ov(21, ["a2", "b2"], "contained"),
    ov(41, ["a3", "b3"], "too_long"),
    ov(60, ["a4", "b4"], "same_start"),
    ov(80, ["a5", "b5"]), // category 欠損
  ];
  const { rows, nextSelected } = buildOverlapRows(overlaps, new Set(), false);
  assert.deepEqual(
    rows.map((r) => r.checked),
    [true, false, false, false, false],
  );
  assert.deepEqual([...nextSelected], ["a1|b1"]);
});

test("buildOverlapRows: シード済み・既知ペアはユーザーの選択をそのまま反映する", () => {
  const overlaps = [
    ov(1, ["a1", "b1"], "resolvable"),
    ov(21, ["a2", "b2"], "contained"),
  ];
  // ユーザーが resolvable を外し、保護対象を手動で入れた状態
  const selected = new Set(["a2|b2"]);
  const seen = new Set(["a1|b1", "a2|b2"]);
  const { rows, nextSelected } = buildOverlapRows(overlaps, selected, true, seen);
  assert.deepEqual(
    rows.map((r) => r.checked),
    [false, true],
  );
  assert.deepEqual([...nextSelected], ["a2|b2"]);
});

test("buildOverlapRows: 編集で新しく現れた被りには既定チェックが入る", () => {
  // a1|b1 は既知（ユーザーが外した）、a9|b9 は編集で新規に生まれた resolvable
  const overlaps = [
    ov(1, ["a1", "b1"], "resolvable"),
    ov(30, ["a9", "b9"], "resolvable"),
    ov(50, ["a8", "b8"], "contained"), // 新規だが保護 → OFF のまま
  ];
  const selected = new Set();
  const seen = new Set(["a1|b1"]);
  const { rows, nextSelected, nextSeen } = buildOverlapRows(overlaps, selected, true, seen);
  assert.deepEqual(
    rows.map((r) => r.checked),
    [false, true, false],
    "既知=選択尊重 / 新規resolvable=ON / 新規保護=OFF",
  );
  assert.deepEqual([...nextSelected], ["a9|b9"]);
  assert.deepEqual([...nextSeen].sort(), ["a1|b1", "a8|b8", "a9|b9"]);
});

// Issue #45: 消えたペアの記録は保持する（頭出しのオーバーシュート→戻しで一時的に
// 消えたペアが、復活時にユーザーの選択を取り戻すため）。行としては自然消滅する。
test("buildOverlapRows: 一時的に消えたペアの選択・既知記録を保持する", () => {
  const selected = new Set(["a1|b1", "gone1|gone2"]);
  const seen = new Set(["a1|b1", "gone1|gone2"]);
  const { rows, nextSelected, nextSeen } = buildOverlapRows(
    [ov(1, ["a1", "b1"], "resolvable")],
    selected,
    true,
    seen,
  );
  assert.equal(rows.length, 1, "行は現存ペアのみ（消えたペアは自然消滅）");
  assert.deepEqual([...nextSelected].sort(), ["a1|b1", "gone1|gone2"]);
  assert.deepEqual([...nextSeen].sort(), ["a1|b1", "gone1|gone2"]);
});

// Issue #45 再現手順の固定（頭出し）: チェック編集 → ペアが一時消滅 → 復活
// （ローカルスイープ直後は category null）→ echo で分類が届く、の全描画をまたいで
// ユーザーの選択が維持されること。修正前は復活時に「既知・未選択」へ固定され全て外れた。
test("buildOverlapRows: 消滅→復活→echo をまたいでチェックが維持される（#45 頭出し）", () => {
  // 初期: 3ペア。ユーザー編集で k1=off / k2=off / k3=on
  let selected = new Set(["a3|b3"]);
  let seen = new Set(["a1|b1", "a2|b2", "a3|b3"]);
  // 頭出しオーバーシュート: 全ペア消滅（blocks-changed 描画）
  let built = buildOverlapRows([], selected, true, seen);
  selected = built.nextSelected;
  seen = built.nextSeen;
  // 戻し: 全ペア復活。ローカルスイープは分類を引き継げない（category null）
  built = buildOverlapRows(
    [ov(1, ["a1", "b1"]), ov(21, ["a2", "b2"]), ov(41, ["a3", "b3"])],
    selected,
    true,
    seen,
  );
  assert.deepEqual(
    built.rows.map((r) => r.checked),
    [false, false, true],
    "復活直後からユーザーの選択が復元される",
  );
  selected = built.nextSelected;
  seen = built.nextSeen;
  // ~1秒後: PUT echo がサーバ導出の category を届ける（overlaps-merged 描画）
  built = buildOverlapRows(
    [
      ov(1, ["a1", "b1"], "resolvable"),
      ov(21, ["a2", "b2"], "resolvable"),
      ov(41, ["a3", "b3"], "resolvable"),
    ],
    selected,
    true,
    seen,
  );
  assert.deepEqual(
    built.rows.map((r) => r.checked),
    [false, false, true],
    "echo 後も既定チェックに巻き戻らない",
  );
});

// Issue #45: category 未導出（サーバ echo 前）の初見ペアは seen に刻まない。
// 刻むと echo で resolvable が届いても既定チェック（ON）が一生効かない。
test("buildOverlapRows: 分類未導出の新規ペアは echo 到着時に既定チェックが効く（#45）", () => {
  let selected = new Set();
  let seen = new Set();
  // 編集直後: 新規ペアは category null → 安全側 OFF・判断は保留
  let built = buildOverlapRows([ov(1, ["a9", "b9"])], selected, true, seen);
  assert.equal(built.rows[0].checked, false);
  assert.equal(built.nextSeen.has("a9|b9"), false, "分類が届くまで既定チェックを確定しない");
  selected = built.nextSelected;
  seen = built.nextSeen;
  // echo: resolvable → 既定 ON が入り、ここで確定
  built = buildOverlapRows([ov(1, ["a9", "b9"], "resolvable")], selected, true, seen);
  assert.equal(built.rows[0].checked, true);
  assert.equal(built.nextSeen.has("a9|b9"), true);
});

// Issue #45: ユーザー操作は分類未導出でも確定（seen 固定）。echo の既定チェックに負けない。
test("applySelection: 「不明」行のユーザーチェックが echo 後も維持される（#45）", () => {
  const selected = new Set();
  const seen = new Set();
  // 分類未導出の行（seen 未登録）をユーザーが ON にする
  assert.equal(applySelection(selected, seen, "a9|b9", true), true);
  assert.equal(seen.has("a9|b9"), true, "ユーザー操作で判断が確定する");
  // echo: contained（既定 OFF）が届いてもユーザーの ON が勝つ
  const built = buildOverlapRows([ov(1, ["a9", "b9"], "contained")], selected, true, seen);
  assert.equal(built.rows[0].checked, true);
  // OFF 操作も対称に動く
  applySelection(selected, seen, "a9|b9", false);
  assert.equal(selected.has("a9|b9"), false);
  assert.equal(seen.has("a9|b9"), true);
  // 壊れたペア（key null）は何もしない
  assert.equal(applySelection(selected, seen, null, true), false);
});

// Issue #45: 分割（ブロックIDが変わる）— 旧ペアと片IDを共有し区間が交差する新ペアへ
// チェック・既知記録を引き継ぐ（43b5b09 の分類引き継ぎと同じ考え方）。
test("carryOverlapSelection: 分割相当のID変化ペアへチェックを引き継ぐ（#45）", () => {
  // 直前描画: a2|b2（区間15-16）はユーザーが ON、a1|b1（区間1-2）は OFF
  const prevRows = [
    { overlap: ov(1, ["a1", "b1"], "resolvable"), key: "a1|b1" },
    { overlap: ov(15, ["a2", "b2"], "resolvable"), key: "a2|b2" },
  ];
  const selected = new Set(["a2|b2"]);
  const seen = new Set(["a1|b1", "a2|b2"]);
  // 分割: a2 → a2-r（右半分）。新ペア a2-r|b2 は同区間・b2 を共有
  const next = [ov(15, ["a2-r", "b2"])];
  const carried = carryOverlapSelection(prevRows, next, selected, seen);
  assert.equal(carried.seen.has("a2-r|b2"), true);
  assert.equal(carried.selected.has("a2-r|b2"), true, "ON の引き継ぎ");
  // 引き継ぎ後の行構築でチェック済みとして現れる
  const built = buildOverlapRows(next, carried.selected, true, carried.seen);
  assert.equal(built.rows[0].checked, true);
});

test("carryOverlapSelection: OFF も引き継ぐ / 無関係な新規ペアには波及しない（#45）", () => {
  const prevRows = [{ overlap: ov(15, ["a2", "b2"], "resolvable"), key: "a2|b2" }];
  const selected = new Set(); // a2|b2 はユーザーが OFF
  const seen = new Set(["a2|b2"]);
  const next = [
    ov(15, ["a2-r", "b2"]), // 分割相当: b2 共有・区間交差 → OFF を引き継ぐ
    ov(40, ["a7", "b7"]), // 無関係の新規ペア → 引き継がない（既定チェック経路へ）
    ov(15, ["a5", "b5"]), // 区間は重なるが ID 非共有 → 引き継がない
  ];
  const carried = carryOverlapSelection(prevRows, next, selected, seen);
  assert.equal(carried.seen.has("a2-r|b2"), true, "OFF の判断も確定として引き継ぐ");
  assert.equal(carried.selected.has("a2-r|b2"), false);
  assert.equal(carried.seen.has("a7|b7"), false);
  assert.equal(carried.seen.has("a5|b5"), false);
  const built = buildOverlapRows(next, carried.selected, true, carried.seen);
  assert.deepEqual(
    built.rows.map((r) => r.checked),
    [false, false, false],
    "引き継ぎOFF / 新規は分類未導出のためOFF（echo後に既定が入る）",
  );
});

test("carryOverlapSelection: 空・壊れた入力でも安全", () => {
  const selected = new Set(["a1|b1"]);
  const seen = new Set(["a1|b1"]);
  // prevRows なし → そのままコピー
  let carried = carryOverlapSelection([], [ov(1, ["a2", "b2"])], selected, seen);
  assert.deepEqual([...carried.seen], ["a1|b1"]);
  // 壊れたペア（key null）や key 無し prevRow を混ぜても落ちない
  carried = carryOverlapSelection(
    [{ overlap: ov(1, ["a1"], "resolvable"), key: null }],
    [ov(1, ["a1"]), ov(2, ["a2", "b2"])],
    selected,
    seen,
  );
  assert.equal(carried.seen.has("a2|b2"), false);
});

test("buildOverlapRows: 選択キーは順不同で一致する（block_ids の並びに依存しない）", () => {
  const selected = new Set(["a1|b1"]);
  const seen = new Set(["a1|b1"]);
  const { rows } = buildOverlapRows([ov(1, ["b1", "a1"], "resolvable")], selected, true, seen);
  assert.equal(rows[0].checked, true);
});

test("buildOverlapRows: ペアが壊れた行は選択不能（key=null・常に未チェック）", () => {
  const { rows, nextSelected } = buildOverlapRows([ov(1, ["a1"], "resolvable")], new Set(), false);
  assert.equal(rows[0].key, null);
  assert.equal(rows[0].checked, false);
  assert.equal(nextSelected.size, 0);
});

test("buildOverlapRows: 空・未定義の入力でも落ちない", () => {
  assert.deepEqual(buildOverlapRows([], new Set(), false).rows, []);
  assert.deepEqual(buildOverlapRows(null, new Set(), false).rows, []);
  assert.deepEqual(buildOverlapRows(undefined, new Set(), true).rows, []);
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
  const { rows } = buildOverlapRows([ov(1, ["a1", "b1"], "contained")], new Set(), false);
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
