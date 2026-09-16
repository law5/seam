// persistence.js — 保存・採用ポリシー・ジョブフロー。
// 依存: state / api / history（history は「成功応答受信後・adopt 前に pushHistory()」という
//       Undo 順序の規律を runAutoEdit 内で満たすために必要。API 失敗時にゴミ履歴を積まない）。
// DOM には触らない。UI への通知は state のイベントバス経由:
//   - "save-state"  {state: "saving"|"saved"|"error", message?}
//   - "job-progress" job dict（pollJob の onProgress 中継。import/transcribe/export/開始側で毎回 emit。
//     Issue #57: ジョブ起票時のプロジェクト名を project_name として添える —
//     サーバの job dict は project_id しか持たず、閉じた/切り替えたプロジェクトの
//     ジョブを表示する際に名前を引けないため。フロント保持で済ませ API は変えない）
//   - "overlaps-merged" PUT echo の overlaps（サーバ導出 category 付き）反映通知（§9-5 注記）

import { state, emit, beginJob, endJob } from "./state.js";
import { api, pollJob, putProject, postAutoEdit } from "./api.js";
import { pushHistory } from "./history.js";

const SAVE_DEBOUNCE_MS = 350;

let saveTimer = null;
let currentFlight = null; // 進行中 PUT の Promise（単一飛行）
let queuedFlight = null;  // 追撃 1 回分の Promise（飛行中の再要求はここへ合流）
let previewDigest = null; // auto_edit dry_run 応答の blocks_digest（apply の楽観ロックに使う）
let openSnapshot = null;  // adoptServerProject 時点の文書クローン（Issue #54「編集を破棄して閉じる」の戻り先）
let discarding = false;   // 破棄 PUT 進行中は saveSoon / saveProject を no-op にする（Issue #54 競合防止）
                          // 他ジョブの起票側の排他は beginJob/endJob が担う（#57 QA。discardToSnapshot 参照）

// Issue #57: projectName（ジョブ起票時に確定した対象プロジェクト名）を job dict の
// コピーに project_name として載せて中継する。サーバ契約は変えない（表示専用の付加）。
function emitJobProgress(job, projectName) {
  emit("job-progress", projectName && job ? { ...job, project_name: projectName } : job);
}

// PUT 応答の echo を反映する。editVersion ガード済みの場合のみ呼ばれる。
// setProject 全置換は禁止（§9-5）: overlaps と block.text のみ id マージし、
// 再レンダー連鎖・編集巻き戻しを起こさない。
// 例外として "overlaps-merged" だけは発火する（Issue #20 実機FB）: 被り一覧の
// 分類チップはサーバ導出の overlap.category を表示しており、echo を黙って反映
// すると一覧は編集時のローカルスイープ結果（分類なし=「不明」）のまま静止して
// しまう。blocks-changed を使うと再レンダー連鎖（autoEdit プレビュー無効化等）が
// 走るため、被り一覧の再描画だけを促す専用イベントに絞る。
function mergeServerEcho(serverProject) {
  if (!serverProject || !state.project || serverProject.id !== state.project.id) return;
  state.project.overlaps = serverProject.overlaps || [];
  const textById = new Map((serverProject.blocks || []).map((block) => [block.id, block.text]));
  for (const block of state.project.blocks || []) {
    if (textById.has(block.id)) block.text = textById.get(block.id);
  }
  emit("overlaps-merged");
}

async function doPut() {
  const sentVersion = state.editVersion;
  emit("save-state", { state: "saving" });
  try {
    const data = await putProject(state.project); // JSON.stringify が呼び出し時点のスナップショットになる
    if (state.editVersion === sentVersion) {
      mergeServerEcho(data.project);
    }
    // 不一致（送信後に編集が進んだ）なら応答を丸ごと破棄 — 進んだ編集が次の save を予約済み
    emit("save-state", { state: "saved" });
  } catch (err) {
    emit("save-state", { state: "error", message: err.message });
    throw err;
  }
}

