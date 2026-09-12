// Issue #57 QA(High): 取込オーバーレイの「畳んで編集画面へ入る」判断を DOM から切り離した層。
//
// main.js は DOM 直結で単体テストできないため、**どの経路が畳みを起こすか**の順序規則だけを
// ここに置き、DOM 操作（closable の読み取り・実際の hidden 切替）は注入で受ける。
// 純関数（shouldCloseOverlayOnAdopt / shouldCloseOverlayAfterOpen）は panels.js 側にあり、
// このモジュールは「open の await と裏のジョブ完了が交錯したときの帰結」を固定する責務を持つ。
//
// なぜ層を切ったか（撤去した旧実装の欠陥）:
// 旧実装は module レベルの boolean `overlayOpenIntent` を立てたまま open を await し、
// その間に飛んできた project-set（採用イベント）に畳ませていた。採用イベントは
// *誰の採用か* を持たないため次の2つが起きる。
//   (1) 便乗: 閉じた状態で正規化 / 文字起こしが継続中に復元を始めると、その await 中に
//       裏のジョブが先に完了し、その採用が立ったままの意図フラグで畳んでしまう。
//       復元がその後失敗すると編集画面に引き戻されたまま残る（#57 で廃止した挙動の復活）。
//       ジョブが同一プロジェクトのこともある（閉じた状態で自分の文字起こしが完了）ため
//       project id 一致チェックでは塞げない。
//   (2) 早期解除: 復元 / 再開が2つ重なると、先に終わった側の finally が共有フラグを false に
//       戻し、後から正当に成功した側が畳めなくなる。
// → 意図を「待ち受けるフラグ」で表すのをやめ、**open 呼び出しの成功そのものを畳みのトリガ**に
//   した。畳みの権利は呼び出しのスコープに閉じ、共有状態が無いので便乗も早期解除も起きない。

import { shouldCloseOverlayOnAdopt, shouldCloseOverlayAfterOpen } from "./panels.js";

// オーバーレイの畳みゲートを作る。
// deps:
//   closable()   … overlayClosable()（ready かつ取込ジョブ非進行）
//   viewClosed() … projectViewClosed()（セットアップ表示中 = 「閉じた」状態）
//   fold()       … 実際にオーバーレイを隠す副作用
//   rebaseSnapshot() … #54 の「開いた時点」ベースラインを現状で作り直す
//     （persistence.setOpenSnapshot）。閉じている間の採用ではベースラインを前進させない
//     ようにしたため（#57 QA Medium）、ユーザーが明示的に開いた瞬間はここで作り直す。
export function createOverlayGate({ closable, viewClosed, fold, rebaseSnapshot = () => {} }) {
  // 採用（project-set）に伴う追随。開いたまま待った完了のリフレッシュ経路だけが畳む。
  // 閉じた状態のジョブ完了は畳まない（データ採用は呼び出し側で既に済んでいる）。
  // ユーザー要求の「開く」はここでは畳まない = 意図に便乗する余地を作らない。
  function onAdopt() {
    if (shouldCloseOverlayOnAdopt({ closable: closable(), viewClosed: viewClosed() })) {
      fold();
      return true;
    }
    return false;
  }

  // ユーザー要求の「開く」が成功した直後の明示的な畳み（採用イベントを待たない）。
  // 畳めた = 「今この瞬間から編集を始める」なので、#54 の破棄ベースラインもここで作り直す
  // （閉じている間の採用は前進させない一方、ユーザーの明示的な「開く」は前進させる）。
  function enterProjectView() {
    if (shouldCloseOverlayAfterOpen({ closable: closable(), opened: true })) {
      fold();
      rebaseSnapshot();
      return true;
    }
    return false;
  }

  // 復元 / 再開（openProjectFolder）のラッパ。open が解決した「その呼び出し」だけが畳む。
  // open は内部で adoptServerProject（project-set 同期 emit）まで済ませてから resolve する
  // ので、resolve 時点の state は開いた新プロジェクト = 畳んで編集画面へ入って良い。
  // throw 時はここを通らない = オーバーレイは開いたまま（復元失敗で引き戻されない）。
  async function openAndEnter(open) {
    const result = await open();
    enterProjectView();
    return result;
  }

  return { onAdopt, enterProjectView, openAndEnter };
}
