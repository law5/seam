// Issue #57 フェーズ1: バックグラウンドジョブの文脈表示（panels.js の純関数群）。
//
// 固定したい契約:
// - jobContextName: 開いているプロジェクト自身のジョブは null（従来表示 = 冗長にしない）。
//   閉じた（projectClosed）/ 別プロジェクトのジョブは対象プロジェクト名を返す。
//   project_id を持たないジョブ（model_download）は常に null
// - jobChipLabel: 文脈ありは「〈種別〉中: 〈名前〉 NN%」/ なしは従来の「〈種別〉 NN% — message」
// - isJobDetached: jobProjectId 欠損は常に false（従来トーストのまま = 誤検知しない）
// - jobFinishMessage: detached でなければ null（呼び出し側の従来文言 = 挙動不変）。
//   export のみ「開き直すと反映」を付けず detail（出力先）を添える
//
// Issue #57 フェーズ2（並行編集構想の取り下げ）:
// - shouldCloseOverlayOnAdopt: 閉じた状態でのジョブ完了は編集画面へ引き戻さない。
//   開いたままの完了リフレッシュは従来どおり
// - shouldCloseOverlayAfterOpen: ユーザー要求の「開く」経路（復元/再開/取込完了）は
//   その open 呼び出しの成功を根拠に畳む（QA(High): 意図フラグ方式の撤去。順序規則の
//   再現テストは tests/js/overlayGate.test.mjs）

import test from "node:test";
import assert from "node:assert/strict";

import {
  jobContextName,
  jobChipLabel,
  isJobDetached,
  jobFinishMessage,
  shouldCloseOverlayOnAdopt,
  shouldCloseOverlayAfterOpen,
} from "../../src/podcast_prep/static/js/panels.js";

const job = (extra = {}) => ({
  id: "j1",
  kind: "transcribe",
  project_id: "p1",
  project_name: "第12回収録",
  status: "running",
  progress: 0.42,
  message: "Transcribing speaker A",
  ...extra,
});

// ── jobContextName ──────────────────────────────────────

test("jobContextName: 開いているプロジェクト自身のジョブは null（従来表示）", () => {
  assert.equal(jobContextName(job(), "p1", false), null);
});

test("jobContextName: プロジェクトを閉じた状態では同一プロジェクトでも名前を出す", () => {
  // 「閉じる」は state.project を残す（取込オーバーレイ表示のみ）ため、
  // id 比較だけでは主シナリオ（#54 検証で発見）を検知できない
  assert.equal(jobContextName(job(), "p1", true), "第12回収録");
});

test("jobContextName: 別プロジェクトを開いていたら名前を出す", () => {
  assert.equal(jobContextName(job(), "p2", false), "第12回収録");
  assert.equal(jobContextName(job(), undefined, false), "第12回収録"); // project 不在
});

test("jobContextName: project_id を持たないジョブ（model_download）は常に null", () => {
  const dl = job({ kind: "model_download", project_id: "", project_name: undefined });
  assert.equal(jobContextName(dl, "p1", false), null);
  assert.equal(jobContextName(dl, "p1", true), null);
  assert.equal(jobContextName(null, "p1", true), null);
});

test("jobContextName: project_name 欠損は汎用表現へフォールバック", () => {
  assert.equal(jobContextName(job({ project_name: undefined }), "p2", false), "別のプロジェクト");
});

// ── jobChipLabel ────────────────────────────────────────

test("jobChipLabel: 文脈ありは種別+中: 名前 + %（message は省く）", () => {
  assert.equal(jobChipLabel(job(), "第12回収録"), "文字起こし中: 第12回収録 42%");
  assert.equal(jobChipLabel(job({ kind: "export", progress: 0.8 }), "第12回収録"), "エクスポート中: 第12回収録 80%");
});

test("jobChipLabel: 文脈なしは従来表示のまま（挙動不変）", () => {
  assert.equal(jobChipLabel(job(), null), "文字起こし 42% — Transcribing speaker A");
  assert.equal(jobChipLabel(job({ message: "" }), null), "文字起こし 42%");
  assert.equal(jobChipLabel(job({ kind: "unknown_kind", message: "" }), null), "unknown_kind 42%");
});

test("jobChipLabel: progress の異常値は 0..100% に丸める", () => {
  assert.equal(jobChipLabel(job({ progress: -1, message: "" }), null), "文字起こし 0%");
  assert.equal(jobChipLabel(job({ progress: 2 }), "名前"), "文字起こし中: 名前 100%");
  assert.equal(jobChipLabel(job({ progress: "abc", message: "" }), null), "文字起こし 0%");
});

// ── isJobDetached ───────────────────────────────────────

test("isJobDetached: 閉じた/別プロジェクトで true、開いたまま同一なら false", () => {
  assert.equal(isJobDetached("p1", "p1", false), false);
  assert.equal(isJobDetached("p1", "p1", true), true); // 閉じた（overlay セットアップ表示）
  assert.equal(isJobDetached("p1", "p2", false), true); // 別プロジェクトへ切替
  assert.equal(isJobDetached("p1", undefined, false), true);
});

test("isJobDetached: jobProjectId 欠損は常に false（誤検知しない）", () => {
  assert.equal(isJobDetached("", "p1", true), false);
  assert.equal(isJobDetached(undefined, "p1", true), false);
  assert.equal(isJobDetached(null, undefined, true), false);
});

// ── jobFinishMessage ────────────────────────────────────