// 350ms デバウンスで saveProject を予約する（全ミューテーション後の既定経路）。
// discarding 中は no-op: 破棄ダイアログは submit で即閉じるため破棄 await 中も
// エディタ操作が可能で、ここで新規予約を許すと破棄完了後に編集 PUT が発火して
// サーバ上の破棄結果を静かに上書きする（Issue #54 QA指摘）。
export function saveSoon() {
  if (!state.project || discarding) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveProject().catch(() => {}); // 失敗は save-state イベントで通知済み（未処理 rejection を作らない）
  }, SAVE_DEBOUNCE_MS);
}

// 飛行を実際に開始する内部経路。saveProject の discarding ガードを通らないのは
// 追撃の再送専用（破棄開始「前」に積まれた追撃まで no-op にすると、既存保証
// 「編集PUT → 破棄PUT の順序固定」の前段が消えてしまうため）。
function startFlight() {
  currentFlight = doPut().finally(() => {
    currentFlight = null;
  });
  return currentFlight;
}

// 単一飛行 + 追撃 1 回。飛行中の呼び出しは追撃へ合流し、その完了を返す。
// discarding 中は no-op: 破棄 PUT は putProject 直呼びで単一飛行機構の外を飛ぶため、
// ここで新規飛行を許すと破棄 PUT と編集 PUT が並走し後着した編集が勝ってしまう。
export function saveProject() {
  if (!state.project || discarding) return Promise.resolve();
  if (currentFlight) {
    if (!queuedFlight) {
      queuedFlight = currentFlight
        .catch(() => {}) // 先行便の失敗でも追撃は最新状態で再送する
        .then(() => {
          queuedFlight = null;
          if (!state.project) return;
          return startFlight();
        });
    }
    return queuedFlight;
  }
  return startFlight();
}

// 保留中の保存を即時実行して完了を await する（transcribe/export/auto_edit 前に必須）。
// 保留も飛行も無ければサーバは最新なので何もしない。
export async function flushSave() {
  const hadPendingTimer = saveTimer !== null;
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (hadPendingTimer) {
    await saveProject();
    return;
  }
  if (currentFlight) {
    await (queuedFlight || currentFlight);
  }
}

// Issue #57 QA(Medium): 「プロジェクトビューが閉じているか」の判定を注入で受ける。
// persistence は DOM に触らない規律のため、DOM を正とする panels.projectViewClosed() を
// main が結線時に登録する（未登録＝テスト・初期化前は false = 従来の挙動）。
let viewClosedProbe = () => false;

export function setViewClosedProbe(probe) {
  viewClosedProbe = typeof probe === "function" ? probe : () => false;
}

// サーバー文書の全置換採用（open / import / transcribe 全採用）。
// projectEpoch++ で非同期ロード（peaks/wavMeta/PCM）の旧世代応答を破棄させる。
// editVersion も進め、飛行中 PUT の echo が新文書へマージされる競合を遮断する。
// 旧プロジェクト宛の保留デバウンスも破棄する（発火すると新 state.project を旧編集の
// つもりで PUT してしまう。旧プロジェクトの保留分は呼び出し側が採用前に flushSave する）。
export function adoptServerProject(project) {
  clearTimeout(saveTimer);
  saveTimer = null;
  state.project = project;
  state.projectEpoch += 1;
  state.editVersion += 1;
  previewDigest = null; // auto_edit プレビューは無効化（契約 §B: project-set でハッチ・適用もクリア）
  // Issue #54: 破棄の戻り先スナップショットを更新する。adoptServerProject は
  // 「サーバ正本と完全同期した瞬間」（open / import / transcribe 全置換 / normalize / 破棄直後）
  // なので、ここを一律ベースラインにする。transcribe 全置換もここを通る =
  // 文字起こし結果はスナップショットに含まれ「編集を破棄して閉じる」の破棄対象にならない
  // （高コストなジョブ結果を手編集と同列に巻き戻さない）。
  //
  // Issue #57 QA(Medium): ただし**ビューが閉じている間の採用ではベースラインを前進させない**。
  // 「はい」で閉じた時点のベースラインは開いた時点 S のままが正しい（#54 の契約）。閉じている
  // 間に裏のジョブ（正規化等）が完了して採用が走ると、S+E+成果物 が新ベースラインになり、
  // 後で開き直してから「編集を破棄して閉じる」を押しても開いた時点 E が巻き戻らなくなる。
  // 閉じている間はユーザーが編集していないので、ベースラインを据え置いても取りこぼしはない。
  // ユーザーが自分で開き直したときの採用（openProjectFolder 経路）はビューが閉じた状態で
  // 走るが、その直後に「開いた時点」を作り直す必要があるため setOpenSnapshot で明示更新する。
  if (!viewClosedProbe()) openSnapshot = structuredClone(project);
  emit("project-set");
}

