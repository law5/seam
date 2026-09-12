// Issue #57 QA(High): 取込オーバーレイの畳みゲートの順序規則。
//
// フェーズ2 の初版は module レベルの boolean（overlayOpenIntent）を立てて open を await し、
// その間に飛んできた project-set（採用イベント）に畳ませていた。採用イベントは
// *誰の採用か* を持たないため2つの欠陥があり、ここでその両方を再現テストとして固定する。
//   (1) 便乗: 閉じた状態で正規化 / 文字起こしが継続中に復元を始めると、その await 中に
//       裏のジョブが先に完了し、その採用が立ったままの意図フラグで畳んでしまう。復元が
//       その後失敗すると編集画面に引き戻されたまま残る（#57 で廃止した挙動の復活）。
//       裏のジョブが**同一プロジェクト**（閉じた状態で自分の文字起こしが完了）のことも
//       あるため、project id 一致チェックでは塞げない。
//   (2) 早期解除: 復元 / 再開が2つ重なると、先に終わった側の finally が共有フラグを
//       false に戻し、後から正当に成功した側の畳みが失われる。
// 現行実装は「open 呼び出しの成功そのもの」を畳みのトリガにして共有状態を持たない。
//
// 併せて既存の回帰（取込完了で畳む / 破棄して閉じるでオーバーレイへ戻る /
// 開いたまま完了でリフレッシュ）も同じ層で固定する。

import test from "node:test";
import assert from "node:assert/strict";

import { createOverlayGate } from "../../src/podcast_prep/static/js/overlayGate.js";