test("jobFinishMessage: detached でなければ null（従来トースト文言のまま）", () => {
  assert.equal(jobFinishMessage("transcribe", true, { projectName: "N", detached: false }), null);
  assert.equal(jobFinishMessage("transcribe", false, { projectName: "N", detached: false }), null);
  assert.equal(jobFinishMessage("export", true, {}), null); // 引数省略も安全側
});

test("jobFinishMessage: 完了は「開き直すと反映」を全ジョブ種で自然な文言に", () => {
  assert.equal(
    jobFinishMessage("transcribe", true, { projectName: "第12回収録", detached: true }),
    "「第12回収録」の文字起こしが完了しました。開き直すと反映されています",
  );
  assert.equal(
    jobFinishMessage("normalize", true, { projectName: "第12回収録", detached: true }),
    "「第12回収録」のラウドネス正規化が完了しました。開き直すと反映されています",
  );
  assert.equal(
    jobFinishMessage("import", true, { projectName: "第12回収録", detached: true }),
    "「第12回収録」の取込が完了しました。開き直すと反映されています",
  );
});

test("jobFinishMessage: export は成果物がディスクに出ているため出力先を添える", () => {
  assert.equal(
    jobFinishMessage("export", true, {
      projectName: "第12回収録",
      detached: true,
      detail: "/tmp/out/take2",
    }),
    "「第12回収録」のエクスポートが完了しました: /tmp/out/take2",
  );
  assert.equal(
    jobFinishMessage("export", true, { projectName: "第12回収録", detached: true }),
    "「第12回収録」のエクスポートが完了しました",
  );
});

test("jobFinishMessage: 失敗も沈黙させない（detail = エラーメッセージ）", () => {
  assert.equal(
    jobFinishMessage("transcribe", false, {
      projectName: "第12回収録",
      detached: true,
      detail: "whisper crashed",
    }),
    "「第12回収録」の文字起こしが失敗しました: whisper crashed",
  );
  assert.equal(
    jobFinishMessage("export", false, { projectName: "第12回収録", detached: true }),
    "「第12回収録」のエクスポートが失敗しました",
  );
});

test("jobFinishMessage: 名前・種別の欠損は汎用表現へフォールバック", () => {
  assert.equal(
    jobFinishMessage("transcribe", true, { detached: true }),
    "「プロジェクト」の文字起こしが完了しました。開き直すと反映されています",
  );
  assert.equal(
    jobFinishMessage("future_kind", false, { projectName: "N", detached: true }),
    "「N」のfuture_kindが失敗しました",
  );
});

// ── shouldCloseOverlayOnAdopt / shouldCloseOverlayAfterOpen（Issue #57 フェーズ2） ─

test("shouldCloseOverlayOnAdopt: 閉じた状態のジョブ完了では畳まない（編集画面へ引き戻さない）", () => {
  // 本命シナリオ: 閉じて（セットアップ表示）待っている間に transcribe / normalize / export が
  // 完了 → adoptServerProject でデータは採用されるが、ビューは動かさずトーストのみ
  assert.equal(shouldCloseOverlayOnAdopt({ closable: true, viewClosed: true }), false);
});

test("shouldCloseOverlayOnAdopt: 開いたままの完了は従来どおり畳む（リフレッシュ経路の回帰）", () => {
  // 開いて待った場合の「完了時リフレッシュ + 文字起こしテキスト表示」は正しい既存挙動。
  // オーバーレイは既に hidden なので畳む判定でも実害はなく、判定自体も従来どおり真に保つ
  assert.equal(shouldCloseOverlayOnAdopt({ closable: true, viewClosed: false }), true);
});

test("shouldCloseOverlayOnAdopt: closable=false は常に畳まない（未 ready / 取込ジョブ進行中）", () => {
  // importing 中（status != ready）と取込ジョブ進行中は畳めない —
  // 進捗モードの強制表示が優先する（overlayClosable と同じ規律）
  for (const viewClosed of [true, false]) {
    assert.equal(shouldCloseOverlayOnAdopt({ closable: false, viewClosed }), false);
  }
});

test("shouldCloseOverlayOnAdopt: 引数省略は安全側（畳まない）", () => {
  assert.equal(shouldCloseOverlayOnAdopt(), false);
  assert.equal(shouldCloseOverlayOnAdopt({}), false);
});

test("shouldCloseOverlayOnAdopt: 意図フラグは受け付けない（QA(High) で撤去した引数）", () => {
  // 旧 openIntent を渡しても採用経路の判定は変わらない = 採用イベントに便乗できない。
  // ユーザー要求の「開く」は shouldCloseOverlayAfterOpen 側で扱う。
  assert.equal(
    shouldCloseOverlayOnAdopt({ closable: true, viewClosed: true, openIntent: true }),
    false,
  );
});

test("shouldCloseOverlayAfterOpen: open が成功して closable なら畳む（復元・再開・取込完了）", () => {
  assert.equal(shouldCloseOverlayAfterOpen({ closable: true, opened: true }), true);
});

test("shouldCloseOverlayAfterOpen: open 失敗・未 ready・引数省略は畳まない（安全側）", () => {
  assert.equal(shouldCloseOverlayAfterOpen({ closable: true, opened: false }), false);
  assert.equal(shouldCloseOverlayAfterOpen({ closable: false, opened: true }), false);
  assert.equal(shouldCloseOverlayAfterOpen({}), false);
  assert.equal(shouldCloseOverlayAfterOpen(), false);
});