// Issue #57 QA(Medium): 「開いた時点」のベースラインを現状で作り直す。
// 復元 / 再開 / 取込のようにユーザーが明示的に開いた直後だけ呼ぶ（閉じている間の
// 裏のジョブ完了は呼ばない = ベースラインを前進させない）。
export function setOpenSnapshot() {
  openSnapshot = state.project ? structuredClone(state.project) : null;
}

// Issue #54: 破棄可否の判定（純関数・テスト対象）。スナップショットが存在し、
// 現プロジェクトと同一 id のときだけ破棄できる（別プロジェクトへの書き戻し事故防止）。
export function canDiscardToSnapshot(snapshot, project) {
  return !!(snapshot && project && snapshot.id === project.id);
}

// UI 向け: 現在のプロジェクトに対して「編集を破棄して閉じる」が可能か
export function canDiscard() {
  return canDiscardToSnapshot(openSnapshot, state.project);
}

// Issue #54「編集を破棄して閉じる」: 開いた時点のスナップショットをサーバへ書き戻す。
// 自動保存（約350ms デバウンス）で編集が既にディスクにあるため、真の破棄は
// 「保存しないで閉じる」ではなく巻き戻し PUT で実現する。
// 飛行中 PUT との整合: 保留デバウンスは破棄し、飛行中（+追撃）は**完了を待ってから**
// 巻き戻す。単一飛行機構に割り込んで併走 PUT を作らないためで、追撃は最新編集を
// 送るがその直後にこの PUT が上書きするので順序は常に「編集PUT → 破棄PUT」になる。
// 破棄開始〜完了は discarding フラグで saveSoon / saveProject を no-op にする:
// ダイアログは submit で即閉じるため破棄 await 中もエディタ操作（編集→saveSoon・
// 保存ボタン直クリック）が可能で、放置するとワンショットの静穏待ちでは捕捉できない
// 新規飛行が破棄 PUT（putProject 直呼び = 単一飛行の外）と並走し、後着した編集 PUT が
// サーバ上の破棄を静かに上書きする（Issue #54 QA指摘）。
// Issue #57 QA指摘: 破棄自身も beginJob()/endJob() で job-busy 排他に参加させる。
// discarding フラグは saveSoon / saveProject を no-op にするだけで beginJob 経路には
// 効かないため、ジョブ → 破棄は塞がれているのに破棄 → ジョブは素通りという一方向の
// ガードになっていた（ダイアログは submit で即閉じ、巻き戻し PUT は非同期で飛び続けるので
// その窓で transcribe / export / normalize を起票できる）。破棄中を busy にすることで
// 他ジョブの起票は既存の isJobBusy ガードで自然に塞がる。破棄ボタン自身の disabled は
// ダイアログを開く時点でしか評価されない（main.js の closeProject クリック）ので自己ロックは
// 起きない（submit でダイアログが閉じるため押し直しもできない）。
// 失敗時は throw（呼び出し側が toast して編集画面に留まる — closeProject の保存失敗と同じ判断）。
// 成功時はサーバ echo を adoptServerProject で全置換採用（project-set → peaks/再生準備の
// やり直し。openProjectFolder と同じ経路）し、スナップショットも巻き戻し後へ更新される。
export async function discardToSnapshot() {
  const snapshot = openSnapshot;
  if (!canDiscardToSnapshot(snapshot, state.project)) {
    throw new Error("開いた時点の状態が見つかりません");
  }
  discarding = true;
  try {
    beginJob(); // 対になる endJob は finally（例外時のカウンタリークを作らない）
    clearTimeout(saveTimer); // 保留中の自動保存をキャンセル（発火すると編集を再保存してしまう）
    saveTimer = null;
    // 静穏待ちはループで回す: ワンショット await では待機中に離陸した飛行を取りこぼす。
    // フラグで新規飛行は止まるが、破棄開始前に積まれた飛行・追撃はここで確実に飲み干す。
    // 失敗しても破棄 PUT で上書きするので握り潰す。
    while (currentFlight) {
      await (queuedFlight || currentFlight).catch(() => {});
      clearTimeout(saveTimer); // フラグ導入前に滑り込んだ予約に備えて各周回でも破棄（念のため）
      saveTimer = null;
    }
    const doc = structuredClone(snapshot); // 送信中の参照共有を避ける（スナップショット自体は温存）
    const data = await putProject(doc);
    adoptServerProject(data.project || doc);
  } finally {
    discarding = false;
    endJob();
  }
}

