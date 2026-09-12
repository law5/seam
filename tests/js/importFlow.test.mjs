// Issue #59 QA: 取込開始シーケンスの TOCTOU 回帰テスト。
//
// 塞いだ欠陥（本 PR の目的直撃）:
// 旧実装は多重起動ガード `importFlowBusy` を立てた直後に `await precheckWorkdir()` へ入り、
// その await を跨いだあとで **モジュール変数** `pendingWorkdir` / `pendingFiles` を読み直して
// 取込を起こしていた。`importFlowBusy` は再入を防ぐだけで DOM を無効化せず、`beginJob()` は
// 取込本体の中なので `isJobBusy()` が真になるのは await の後。つまり precheck の往復中は
// 「選び直す」（表示中・非 disabled）が押せて、押すと `pendingWorkdir` が null になり、
// `importFiles` は `if (workdir)` で workdir を載せない = **保存先未選択のまま既定パスへ
// 取り込まれる**。#59 が UI で塞いだはずの状態そのものに戻ってしまう。
//
// ここで固定するのは「開始した瞬間の選択で取り込む」こと。readSelection は1回しか呼ばれず、
// 以降の選択変更（選び直し / 別フォルダへの差し替え）は飛行中のシーケンスに影響しない。

import test from "node:test";
import assert from "node:assert/strict";

import { createImportFlow } from "../../src/podcast_prep/static/js/importFlow.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fileA = { name: "a.wav" }; // File の代わり（述語は真偽値化しか見ない）
const fileB = { name: "b.wav" };
const WORKDIR = "/Users/someone/podcasts/ep01";