// main.js の DOM 状態を最小に写したハーネス。
// - overlay/setup の hidden が projectViewClosed() の入力（セットアップ表示中 = 閉じた）
// - closable は overlayClosable()（ready かつ取込ジョブ非進行）と同じ導出
function makeHarness({ status = "ready", importJobActive = false, overlayHidden = false } = {}) {
  const view = {
    status,          // state.project.status
    importJobActive, // 取込ジョブ進行中
    overlayHidden,   // #importOverlay.hidden
    setupHidden: false, // #importSetup.hidden（進捗モードのとき true）
    folds: 0,
  };
  const gate = createOverlayGate({
    closable: () => view.status === "ready" && !view.importJobActive,
    viewClosed: () => !view.overlayHidden && !view.setupHidden,
    fold: () => {
      view.overlayHidden = true;
      view.folds += 1;
    },
  });
  return { view, gate };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── 欠陥1: 無関係なジョブ完了が「開く」意図に便乗しない ──

test("復元 await 中に別プロジェクトのジョブ完了が来ても畳まれない（意図への便乗なし）", async () => {
  // 閉じた状態（オーバーレイのセットアップ表示中）で復元を開始し、その await 中に
  // 裏で走っていた正規化ジョブが完了 → adoptServerProject → project-set。
  const { view, gate } = makeHarness({ overlayHidden: false });
  const open = deferred();
  const opening = gate.openAndEnter(() => open.promise);

  await tick();
  gate.onAdopt(); // 裏のジョブ完了（別プロジェクト）
  assert.equal(view.overlayHidden, false, "裏のジョブ完了では畳まない");
  assert.equal(view.folds, 0);

  open.resolve({ id: "p2" });
  await opening;
  assert.equal(view.overlayHidden, true, "復元成功後は畳んで編集画面へ入る");
  assert.equal(view.folds, 1);
});

test("復元 await 中に同一プロジェクトのジョブ完了が来ても畳まれない（id 一致では区別できない経路）", async () => {
  // 閉じた状態で自分のプロジェクトの文字起こしが完了するケース。project id の一致だけを
  // 条件にすると便乗を許してしまうので、id に依存しない構造であることを固定する。
  const { view, gate } = makeHarness({ overlayHidden: false });
  const open = deferred();
  const opening = gate.openAndEnter(() => open.promise);

  await tick();
  gate.onAdopt(); // 同一プロジェクトの transcribe 完了
  gate.onAdopt(); // 続けて normalize 完了（複数回でも消費されるフラグが無い）
  assert.equal(view.overlayHidden, false);
  assert.equal(view.folds, 0);

  open.resolve({ id: "p1" });
  await opening;
  assert.equal(view.overlayHidden, true);
});

test("復元が失敗したら畳まれない（裏のジョブ完了が先にあっても引き戻されない）", async () => {
  // 旧実装の最悪ケース: 裏のジョブが意図フラグに便乗して畳み、その後復元が失敗する →
  // 「編集画面に強制的に引き戻されたまま」残る（#57 で廃止した挙動の復活）。
  const { view, gate } = makeHarness({ overlayHidden: false });
  const open = deferred();
  const opening = gate.openAndEnter(() => open.promise);

  await tick();
  gate.onAdopt(); // 裏のジョブ完了
  open.reject(new Error("project.json が読めません"));

  await assert.rejects(opening, /project\.json/);
  assert.equal(view.overlayHidden, false, "復元失敗時はオーバーレイに留まる");
  assert.equal(view.folds, 0);
});

// ── 欠陥2: 入れ子・重複した「開く」で畳みが失われない ──

test("2つの open が重なっても後から成功した側の畳みが失われない", async () => {
  // 旧実装では先に終わった側の finally が共有 boolean を false に戻し、後から成功した
  // 側（正当に畳むべき方）が畳めなくなっていた。
  const { view, gate } = makeHarness({ overlayHidden: false });
  const first = deferred();
  const second = deferred();
  const p1 = gate.openAndEnter(() => first.promise);
  const p2 = gate.openAndEnter(() => second.promise);

  // 1本目は失敗して先に決着（= 旧実装ならここで意図が解除される）
  first.reject(new Error("cancelled"));
  await assert.rejects(p1, /cancelled/);
  assert.equal(view.overlayHidden, false, "失敗した側では畳まない");

  // 2本目は正当に成功 → 畳む
  second.resolve({ id: "p9" });
  await p2;
  assert.equal(view.overlayHidden, true, "後から成功した側の畳みは失われない");
  assert.equal(view.folds, 1);
});

test("入れ子の open（外側 await 中に内側が完走）でも外側の成功で畳む", async () => {
  const { view, gate } = makeHarness({ overlayHidden: false });
  const outer = deferred();
  const opening = gate.openAndEnter(async () => {
    await gate.openAndEnter(() => Promise.resolve({ id: "inner" })); // 内側が畳む
    view.overlayHidden = false; // 外側の途中で再表示された想定（畳みの権利は独立）
    return outer.promise;
  });

  await tick();
  outer.resolve({ id: "outer" });
  await opening;
  assert.equal(view.overlayHidden, true, "外側の open 成功で改めて畳む");
});

// ── 「開く」成功時の畳みの前提条件 ──

test("open が成功しても closable でなければ畳まない（未 ready / 取込ジョブ進行中）", async () => {
  for (const view of [{ status: "importing" }, { importJobActive: true }]) {
    const h = makeHarness({ overlayHidden: false, ...view });
    await h.gate.openAndEnter(() => Promise.resolve({}));
    assert.equal(h.view.overlayHidden, false);
    assert.equal(h.view.folds, 0);
  }
});

test("enterProjectView は open の戻りを介さず畳める（取込完了の経路）", () => {
  // runImport の finally は「この取込が成功した」ローカル変数を根拠にここを直接呼ぶ。
  // 直前の updateImportOverlay() がセットアップを再表示するため viewClosed は真だが、
  // 取込はユーザー要求の「開く」経路なので畳んで編集画面へ入る（#57 の廃止対象外）。
  const { view, gate } = makeHarness({ overlayHidden: false });
  assert.equal(gate.enterProjectView(), true);
  assert.equal(view.overlayHidden, true);
});

test("取込が失敗した場合は enterProjectView を呼ばない = オーバーレイに留まる", () => {
  // main 側の `if (importSucceeded)` の意味づけ（ゲートは呼ばれた分だけ畳む）。
  const { view } = makeHarness({ overlayHidden: false });
  assert.equal(view.overlayHidden, false);
  assert.equal(view.folds, 0);
});

// ── 採用（project-set）経路の回帰 ──

test("onAdopt: 閉じた状態のジョブ完了では畳まない（#57 本命の回帰）", () => {
  const { view, gate } = makeHarness({ overlayHidden: false });
  assert.equal(gate.onAdopt(), false);
  assert.equal(view.overlayHidden, false);
});

test("onAdopt: 開いたままの完了は従来どおり畳む判定（リフレッシュ経路の回帰）", () => {
  const { view, gate } = makeHarness({ overlayHidden: true }); // 編集画面（オーバーレイ非表示）
  assert.equal(gate.onAdopt(), true);
  assert.equal(view.overlayHidden, true);
});

test("onAdopt: 進捗モード表示中（setupHidden）は「閉じた」ではないが closable が偽で畳まない", () => {
  const { view, gate } = makeHarness({ overlayHidden: false, importJobActive: true });
  view.setupHidden = true;
  assert.equal(gate.onAdopt(), false);
  assert.equal(view.overlayHidden, false);
});

test("破棄して閉じる → その後のジョブ完了で編集画面へ戻らない（#54×#57 の合流点）", () => {
  // discardToSnapshot は adoptServerProject を通る（project-set）。閉じた直後に
  // その採用が来てもオーバーレイへ戻したままにする。
  const { view, gate } = makeHarness({ overlayHidden: false });
  assert.equal(gate.onAdopt(), false);
  assert.equal(view.overlayHidden, false, "破棄して閉じた状態が維持される");
});