// auto_edit 適用結果の採用: blocks + overlaps のみ差し替え（project-set を発火させず peaks 再取得を回避）。
// mergeServerEcho と同形の id ガード: apply POST 飛行中にプロジェクトが切り替わった場合、
// 旧プロジェクトの blocks を新プロジェクトへ差し込まない（応答は破棄。サーバ側は保存済み）。
export function adoptBlocksFrom(project) {
  if (!state.project || !project || project.id !== state.project.id) return;
  state.project.blocks = project.blocks || [];
  state.project.overlaps = project.overlaps || [];
  state.editVersion += 1;
  previewDigest = null;
  emit("blocks-changed");
}

// A/B の音声ファイル（MP3 / WAV など ffmpeg が読める形式）を取り込み、
// import ジョブの完了まで面倒を見る。完了ジョブを返す。
// L: normalize=false でラウドネス正規化（loudnorm 3パス）をスキップして取込を速くする。
// 既定は true（従来動作）。後から runNormalize で掛け直せる。
// workdir: 作業フォルダの絶対パス（フォルダ選択ダイアログの結果）。
// loudnorm: ラウドネス詳細 {truePeak?, tolerance?}（Issue #37）。未指定はサーバ側既定と
// 同値（-1.5 / 0.5）を常に送る = 挙動不変。
// overwriteExisting: 作業フォルダの既存プロジェクトを破棄して取り込む明示同意
// （Issue #53。確認ダイアログで「上書きして取り込む」を選んだ場合のみ true）。
// vad: 無音判定の設定 {aggressiveness?, padEndMs?}（Issue #26）。未指定はサーバ側既定と
// 同値（2 / 200ms）を常に送る = 挙動不変（loudnorm と同じ流儀）。頭側の余白
// vad_pad_start_s は UI に無いため送らない（サーバ既定 0.05s）。
export async function importFiles(
  fileA, fileB, name, targetLufs, normalize = true, workdir = null, loudnorm = {},
  overwriteExisting = false, vad = {},
) {
  await flushSave(); // 現プロジェクトの保留編集を切替前に確定（サイレント消失防止）
  const form = new FormData();
  form.append("speaker_a", fileA);
  form.append("speaker_b", fileB);
  form.append("name", name || "Untitled episode");
  form.append("target_lufs", String(targetLufs ?? -16));
  form.append("true_peak", String(loudnorm.truePeak ?? -1.5));
  form.append("tolerance", String(loudnorm.tolerance ?? 0.5));
  form.append("normalize", normalize ? "true" : "false");
  form.append("vad_aggressiveness", String(vad.aggressiveness ?? 2));
  form.append("vad_pad_end_s", String((vad.padEndMs ?? 200) / 1000));
  // Issue #32: 音量しきい値（dBFS）。null/undefined = 自動 → フィールド自体を送らない
  // （サーバ既定 None = webrtcvad のみ。空文字を送ると float パースで 422 になる）
  if (vad.energyFloorDb != null) {
    form.append("vad_energy_floor_db", String(vad.energyFloorDb));
  }
  // 未指定時はフィールド自体を送らない（空文字を送ると「指定されていません」の 400 になる）
  if (workdir) form.append("workdir", workdir);
  // Issue #53: 同意時のみ送る。既定は送らない = サーバ既定 false（既定では破壊できない）
  if (workdir && overwriteExisting) form.append("overwrite_existing", "true");
  const data = await api("/api/projects", { method: "POST", body: form });
  adoptServerProject(data.project); // status=importing の間はタイムライン空描画 + UI disabled（§14）
  const startId = data.project?.id;
  const startEpoch = state.projectEpoch;
  const jobProjectName = data.project?.name || name; // Issue #57: ジョブの文脈表示用
  const job = await pollJob(data.job, (j) => emitJobProgress(j, jobProjectName));
  // id+epoch ガード: ジョブ中に別プロジェクトが開かれていたら完了文書を採用しない
  // （サーバ側 project.json には保存済み。次回オープンで反映される）。
  if (
    job.result?.project &&
    state.project?.id === startId &&
    state.projectEpoch === startEpoch
  ) {
    adoptServerProject(job.result.project);
  }
  return job;
}

