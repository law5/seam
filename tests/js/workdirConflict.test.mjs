// Issue #53: 作業フォルダ衝突フローの純関数部分のテスト。
// - workdirImportAction: precheck 応答 → 取込開始時のアクション分岐
// - workdirConflictChoice: 確認ダイアログの submitter.value → 選択（Esc/未知値は cancel）
// Issue #59: 作業フォルダの UI 必須化。
// - canStartImport: 「取り込みを開始」の disabled 判定（workdir 未選択なら押せない）
// DOM（<dialog> の showModal / submit 配線）は main.js 側で、ここでは分岐表だけを固定する。

import test from "node:test";
import assert from "node:assert/strict";

import {
  workdirImportAction,
  workdirConflictChoice,
  canStartImport,
} from "../../src/podcast_prep/static/js/persistence.js";

test("workdirImportAction: existing_project のときだけ confirm", () => {
  assert.equal(
    workdirImportAction({ status: "existing_project", workdir: "/tmp/wd" }),
    "confirm",
  );
  assert.equal(workdirImportAction({ status: "ok", workdir: "/tmp/wd" }), "import");
});

test("workdirImportAction: 未知の status・欠落は import 側（最終ガードはサーバの create 本体）", () => {
  // precheck は UX 用の事前分岐。ここで import に倒れても、同意フラグなしの
  // 上書きはサーバが 400 で止める（既定では破壊できない）。
  assert.equal(workdirImportAction({ status: "something_new" }), "import");
  assert.equal(workdirImportAction({}), "import");
  assert.equal(workdirImportAction(null), "import");
  assert.equal(workdirImportAction(undefined), "import");
});

test("workdirConflictChoice: resume / overwrite はそのまま", () => {
  assert.equal(workdirConflictChoice("resume"), "resume");
  assert.equal(workdirConflictChoice("overwrite"), "overwrite");
});

test("workdirConflictChoice: cancel・未知値・undefined（Esc）は安全側の cancel", () => {
  assert.equal(workdirConflictChoice("cancel"), "cancel");
  assert.equal(workdirConflictChoice("yes"), "cancel"); // 他ダイアログの値が紛れても破壊操作に倒さない
  assert.equal(workdirConflictChoice(""), "cancel");
  assert.equal(workdirConflictChoice(undefined), "cancel");
  assert.equal(workdirConflictChoice(null), "cancel");
});

// ── Issue #59: 作業フォルダの UI 必須化 ──
// これが本体の回帰テスト。「A/B が揃っていれば押せる」だった旧条件に戻ると
// 保存先未選択のまま取込が通り、fork / clone した人の素材が既定パスへ消える。

const fileA = { name: "a.wav" }; // File の代わり（述語は真偽値化しか見ない）
const fileB = { name: "b.wav" };
const workdir = "/Users/someone/podcasts/ep01";

test("canStartImport: workdir 未選択なら A/B が揃っていても押せない（#59 の主眼）", () => {
  assert.equal(canStartImport({ fileA, fileB, workdir: null, jobBusy: false }), false);
  assert.equal(canStartImport({ fileA, fileB, workdir: undefined, jobBusy: false }), false);
  assert.equal(canStartImport({ fileA, fileB, workdir: "", jobBusy: false }), false);
});

test("canStartImport: A/B + workdir が揃って初めて押せる", () => {
  assert.equal(canStartImport({ fileA, fileB, workdir, jobBusy: false }), true);
});

test("canStartImport: workdir を選んでも A/B が欠けていれば押せない（旧条件は維持）", () => {
  assert.equal(canStartImport({ fileA, fileB: null, workdir, jobBusy: false }), false);
  assert.equal(canStartImport({ fileA: null, fileB, workdir, jobBusy: false }), false);
  assert.equal(canStartImport({ fileA: null, fileB: null, workdir, jobBusy: false }), false);
});

test("canStartImport: ジョブ進行中は全部揃っていても押せない", () => {
  assert.equal(canStartImport({ fileA, fileB, workdir, jobBusy: true }), false);
});

test("canStartImport: 引数欠落でも押せる側には倒さない", () => {
  assert.equal(canStartImport({}), false);
  assert.equal(canStartImport(), false);
});