// main.js のモジュール変数（pendingFiles / pendingWorkdir）を写したハーネス。
// selection を書き換える = ユーザーが「選び直す」/ 別フォルダを選んだ状態。
function makeHarness({ precheckResult = { status: "ok" }, conflictChoice = "overwrite" } = {}) {
  const selection = { fileA, fileB, workdir: WORKDIR };
  const calls = {
    readSelection: 0,
    precheck: [],   // 渡された workdir
    imports: [],    // runImport に渡ったスナップショット
    resumes: [],    // resume に渡った workdir
    toasts: [],
    controls: [],   // setControlsBusy の履歴
  };
  const gate = deferred(); // precheck の解決を止めて await 中の隙間を作る
  let jobBusy = false;

  const flow = createImportFlow({
    readSelection: () => {
      calls.readSelection += 1;
      return { ...selection };
    },
    jobBusy: () => jobBusy,
    precheck: async (workdir) => {
      calls.precheck.push(workdir);
      await gate.promise; // ここでユーザー操作を割り込ませる
      return precheckResult;
    },
    confirmConflict: async () => conflictChoice,
    resume: async (workdir) => {
      calls.resumes.push(workdir);
    },
    runImport: async (args) => {
      calls.imports.push(args);
    },
    toast: (message, timeout) => calls.toasts.push({ message, timeout }),
    setControlsBusy: (busy) => calls.controls.push(busy),
  });

  return {
    flow, calls, selection, gate,
    setJobBusy: (v) => { jobBusy = v; },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── 本体: precheck 待ちの「選び直す」に取込がさらわれない ──

test("precheck 待ちに「選び直す」が入っても、スナップショットした workdir で取り込む（#59 QA の主眼）", async () => {
  const h = makeHarness();
  const started = h.flow.start();
  await tick(); // precheck の await に入るまで進める

  assert.deepEqual(h.calls.precheck, [WORKDIR]);
  // ここが旧実装で壊れていた瞬間: 「選び直す」= pendingWorkdir を null に戻す
  h.selection.workdir = null;

  h.gate.resolve();
  await started;

  assert.equal(h.calls.imports.length, 1);
  // 旧実装ではここが null になり、importFiles が workdir を載せずに既定パスへ取り込んでいた
  assert.equal(h.calls.imports[0].workdir, WORKDIR);
});

test("precheck 待ちに別フォルダへ差し替えても、precheck を掛けた側で取り込む（判断の適用先がズレない）", async () => {
  // X に対する precheck / 上書き判断が Y に適用される取り違えを塞ぐ
  const h = makeHarness({ precheckResult: { status: "existing_project" }, conflictChoice: "overwrite" });
  const started = h.flow.start();
  await tick();

  h.selection.workdir = "/Users/someone/podcasts/ep99-別フォルダ";
  h.gate.resolve();
  await started;

  assert.deepEqual(h.calls.precheck, [WORKDIR]);
  assert.equal(h.calls.imports[0].workdir, WORKDIR);
  assert.equal(h.calls.imports[0].overwrite, true); // 上書き同意も precheck した側に対応
});

test("precheck 待ちにファイルを差し替えても、開始時の A/B で取り込む", async () => {
  const h = makeHarness();
  const started = h.flow.start();
  await tick();

  h.selection.fileA = { name: "差し替え.wav" };
  h.selection.fileB = null;
  h.gate.resolve();
  await started;

  assert.equal(h.calls.imports[0].fileA, fileA);
  assert.equal(h.calls.imports[0].fileB, fileB);
});

test("選択はシーケンス中ちょうど1回しか読まない（読み直し = TOCTOU の口）", async () => {
  const h = makeHarness();
  const started = h.flow.start();
  await tick();
  h.selection.workdir = null;
  h.gate.resolve();
  await started;

  assert.equal(h.calls.readSelection, 1);
});

// ── 「再開する」も同じスナップショットで動く ──

test("「再開する」も precheck を掛けた workdir で開く", async () => {
  const h = makeHarness({ precheckResult: { status: "existing_project" }, conflictChoice: "resume" });
  const started = h.flow.start();
  await tick();

  h.selection.workdir = null; // ダイアログ表示中に裏で選び直された想定
  h.gate.resolve();
  await started;

  assert.deepEqual(h.calls.resumes, [WORKDIR]);
  assert.equal(h.calls.imports.length, 0); // 再開経路は取込を起こさない
});

// ── 開始時ガード（canStartImport と同じ述語） ──

test("workdir 未選択で呼ばれても precheck も取込も起こさない（disabled の二重ガード）", async () => {
  const h = makeHarness();
  h.selection.workdir = null;
  await h.flow.start();

  assert.deepEqual(h.calls.precheck, []);
  assert.equal(h.calls.imports.length, 0);
});

test("A/B が欠けていれば開始しない", async () => {
  const h = makeHarness();
  h.selection.fileB = null;
  await h.flow.start();

  assert.deepEqual(h.calls.precheck, []);
  assert.equal(h.calls.imports.length, 0);
});

test("ジョブ進行中は開始しない", async () => {
  const h = makeHarness();
  h.setJobBusy(true);
  await h.flow.start();

  assert.deepEqual(h.calls.precheck, []);
  assert.equal(h.calls.imports.length, 0);
});

test("precheck 待ちの間に裏でジョブが起票されたら取込直前で止まる（再評価）", async () => {
  // beginJob は取込本体の中なので、この隙間に別ジョブ（正規化・文字起こし）が
  // 起票されることはありうる。開始時ガードだけでは拾えないのでここで再評価する。
  const h = makeHarness();
  const started = h.flow.start();
  await tick();

  h.setJobBusy(true);
  h.gate.resolve();
  await started;

  assert.equal(h.calls.imports.length, 0);
});

// ── 多重起動ガード ──

test("飛行中の再入は無視する（確認ダイアログの二重表示を防ぐ）", async () => {
  const h = makeHarness();
  const first = h.flow.start();
  await tick();
  await h.flow.start(); // precheck 待ちの間にもう一度押された

  h.gate.resolve();
  await first;

  assert.deepEqual(h.calls.precheck, [WORKDIR]); // 2回目は precheck にすら入らない
  assert.equal(h.calls.imports.length, 1);
});

test("シーケンス完了後は再び開始できる（ガードが張り付かない）", async () => {
  const h = makeHarness();
  const first = h.flow.start();
  await tick();
  h.gate.resolve();
  await first;

  // 2周目は新しいゲートで（前回の gate は解決済みなので precheck は素通り）
  await h.flow.start();
  assert.equal(h.calls.imports.length, 2);
});

// ── キャンセル・失敗 ──

test("確認ダイアログの cancel は取込もトーストも起こさない", async () => {
  const h = makeHarness({ precheckResult: { status: "existing_project" }, conflictChoice: "cancel" });
  const started = h.flow.start();
  await tick();
  h.gate.resolve();
  await started;

  assert.equal(h.calls.imports.length, 0);
  assert.deepEqual(h.calls.toasts, []);
});

test("precheck の失敗（validate_workdir の 400 等）はトーストで止まる", async () => {
  const h = makeHarness();
  const started = h.flow.start();
  await tick();
  h.gate.reject(new Error("クラウド同期フォルダは使えません"));
  await started;

  assert.equal(h.calls.imports.length, 0);
  assert.equal(h.calls.toasts.length, 1);
  assert.match(h.calls.toasts[0].message, /取込失敗/);
});

// ── 作業フォルダ系コントロールの disabled ──

test("precheck〜ダイアログの間は作業フォルダ系を disabled にし、必ず戻す", async () => {
  const h = makeHarness();
  const started = h.flow.start();
  await tick();

  assert.deepEqual(h.calls.controls, [true]); // まだ戻っていない
  h.gate.resolve();
  await started;

  assert.deepEqual(h.calls.controls, [true, false]);
});

test("precheck が失敗しても disabled は戻る（押せないまま残さない）", async () => {
  const h = makeHarness();
  const started = h.flow.start();
  await tick();
  h.gate.reject(new Error("boom"));
  await started;

  assert.equal(h.calls.controls.at(-1), false);
});