// フォルダパス指定での復元（UI 唯一の復元経路。project.json アップロードの
// openProjectFile は廃止 — サーバの project_json/audio 経路は API 後方互換で現存）。
// 実機フィードバック: 音源は60分素材で 223MB×2 になるため、フォルダのパスを渡して
// アップロードを回避する。サーバは source_dir 配下で相対解決する
// （封じ込めは resolve_sibling_file が担保）。
export async function openProjectFolder(folderPath) {
  await flushSave(); // 現プロジェクトの保留編集を切替前に確定（サイレント消失防止）
  const form = new FormData();
  form.append("source_dir", folderPath);
  const data = await api("/api/projects/open", { method: "POST", body: form });
  // Issue #22: アーカイブ済みプロジェクトはサーバが復元ジョブ（kind "restore"）を
  // 起票して restore_job を添えて返す。中間WAVが実在しないうちに採用すると
  // 再生準備（wavMeta 取得）が 404 で落ちるため、ジョブ完了の result.project を
  // 待ってから採用する。進捗は job-progress（topbar のジョブチップ）へ中継し、
  // beginJob/endJob で復元中の他ジョブ起票（取込等）を既存の isJobBusy ガードで塞ぐ。
  if (data.restore_job) {
    beginJob();
    try {
      const jobProjectName = data.project?.name;
      const job = await pollJob(data.restore_job, (j) => emitJobProgress(j, jobProjectName));
      const project = job.result?.project || data.project;
      adoptServerProject(project);
      return project;
    } finally {
      endJob();
    }
  }
  adoptServerProject(data.project);
  return data.project;
}

// Issue #22: アーカイブ可否（純関数・テスト対象）。両トラックに元音源と中間WAVの
// 参照が揃っていて、未アーカイブのときだけ可（サーバ側 /archive の前提条件と対応。
// UI はこれで disabled を決め、最終ガードはサーバの 400）。
export function canArchiveProject(project) {
  if (!project || project.archived) return false;
  return ["A", "B"].every((speaker) => {
    const track = project.tracks?.[speaker];
    return Boolean(track?.original_file) && Boolean(track?.normalized_wav);
  });
}

