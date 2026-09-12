// state.js — 単一状態 + 極小イベントバス（EventTargetベース・DOM非依存でnode実行可）。
// イベント名:
//   "project-set" | "blocks-changed" | "selection-changed" | "zoom-changed"
// | "playhead-tick"(t) | "player-state"({playing}) | "save-state"({state})
// | "job-busy"({busy}) … プロジェクト対象ジョブの在否が変わった（#57 QA）

export const state = {
  project: null,               // サーバードキュメント（peaksは常に空）
  peaks: { A: null, B: null }, // PeakData | null
  wavMeta: { A: null, B: null },
  selectedBlockId: null,
  zoom: 80,                    // px/sec (20..260)
  editVersion: 0,              // 全ミューテーションで++（メモ化キー・echoガード）
  projectEpoch: 0,             // setProjectで++（非同期ロードの世代破棄）
  jobsInFlight: 0,             // 進行中のプロジェクト対象ジョブ数（#57 QA。beginJob/endJob で操作）
};

const bus = new EventTarget();

export function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

// handler は detail を直接受け取る（Eventオブジェクトではない）。返り値は解除関数。
export function on(name, handler) {
  const listener = (event) => handler(event.detail);
  bus.addEventListener(name, listener);
  return () => bus.removeEventListener(name, listener);
}

// ── ジョブ在否の単一の正（Issue #57 QA / 根因） ──────────
// import / transcribe / export / normalize は「プロジェクトを対象に走るジョブ」であり、
// 進行中は破棄（#54）・復元・別プロジェクト取込を止めなければならない。
// 従来 jobBusy は main.js のローカル変数で、panels.js の後がけ正規化だけが自前の
// normalizeBusy を使い**グローバルには busy を立てていなかった**。結果:
//   - 正規化の裏で「編集を破棄して閉じる」が押せる（採用・saveSoon と巻き戻し PUT の交錯）
//   - 正規化中に復元・取込を開始でき、その採用が閉じたビューと交錯する（#57 High の前提）
// ジョブの所有モジュールが main / panels に分かれているため、在否は state に集約して
// カウンタで持つ（同時に複数ジョブが走る余地を残す = 入れ子でも早期に false へ落ちない）。
// UI は "job-busy" を購読して disabled を更新する（panels → main の逆参照を作らない）。
export function beginJob() {
  state.jobsInFlight += 1;
  if (state.jobsInFlight === 1) emit("job-busy", { busy: true });
}

export function endJob() {
  if (state.jobsInFlight <= 0) return; // 二重 end は無視（カウンタを負にしない）
  state.jobsInFlight -= 1;
  if (state.jobsInFlight === 0) emit("job-busy", { busy: false });
}

// プロジェクト対象ジョブが1つ以上進行中か（多重起動ガード・破棄の可否判定に使う）
export function isJobBusy() {
  return state.jobsInFlight > 0;
}
