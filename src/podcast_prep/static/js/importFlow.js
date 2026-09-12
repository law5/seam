// Issue #59 QA: 取込開始シーケンスの TOCTOU を塞いだ層。
//
// main.js は DOM 直結で単体テストできないため、overlayGate.js と同じ流儀で
// **「いつ何を確定し、どの値で取込を起こすか」の順序規則**だけをここに置き、
// DOM 操作（トースト・確認ダイアログ・実際の取込）は注入で受ける。
//
// なぜ層を切ったか（塞いだ欠陥）:
// 旧実装（main.js の startImportFlow）は多重起動ガード `importFlowBusy` を立てた直後に
// `await precheckWorkdir()` へ入り、その await を跨いだあとで **モジュール変数**
// `pendingWorkdir` / `pendingFiles` を読み直して取込を起こしていた。
//   - `importFlowBusy` は再入を防ぐだけで DOM コントロールを無効化しない
//   - `beginJob()` は取込本体の中なので `isJobBusy()` が真になるのは await の**後**
//   - precheck 往復の間、モーダルは出ておらず「選び直す」（表示中・非 disabled）が押せる
// → precheck 待ちに「選び直す」を押すと `pendingWorkdir` が null になり、取込は
//   workdir なしで走る（persistence.importFiles は `if (workdir)` で載せないだけ）＝
//   **保存先未選択のまま既定パスへ取り込まれる**。#59 が UI で塞いだはずの状態そのもの。
//   別フォルダを選び直した場合は、X に対する precheck / 上書き判断が Y に適用される。
//
// 現行実装は「開始した瞬間の選択」をローカルへ**スナップショット**し、以降は
// モジュール変数を一切読み直さない。確定値は取込へ引数で渡すので、await 中に
// ユーザーが選択を変えても、precheck を通した値と取り込む値が必ず一致する。
// 取込直前に `canStartImport` を再評価して、スナップショットが無効（選び直しで
// 未選択になった等）なら中止する = ボタンの disabled 述語と同じ二重ガードに揃える。

import { canStartImport, workdirImportAction } from "./persistence.js";

// 取込開始シーケンスを作る。
// deps:
//   readSelection()  … 開始時点の選択 {fileA, fileB, workdir} を読む（main の
//     pendingFiles / pendingWorkdir）。**この関数はシーケンス中ちょうど1回だけ呼ぶ**
//   jobBusy()        … isJobBusy()（state.jobsInFlight が正）
//   precheck(workdir)… persistence.precheckWorkdir
//   confirmConflict()… 確認ダイアログ Promise<"resume"|"overwrite"|"cancel">
//   resume(workdir)  … 「再開する」経路（openProjectFolder ラッパ）
//   runImport({fileA, fileB, workdir, overwrite}) … 取込本体
//   toast(message, timeout) … 通知
//   setControlsBusy(busy) … 作業フォルダ系コントロール（選ぶ / 選び直す）の disabled 切替。
//     スナップショットと排他ではなく別の層: スナップショットが「押されても壊れない」を
//     保証し、これは「効かないものを押せるように見せない」を担う。シーケンス全体
//     （precheck 〜 確認ダイアログ）を覆い、finally で必ず戻す
export function createImportFlow({
  readSelection,
  jobBusy,
  precheck,
  confirmConflict,
  resume,
  runImport,
  toast,
  setControlsBusy = () => {},
}) {
  let busy = false; // precheck〜ダイアログ表示中の多重起動ガード（showModal の二重呼び防止）

  async function start() {
    if (jobBusy() || busy) return;
    busy = true;
    try {
      // ── スナップショット ──
      // ここから先はモジュール変数を読み直さない。await を跨いで「選び直す」が
      // 押されても、precheck に掛けた値と取り込む値が食い違わない。
      const { fileA, fileB, workdir } = readSelection();
      // 開始時点でも disabled と同じ述語で確認する（呼び出し側のガードが漏れても止まる）
      if (!canStartImport({ fileA, fileB, workdir, jobBusy: jobBusy() })) return;
      setControlsBusy(true); // 確定できた時点から作業フォルダ系を押せなくする

      let overwrite = false;
      let check;
      try {
        check = await precheck(workdir);
      } catch (err) {
        // validate_workdir の 400（クラウド同期フォルダ・不存在パス等）はここで止まる
        toast(`取込失敗: ${err.message}`, 12000);
        return;
      }
      if (workdirImportAction(check) === "confirm") {
        const choice = await confirmConflict();
        if (choice === "cancel") return; // 閉じるだけ（トーストも出さない）
        if (choice === "resume") {
          // 再開もスナップショットした workdir で行う（precheck を掛けたのはこの値）
          await resume(workdir);
          return;
        }
        overwrite = true; // "overwrite": 明示同意フラグ付きで取込へ
      }

      // await を跨いだので、確定値がまだ有効かを取込直前に再評価する。
      // 「選び直す」でスナップショットが陳腐化した場合ではなく（ローカル値は不変）、
      // 待っている間に裏でジョブが起票された場合にここで止まる。
      if (!canStartImport({ fileA, fileB, workdir, jobBusy: jobBusy() })) return;
      await runImport({ fileA, fileB, workdir, overwrite });
    } finally {
      setControlsBusy(false); // 早期 return（未 disable）でも呼ぶ = 状態から導出し直すだけ
      busy = false;
    }
  }

  return { start };
}