// Issue #22: 削減見込みバイト数（純関数・テスト対象）。中間WAVは 48kHz/16bit/mono
// PCM 固定（audio.SAMPLE_RATE/SAMPLE_WIDTH/CHANNELS）なので duration から概算できる。
export function archiveEstimateBytes(project) {
  return ["A", "B"].reduce((sum, speaker) => {
    const duration = Number(project?.tracks?.[speaker]?.duration);
    return sum + (Number.isFinite(duration) && duration > 0 ? duration * 48000 * 2 : 0);
  }, 0);
}

// Issue #22: 保存を確定してから POST /archive。応答 {project, freed_bytes} を返す
// （呼び出し側が freed_bytes をトーストに出し、project を採用してから閉じる）。
export async function archiveProject() {
  if (!state.project) throw new Error("プロジェクトがありません");
  await flushSave();
  await saveProject(); // 予約が無くても最新状態を確実に PUT してからアーカイブする
  return api(`/api/projects/${encodeURIComponent(state.project.id)}/archive`, {
    method: "POST",
  });
}

// Issue #18: 書き出し先の選択肢。SEAM_EXPORT_DIR 未設定なら
// targets は「プロジェクト内」1件（configured=false）。
export async function fetchExportTargets(projectId) {
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  return api(`/api/export/targets${query}`);
}

// 文字起こしジョブ。§9-6: ジョブ中に editVersion が進んでいたら result.project から
// transcripts のみ採用し blocks はローカル維持 → saveSoon で再収束。編集が無ければ全置換。
// id+epoch ガード: ジョブ中にプロジェクトが切り替わっていたら結果を破棄する
// （別プロジェクトへ transcripts を書き込み PUT で永続化する汚染の防止。
//   サーバ側 project.json には保存済みなので次回オープンで反映される）。
export async function startTranscribe(model) {
  if (!state.project) throw new Error("プロジェクトがありません");
  await flushSave();
  const startId = state.project.id;
  const startEpoch = state.projectEpoch;
  const startVersion = state.editVersion;
  const jobProjectName = state.project.name; // Issue #57: ジョブの文脈表示用（起票時に確定）
  const data = await api(`/api/projects/${encodeURIComponent(startId)}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: model ?? null }),
  });
  const job = await pollJob(data.job, (j) => emitJobProgress(j, jobProjectName));
  const project = job.result?.project;
  if (
    project &&
    state.project?.id === startId &&
    state.projectEpoch === startEpoch
  ) {
    if (state.editVersion !== startVersion) {
      state.project.transcripts = project.transcripts || [];
      // Issue #54: 部分採用はスナップショットにも追随させる。怠ると、その後の
      // 「編集を破棄して閉じる」が採用済み whisper 結果ごと巻き戻し PUT で恒久削除する
      // （transcripts は project.json のみ保管・サイドカーなし。文字起こし結果は
      //   高コストなジョブ成果であり破棄対象外、が設計意図）。部分採用がローカルに
      // 書くのは transcripts のみ（searchable_block_text 等は直後の saveSoon → PUT で
      // サーバが再導出）なので、追随もこの1フィールドで漏れがない。
      //
      // Issue #57 QA(Medium): この追随は**閉じている間も維持する**。全置換採用と違い
      // blocks / tracks を触らず transcripts の1フィールドだけを写すため、「開いた時点の
      // 編集 E」を巻き戻す能力は失われない（前進するのは破棄対象外の文字起こし結果のみ）。
      // 逆に閉じている間だけ据え置くと、開き直して破棄したときに採用済み whisper 結果が
      // 恒久削除される（#54 が明示的に避けた事故）ため、据え置きの方が有害。
      if (openSnapshot && openSnapshot.id === state.project.id) {
        openSnapshot.transcripts = structuredClone(state.project.transcripts);
      }
      state.editVersion += 1; // transcripts のメモ化（projectTimelineTranscripts）を無効化
      emit("blocks-changed");
      saveSoon(); // PUT でサーバ側が searchable_block_text + recompute を再導出して整合回復
    } else {
      adoptServerProject(project);
    }
  }
  return job;
}

// Issue #32: エクスポート前の上書き事前チェック → {output_dir, exists, files}。
// 出力先の解決はサーバ側で /export と同じ _resolve_export_target を通る
// （許可ベース検証込み。ここで 400 になる指定は export 本体でも 400 になる）。
export async function precheckExport(outputDir) {
  if (!state.project) throw new Error("プロジェクトがありません");
  return api(`/api/projects/${encodeURIComponent(state.project.id)}/export/precheck`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ output_dir: outputDir || null }),
  });
}

// Issue #53: 取込前の作業フォルダ事前チェック → {status, workdir}。
// status は "existing_project"（project.json 実在 = UI が再開/上書き/キャンセルの
// 確認ダイアログを出す）か "ok"。孤児レジストリエントリ（登録だけ残って
// project.json 無し、Issue #34）はサーバの create_project が透過的に付け替える
// ため "ok" になる。パスの解決はサーバ側で取込本体と同じ validate_workdir を通る
// （precheckExport と同じ規律。ここで 400 になる指定は取込本体でも 400 になる）。
export async function precheckWorkdir(workdir) {
  return api("/api/system/workdir_precheck", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workdir }),
  });
}

// Issue #53: precheck 応答 → 取込開始時のアクション（純関数・テスト対象）。
// "confirm" = 確認ダイアログを出す / "import" = 従来どおり即取込。
// 未知の status は "import" 側に倒す — precheck は UX 用の事前分岐であって
// ガードではなく、最終ガードはサーバの create_project 本体が同意フラグ込みで
// 行う（迂回しても既定では破壊できない）。
export function workdirImportAction(precheck) {
  return precheck && precheck.status === "existing_project" ? "confirm" : "import";
}

// Issue #53: 確認ダイアログの submitter.value → 選択（純関数・テスト対象）。
// 未知値・undefined（Esc の cancel イベント経由）は安全側の "cancel"。
export function workdirConflictChoice(value) {
  return value === "resume" || value === "overwrite" ? value : "cancel";
}

// Issue #59: 「取り込みを開始」を押せるか（純関数・テスト対象）。
// 条件は A/B 両方のファイル + 作業フォルダの選択 + ジョブ非進行 の AND。
//
// なぜ workdir を必須にしたか: サーバ（POST /api/projects）は workdir 省略を
// 引き続き許容する（従来配置のプロジェクトを開くフォールバックと CLI/API 利用の
// ため）。ただし fork / clone した人の取込先はそれぞれ違うので、UI で既定パスを
// 見せて素通しさせると「どこに行ったか分からない」が起きる。サーバは寛容・UI は厳格
// の役割分担（overwrite_existing と同じ思想）で、選ばせるのは UI 側で塞ぐ。
//
// 引数はすべて真偽値化して扱う（呼び出し側は File / パス文字列 / null を渡す）。
export function canStartImport({ fileA, fileB, workdir, jobBusy } = {}) {
  return Boolean(fileA) && Boolean(fileB) && Boolean(workdir) && !jobBusy;
}

// エクスポートジョブ。完了ジョブを返す（output_dir の toast は呼び出し側）。
export async function startExport(format, outputDir) {
  if (!state.project) throw new Error("プロジェクトがありません");
  await flushSave();
  const jobProjectName = state.project.name; // Issue #57: ジョブの文脈表示用（起票時に確定）
  const data = await api(`/api/projects/${encodeURIComponent(state.project.id)}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format: format, output_dir: outputDir || null }),
  });
  return pollJob(data.job, (j) => emitJobProgress(j, jobProjectName));
}

// L: 後がけラウドネス正規化（POST /normalize → ジョブ）。完了ジョブを返す。
// BE2 契約4節の不変条件: blocks / transcripts / overlaps は変わらない（時間軸不変）ので
// project はそのまま採用してよい。ただし normalized_wav とピークサイドカーは差し替わるため、
// **完了後にピークと再生準備を必ず作り直す**（adoptServerProject の project-set で
// main が loadPeaks + preparePlayback を回すため、この経路に乗せれば古い波形は残らない）。
// speakers 省略時は両話者。
export async function runNormalize(speakers, options = {}) {
  if (!state.project) throw new Error("プロジェクトがありません");
  await flushSave(); // 未保存編集をサーバへ反映（ジョブ完了時の save_project に負けないように）
  const startId = state.project.id;
  const startEpoch = state.projectEpoch;
  const jobProjectName = state.project.name; // Issue #57: ジョブの文脈表示用（起票時に確定）
  const payload = { ...options };
  if (Array.isArray(speakers) && speakers.length) payload.speakers = speakers;
  const data = await api(`/api/projects/${encodeURIComponent(startId)}/normalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const job = await pollJob(data.job, (j) => emitJobProgress(j, jobProjectName));
  // id+epoch ガード: ジョブ中に別プロジェクトへ切り替わっていたら結果を破棄
  if (
    job.result?.project &&
    state.project?.id === startId &&
    state.projectEpoch === startEpoch
  ) {
    adoptServerProject(job.result.project); // project-set → peaks 再取得 + 再生準備やり直し
  }
  return job;
}

// G: エクスポート先を OS のファイルマネージャで開く（POST /reveal）。
// path 省略時はサーバが exports 配下の最新サブディレクトリを開く。
export async function revealPath(path) {
  if (!state.project) throw new Error("プロジェクトがありません");
  return api(`/api/projects/${encodeURIComponent(state.project.id)}/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: path ?? null }),
  });
}

// 自動編集（契約 §B のフロー）。opts はサーバ契約 §A のキー
// {dry_run, tighten_gaps, tighten_overlaps, max_gap_s, keep_gap_s, max_overlap_s} を受ける。
// 戻り値はサーバ応答そのもの:
//   - dry_run 応答（data.dry_run === true）: blocks_digest を保持して返す（summary/preview で描画）
//   - 適用応答（data.dry_run === false）: applied なら pushHistory → adoptBlocksFrom 済み。追加 PUT はしない
//   - 409 "changed since preview": 自動で再プレビューし、その dry_run 応答を返す
//     （呼び出し側は「apply を要求したのに data.dry_run === true」で再プレビューを判別できる）
export async function runAutoEdit(opts = {}) {
  if (!state.project) throw new Error("プロジェクトがありません");
  const dryRun = opts.dry_run !== false;
  await flushSave(); // 未保存編集を先にサーバへ反映（プレビュー・適用とも必須）
  const payload = { ...opts, dry_run: dryRun };
  if (!dryRun && previewDigest) payload.if_blocks_digest = previewDigest;
  let data;
  try {
    data = await postAutoEdit(state.project.id, payload);
  } catch (err) {
    if (!dryRun && String(err.message).includes("changed since preview")) {
      return runAutoEdit({ ...opts, dry_run: true });
    }
    throw err;
  }
  if (data.dry_run) {
    previewDigest = data.blocks_digest;
    return data;
  }
  previewDigest = null;
  if (data.applied && data.project) {
    pushHistory(); // 成功応答受信後・adopt 前（state.project はまだ適用前 = 正しい戻り先。契約 §B）
    adoptBlocksFrom(data.project); // サーバ保存済みのため追加 PUT はしない
  }
  return data;
}
