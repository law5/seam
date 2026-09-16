// main.js — 結線の唯一の場所。
// 各モジュールの init*() 呼び出し + main 担当のイベント購読 + topbar のアクション配線。
// 二重バインド禁止（各 UI 要素のハンドラは以下のとおり1モジュールだけが持つ）:
//   - transport（playPause/back5/forward5）・block-tools・undo/redo・[data-field]・[data-preview] → panels
//   - #zoom スライダー・#fitZoom（全体俯瞰）・M/S・tlScroll ポインタ系・document keydown（編集系）→ interactions
//   - at* 群（自動編集）→ autoEdit
//   - 被り一覧の選択・Prev/Next・後がけ正規化・書き出し結果・作業フォルダ表示
//     （#ov* / [data-normalize] / #revealExport / #revealWorkdir）→ panels
//   - 文字起こし設定（#whisperModelSelect / #whisperComputeType / #whisperDevice /
//     ダウンロード行）→ transcribeSettings（Issue #12）
//   - ラウドネス設定欄（#targetLufs / #truePeak / #normTolerance / #loudnormReset）→ panels
//     （Issue #37 追加FB: topbar からトラック設定パネルの「ラウドネス」欄へ集約）
//   main が結線するのは topbar（close/save/transcribe/export/projectName/
//   exportFormat/出力先の選択 #exportDir*）+ 取込オーバーレイ（#importOverlay 一式。
//   L のラウドネス正規化トグル #importNormalize / #importLufs を含む）と
//   イベントマトリクスの main 行 + テーマ監視（prefers-color-scheme →
//   waveform.applyThemeColors。契約 §2-3）のみ。
// エクスポート完了時は panels.showExportResult(job) を呼び、出力先パネル（G）を更新する。
// job-progress は panels（topbar ジョブチップ）に加えて main も購読する
// （kind === "import" のみ。取込オーバーレイの大型進捗・段階表示を更新するため。§10.4 改訂済み）。
// 完了・失敗の通知は emit("toast", {message, timeout}) → panels が #toast に表示する。

import { state, on, emit, beginJob, endJob, isJobBusy } from "./state.js";
import * as waveform from "./waveform.js";
import * as player from "./player.js";
import {
  initPanels, showExportResult,
  isJobDetached, jobFinishMessage, projectViewClosed, // Issue #57: 完了トーストの文脈判定
} from "./panels.js";
import { initTranscriptPanel, refreshTranscripts } from "./transcriptPanel.js";
import { initAutoEdit } from "./autoEdit.js";
import { initInteractions } from "./interactions.js";
import { initTranscribeSettings, getWhisperModelRef } from "./transcribeSettings.js";
import { createOverlayGate } from "./overlayGate.js"; // Issue #57: オーバーレイ畳みゲート
import { createImportFlow } from "./importFlow.js"; // Issue #59 QA: 取込開始の順序規則
import * as persistence from "./persistence.js";
import { chooseFile, chooseFolder } from "./api.js";
import { loadPeaks } from "./peaks.js";
import { clearHistory } from "./history.js";
import { parentDirOf } from "./utils.js";

const $ = (id) => document.getElementById(id);

// import / transcribe / export / normalize の多重起動ガードは state.jobsInFlight が正
// （#57 QA の根因: panels の後がけ正規化が main のローカル変数を立てられず、正規化中に
//  破棄・復元・取込が通ってしまっていた）。main は "job-busy" 購読で disabled を更新する。
let importJobActive = false; // 取込ジョブ進行中（オーバーレイの進捗モード制御）
const pendingFiles = { A: null, B: null }; // オンボーディングのスロットに入った File
let pendingWorkdir = null; // 取込前に選んだ作業フォルダ（null = 既定 = FormData に載せない）
let chosenExportDir = null; // 書き出し設定で選んだ出力先（null = 既定 = プロジェクト内 exports）
// Issue #59: 既定の作業フォルダ（GET /api/system/paths）の先読み表示は廃止した。
// 既定パスを見せると素通りされるため、未選択は未選択として見せる（renderWorkdirRow）。
// API 自体は残してある（情報として有用・pytest あり）が、取込オーバーレイは呼ばない。

function toast(message, timeout) {
  emit("toast", { message, timeout });
}

// Issue #57: ジョブ完了・失敗時、対象プロジェクトが閉じられて/別プロジェクトに
// 切り替わっていたら文脈付きトースト文言を返す（開いたままなら null → 従来文言）。
// jobProject はジョブ開始時に確定した {id, name}。判定は完了時点の状態で行う。
function jobFinishToast(kind, ok, jobProject, detail) {
  const detached = isJobDetached(jobProject?.id, state.project?.id, projectViewClosed());
  return jobFinishMessage(kind, ok, { projectName: jobProject?.name, detached, detail });
}

function isReady() {
  return !!state.project && state.project.status === "ready";
}

// ── イベント購読（§10.4 の main 担当行） ─────────────────
// main の購読は他モジュールの init より先に登録する: project-set の状態リセット
// （選択解除・peaks破棄・履歴クリア）を他購読者の再描画より先に済ませるため。

function subscribe() {
  on("project-set", () => {
    // 世代リセット（後続購読者は掃除済みの状態を見る）
    state.selectedBlockId = null;
    state.peaks.A = null;
    state.peaks.B = null;
    clearHistory(); // 前プロジェクトの undo スタックを新プロジェクトへ持ち込まない
    syncTopbarInputs();
    updateTopbarEnabled();
    updateImportOverlay();
    closeOverlayIfReady(); // 復元・取込完了で ready になったらオンボーディングを畳む

    const epoch = state.projectEpoch;
    if (isReady()) {
      // preparePlayback は内部でフルリセット（stop + generation++ + store破棄）してから準備する。
      // 失敗時は player-state {disabled:true} → panels が toast（§4.2）。
      player.preparePlayback(epoch);
      loadPeaks(state.project.id, epoch).then(() => {
        if (epoch === state.projectEpoch) waveform.invalidate(); // 到着時再描画（冪等）
      });
    } else {
      // importing 中など: 再生系を停止・未準備化（§14。wavMeta 404 の無用な失敗toastも避ける）
      player.initPlayer();
    }
    player.seek(0); // playhead を先頭へ（停止中でも tick が emit され表示が更新される）

    waveform.layout(); // invalidate を含む
    refreshTranscripts();
  });

  on("blocks-changed", () => {
    waveform.layout(); // timelineEnd が変わるためコンテンツ幅再計算 + invalidate
    refreshTranscripts();
    player.notifyBlocksChanged();
    // topbar のプロジェクト名をモデルへ再同期（activeElement ガードは setInputValue 内）。
    // undo/redo 等でモデルが変わっても入力欄が古い表示のまま乖離するのを防ぐ（QA指摘対応）。
    setInputValue("projectName", state.project?.name ?? "Untitled episode");
  });

  on("selection-changed", () => waveform.invalidate());

  on("playhead-tick", (t) => waveform.setPlayheadTime(Number(t) || 0));

  // 取込オーバーレイの大型進捗（import のみ。topbar チップは panels が担当）
  on("job-progress", onImportJobProgress);

  // Issue #57 QA: ジョブ在否（state.jobsInFlight）が変わったら topbar / 取込ボタンの
  // disabled を追随させる。panels の後がけ正規化のように main が所有しないジョブでも
  // 同じ経路で反映される（main のローカルフラグを他モジュールから立てさせない）。
  on("job-busy", () => updateTopbarEnabled());

  // zoom-changed: waveform 内部処理 + panels のスライダー同期（ともに自モジュール購読）→ main は何もしない
  // player-state / save-state: panels が自モジュールで購読 → main は何もしない
}

// ── topbar ──────────────────────────────────────────────

function bindTopbar() {
  $("closeProject").addEventListener("click", () => {
    // Issue #54: ジョブ進行中（取込/文字起こし/エクスポート）は破棄を無効化する。
    // ジョブ完了時の採用・saveSoon が巻き戻し PUT と交錯し「破棄したはずの状態」を
    // 上書きしうるため（transcribe の部分採用経路など）。スナップショット不在時も同様。
    const discard = $("discardClose");
    if (discard) discard.disabled = isJobBusy() || !persistence.canDiscard();
    $("closeProjectDialog")?.showModal();
  });
  // form の submit を直接拾う（dialog の close/returnValue は
  // JS からのクリックだと乗らない環境があるため）
  $("closeProjectForm")?.addEventListener("submit", onCloseProjectSubmit);
  $("saveProject").addEventListener("click", () => {
    // 即時保存（デバウンス待ちを追い越す）。失敗は save-state → panels が toast
    persistence.saveProject().catch(() => {});
  });
  $("transcribe").addEventListener("click", onTranscribe);
  $("exportProject").addEventListener("click", onExport);

  $("projectName").addEventListener("input", () => {
    if (!state.project) return;
    state.project.name = $("projectName").value || "Untitled episode";
    persistence.saveSoon();
  });
  // targetLufs はトラック設定パネルの「ラウドネス」欄へ移動 → panels が結線（Issue #37 追加FB）
  bindSetting("exportFormat", "change", "export_format", (v) => v);
  // whisper_model / whisper_compute_type / whisper_device は transcribeSettings が担当（§K）

  // Issue #32: 出力先のフォルダ選択（ネイティブダイアログ。purpose="export" で選んだ
  // フォルダはサーバ側の許可ベースに積まれる）。取込オーバーレイの作業フォルダ行と同じ流儀。
  // 選択は永続化しない（サーバ側の許可もプロセス内メモリのみ = 再起動で揃って既定に戻る）。
  $("exportDirChoose").addEventListener("click", async () => {
    const button = $("exportDirChoose");
    button.disabled = true; // ダイアログはサーバ側で開くので多重起動を防ぐ
    try {
      const res = await chooseFolder("export");
      // キャンセルは正常系（サーバ契約: 200 + cancelled）— トーストを出さない
      if (!res.cancelled && res.path) {
        chosenExportDir = res.path;
        renderExportDirRow();
      }
    } catch (err) {
      toast(`フォルダ選択に失敗: ${err.message}`, 8000);
    } finally {
      button.disabled = false;
    }
  });
  $("exportDirReset").addEventListener("click", () => {
    chosenExportDir = null;
    renderExportDirRow();
  });
}

// 出力先行の表示。パスは textContent（XSS規律）。未選択時は既定 = プロジェクト内 exports
function renderExportDirRow() {
  $("exportDirPath").textContent = chosenExportDir ?? "既定（プロジェクト内）";
  $("exportDirReset").hidden = !chosenExportDir;
}

function bindSetting(id, eventName, settingsKey, parse) {
  $(id).addEventListener(eventName, () => {
    if (!state.project?.settings) return;
    state.project.settings[settingsKey] = parse($(id).value);
    persistence.saveSoon();
  });
}

// ── 取込オンボーディング（#importOverlay: スロット + D&D + 大型進捗） ──

function bindImportOverlay() {
  const zone = $("dropZone");

  $("slotA").addEventListener("click", () => $("importA").click());
  $("slotB").addEventListener("click", () => $("importB").click());
  $("importA").addEventListener("change", () => takePicked("A", $("importA")));
  $("importB").addEventListener("change", () => takePicked("B", $("importB")));
  $("swapSlots").addEventListener("click", () => {
    [pendingFiles.A, pendingFiles.B] = [pendingFiles.B, pendingFiles.A];
    renderSlots();
  });
  $("importStart").addEventListener("click", () => {
    // disabled と同じ述語で二重にガードする（disabled の付け忘れ・競合で漏れても止まる）
    if (importStartAllowed()) void startImportFlow();
  });
  $("importClose").addEventListener("click", hideImportOverlay);

  // L: ラウドネス正規化トグル（既定OFF）。OFF なら目標LUFS欄を無効化し補足を出す
  $("importNormalize").addEventListener("change", renderNormalizeToggle);
  $("importLufs").addEventListener("change", () => {
    // 取込前は project がまだ無いのでトラック設定パネルの targetLufs 欄へ橋渡しする
    // （runImport がこの値を使い、取込後は settings.target_lufs としてサーバが保持する）
    setInputValue("targetLufs", Number($("importLufs").value || -16));
    if (state.project?.settings) {
      state.project.settings.target_lufs = Number($("importLufs").value || -16);
      persistence.saveSoon();
    }
  });
  // Issue #37: ラウドネス詳細。importLufs と同じ橋渡し（トラック設定パネルの同項目 + settings）
  bindImportLoudnormOption("importTruePeak", "truePeak", "true_peak", -1.5);
  bindImportLoudnormOption("importTolerance", "normTolerance", "tolerance", 0.5);
  renderNormalizeToggle();

  // 作業フォルダの選択（ネイティブダイアログ。POST /api/system/choose_folder）
  $("importWorkdirChoose").addEventListener("click", async () => {
    const button = $("importWorkdirChoose");
    button.disabled = true; // ダイアログはサーバ側で開くので多重起動を防ぐ
    try {
      const res = await chooseFolder("workdir");
      // キャンセルは正常系（サーバ契約: 200 + cancelled）— トーストを出さない
      if (!res.cancelled && res.path) {
        pendingWorkdir = res.path;
        renderWorkdirRow();
        renderSlots(); // 選択が済んだので「取り込みを開始」の disabled を更新（#59）
      }
    } catch (err) {
      toast(`フォルダ選択に失敗: ${err.message}`, 8000);
    } finally {
      button.disabled = false;
    }
  });
  // 「選び直す」: 戻す先の既定が無くなった（#59）ので、未選択に戻して選択を促す。
  // 未選択に戻ると取込は再び disabled になるため renderSlots も呼ぶ。
  $("importWorkdirReset").addEventListener("click", () => {
    pendingWorkdir = null;
    renderWorkdirRow();
    renderSlots();
  });

  // 既存プロジェクトの再開: ネイティブのファイル選択で project.json を選び、
  // その親フォルダを source_dir として開く（音源のアップロードなし・コピーなし）
  $("restoreFromJson").addEventListener("click", onRestoreFromJson);

  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("drag-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("drag-over");
    takeDropped(Array.from(event.dataTransfer?.files || []));
  });
  // オーバーレイ外への誤ドロップでページ遷移しないように（グローバル既定を殺す）
  document.addEventListener("dragover", (event) => event.preventDefault());
  document.addEventListener("drop", (event) => event.preventDefault());

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("importOverlay").hidden && overlayClosable()) {
      hideImportOverlay();
    }
  });
}

// 作業フォルダ行の表示。パスは textContent（XSS規律）。
// Issue #59: 未選択時に既定パス（.../projects/（自動ID））を見せるのをやめた。
// パスが出ていると「このままでいいのかな」と思わせて素通りされ、fork / clone した
// 人の素材がどこに行ったか分からなくなる。未選択は未選択として見せて選ばせる。
function renderWorkdirRow() {
  const chosen = Boolean(pendingWorkdir);
  $("importWorkdirPath").textContent = pendingWorkdir ?? "未選択 — 保存先を選んでください";
  $("importWorkdirPath").classList.toggle("unset", !chosen);
  $("importWorkdirReset").hidden = !chosen;
  // 押せない理由の案内。選択が済んだら消す（残すとノイズになる）
  $("importWorkdirHint").hidden = chosen;
}

// Issue #37: 取込オーバーレイのラウドネス詳細欄（TP / 許容量）を、importLufs と同じく
// トラック設定パネルの同項目 + project.settings へ橋渡しする（取込前は project が無いので入力欄のみ）
function bindImportLoudnormOption(importId, panelId, settingsKey, fallback) {
  $(importId).addEventListener("change", () => {
    const value = Number($(importId).value || fallback);
    setInputValue(panelId, value);
    if (state.project?.settings) {
      state.project.settings[settingsKey] = value;
      persistence.saveSoon();
    }
  });
}

// 正規化トグルの従属表示: OFF なら目標LUFS欄（+ TP / 許容量。Issue #37）を無効化 +
// 「チェックすると時間がかかる／後がけできる」補足（Issue #31。ONで速くなると誤読させない言い回し）
function renderNormalizeToggle() {
  const on = !!$("importNormalize").checked;
  for (const id of ["importLufs", "importTruePeak", "importTolerance"]) {
    $(id).disabled = !on;
  }
  for (const id of ["importLufsLabel", "importTruePeakLabel", "importToleranceLabel"]) {
    $(id).classList.toggle("disabled", !on);
  }
  $("importNormalizeNote").hidden = on;
}

// 段階リストの第1段は normalize の有無で意味が変わる（正規化 or 単なる変換）
function setImportStageLabels(normalize) {
  const first = document.querySelector('#importProgress .stage-list li[data-stage="loudness"]');
  if (first) first.textContent = normalize ? "ラウドネス正規化" : "音声変換（正規化なし）";
}

// 取込を許可する音声拡張子。サーバ側 server.ALLOWED_AUDIO_EXTS と対応させる
// （こちらは事故防止のUIガード。最終的な正規化・許可判定はサーバの _safe_audio_name）。
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|aiff?)$/i;

function isAudioFile(file) {
  // 拡張子が主。MIME は OS/ブラウザで空や application/octet-stream になることが
  // あるため補助的にしか見ない（wav が audio/x-wav / audio/wave と揺れるのも同様）。
  return AUDIO_EXT_RE.test(file.name) || /^audio\//i.test(file.type || "");
}

function takePicked(speaker, input) {
  const file = input.files && input.files[0];
  input.value = ""; // 同じファイルを選び直しても change が発火するように即クリア
  if (!file) return;
  if (!isAudioFile(file)) {
    toast("音声ファイル（MP3 / WAV など）を選んでください");
    return;
  }
  pendingFiles[speaker] = file;
  renderSlots();
}

function takeDropped(files) {
  const audio = files.filter(isAudioFile);
  if (!audio.length) {
    toast("音声ファイル（MP3 / WAV など）をドロップしてください");
    return;
  }
  if (audio.length === 1) {
    // 1本なら空いているスロット（A優先）へ
    const target = pendingFiles.A && !pendingFiles.B ? "B" : "A";
    pendingFiles[target] = audio[0];
  } else {
    pendingFiles.A = audio[0];
    pendingFiles.B = audio[1];
    if (audio.length > 2) toast("3本目以降は無視しました（使うのは先頭2本です）");
  }
  renderSlots();
}

function renderSlots() {
  for (const sp of ["A", "B"]) {
    const file = pendingFiles[sp];
    $(`slotFile${sp}`).textContent = file ? file.name : "クリックしてファイルを選ぶ";
    $(`slot${sp}`).classList.toggle("filled", !!file);
  }
  $("importStart").disabled = !importStartAllowed();
}

// Issue #59: 「取り込みを開始」を押せるか。判定表は persistence.canStartImport
// （純関数・テスト対象）で、ここは現在の DOM 外状態を読み集めるだけ。
function importStartAllowed() {
  return persistence.canStartImport({
    fileA: pendingFiles.A,
    fileB: pendingFiles.B,
    workdir: pendingWorkdir,
    jobBusy: isJobBusy(),
  });
}

function overlayClosable() {
  return isReady() && !importJobActive;
}

// Issue #57 QA(High): オーバーレイの畳みゲート。判断の順序規則は overlayGate.js
// （DOM 非依存・テスト対象）、DOM 操作だけをここから注入する。
// 意図フラグ（module レベル boolean）方式を撤去した経緯は overlayGate.js の冒頭に記載。
const overlayGate = createOverlayGate({
  closable: overlayClosable,
  viewClosed: projectViewClosed,
  fold: () => {
    $("importOverlay").hidden = true;
  },
  // #57 QA(Medium): 閉じている間の採用ではベースラインを前進させないため、ユーザーが
  // 明示的に開いて編集画面へ入った瞬間に「開いた時点」を作り直す（#54 の戻り先）。
  rebaseSnapshot: () => persistence.setOpenSnapshot(),
});

function showImportOverlay() {
  $("importOverlay").hidden = false;
  updateImportOverlay();
}

function hideImportOverlay() {
  if (overlayClosable()) $("importOverlay").hidden = true;
}

// オーバーレイの中身（セットアップ / 進捗）と強制表示を現状から導出する。
// - プロジェクト無し or 取込ジョブ進行中 → 強制表示（後者は進捗モード・閉じる不可）
// - 自動クローズはここではやらない（topbar 取込で開いた直後に閉じてしまうため）。
//   閉じるのは closeOverlayIfReady()（project-set 遷移時・取込完了時）とユーザー操作のみ。
function updateImportOverlay() {
  const overlay = $("importOverlay");
  if (!state.project || importJobActive) overlay.hidden = false;
  $("importSetup").hidden = importJobActive;
  $("importProgress").hidden = !importJobActive;
  $("importClose").hidden = !overlayClosable();
  renderSlots();
  renderWorkdirRow(); // #59: 未選択表示・案内文・「選び直す」の hidden を状態から導出する
}

// 採用（project-set）に伴うオーバーレイの追随。開いたまま待った完了のリフレッシュ経路が
// ここ（オーバーレイは既に hidden なので実質no-op だが判定は従来どおり）。
// Issue #57: 「閉じた状態のままジョブが完了した」場合は畳まない（データ採用はそのまま行われる）。
// ユーザー要求の「開く」はこの経路では畳まない — overlayGate.openAndEnter / runImport が
// open の成功を根拠に自分で畳む（QA(High): 意図フラグへの便乗と早期解除の排除）。
function closeOverlayIfReady() {
  overlayGate.onAdopt();
}

// ── 取込進捗（job-progress の kind === "import" だけを大型表示に反映） ──

const IMPORT_STAGES = ["loudness", "vad", "peaks"];

// サーバの message 文字列（英語）→ 段階キー。判定不能は null（表示は据え置き）。
// L: normalize=false の "Converting audio ..." も第1段階（loudness の枠）に載せる。
// 段階リストの見出しは normalize の有無で書き換える（setImportStageLabels）。
export function importStageOf(message) {
  const m = String(message || "");
  if (/loudness/i.test(m) || /Converting audio/i.test(m)) return "loudness";
  if (/\bVAD\b/i.test(m)) return "vad";
  if (/peaks/i.test(m)) return "peaks";
  return null;
}

// サーバの message 文字列 → 日本語表示（未知の文言はそのまま出す）
export function importMessageJa(message) {
  const m = String(message || "");
  const sp = (m.match(/speaker ([AB])/i) || [])[1];
  const suffix = sp ? `（Speaker ${sp.toUpperCase()}）` : "";
  if (/Analyzing loudness/i.test(m)) return `ラウドネス解析中${suffix}`;
  if (/Normalizing loudness/i.test(m)) {
    const pct = (m.match(/\((\d+)%\)/) || [])[1];
    return `ラウドネス正規化中${suffix}${pct ? ` ${pct}%` : ""}`;
  }
  // L: normalize=false の取込経路（loudnorm を飛ばした素の形式変換）
  if (/Converting audio/i.test(m)) {
    const pct = (m.match(/\((\d+)%\)/) || [])[1];
    return `音声変換中${suffix}${pct ? ` ${pct}%` : ""}`;
  }
  if (/Running VAD/i.test(m)) return `無音検出中${suffix}`;
  if (/Building peaks/i.test(m)) return `波形生成中${suffix}`;
  if (/Import complete/i.test(m)) return "取込完了";
  return m;
}

function onImportJobProgress(job) {
  if (!job || job.kind !== "import") return;
  const progress = Math.max(0, Math.min(1, Number(job.progress) || 0));
  const pct = Math.round(progress * 100);
  $("importBar").style.width = `${pct}%`;
  $("importPct").textContent = `${pct}%`;
  const barBox = document.querySelector("#importProgress .big-progress");
  if (barBox) barBox.setAttribute("aria-valuenow", String(pct));
  if (job.message) $("importMsg").textContent = importMessageJa(job.message);
  const stage = importStageOf(job.message);
  if (stage) {
    const idx = IMPORT_STAGES.indexOf(stage);
    for (const li of document.querySelectorAll("#importProgress .stage-list li")) {
      const liIdx = IMPORT_STAGES.indexOf(li.dataset.stage);
      li.classList.toggle("current", liIdx === idx);
      li.classList.toggle("done", liIdx < idx);
    }
  }
}

function resetImportProgressView() {
  $("importBar").style.width = "0%";
  $("importPct").textContent = "0%";
  $("importMsg").textContent = "アップロード中…";
  for (const li of document.querySelectorAll("#importProgress .stage-list li")) {
    li.classList.remove("current", "done");
  }
}

// ── ジョブ実行 ──────────────────────────────────────────

// Issue #53: 取込開始の入口。作業フォルダ指定時は workdir_precheck を先に呼び、
// 既存プロジェクト（project.json 実在）なら「再開 / 上書き / キャンセル」の確認
// ダイアログで分岐する。孤児レジストリエントリ（#34）はサーバが透過的に付け替える
// ため precheck は ok を返し、従来どおり即取込になる。precheck は UX 用の事前分岐で、
// 最終ガードはサーバの create_project 本体（同意フラグなしの上書きは 400）。
//
// Issue #59 QA: 順序規則（開始時スナップショット・取込直前の再評価）は importFlow.js に
// 切り出した。ここは DOM / モジュール変数との接続だけを持つ。readSelection はシーケンス中に
// 1回しか呼ばれず、以降 pendingWorkdir / pendingFiles は読み直されない = precheck 待ちに
// 「選び直す」を押されても、precheck を掛けた値と取り込む値が食い違わない。
const importFlow = createImportFlow({
  readSelection: () => ({
    fileA: pendingFiles.A,
    fileB: pendingFiles.B,
    workdir: pendingWorkdir,
  }),
  jobBusy: isJobBusy,
  precheck: (workdir) => persistence.precheckWorkdir(workdir),
  confirmConflict: () => confirmWorkdirConflict(),
  resume: (workdir) => resumeExistingProject(workdir),
  runImport: (args) => runImport(args),
  toast,
  // precheck〜確認ダイアログの間は作業フォルダ系を押せなくする。スナップショットが
  // 「押されても壊れない」を保証する一方、こちらは「効かないものを押せるように見せない」
  // （#59 QA。「選び直す」は表示中・非 disabled のまま precheck 往復を跨げていた）。
  setControlsBusy: (busy) => {
    $("importWorkdirChoose").disabled = busy;
    $("importWorkdirReset").disabled = busy;
  },
});

function startImportFlow() {
  return importFlow.start();
}

// [再開する]: 復元経路（openProjectFolder）へ。成功したらオーバーレイの選択状態を
// リセットする（オーバーレイ自体は overlayGate.openAndEnter が open 成功時に畳む）。
async function resumeExistingProject(folderPath) {
  // Issue #57 QA: startImportFlow 入口でも見ているが、そこから確認ダイアログを挟むため
  // ユーザーが待たせている間にジョブが完了/起票されうる。採用の交錯を避けて再チェックする。
  if (isJobBusy()) {
    toast("ジョブの進行中は再開できません（完了までお待ちください）", 6000);
    return;
  }
  try {
    // Issue #57: ユーザー要求の「開く」経路 → 成功したら閉じた状態からでもオーバーレイを畳む
    await overlayGate.openAndEnter(() => persistence.openProjectFolder(folderPath));
    pendingFiles.A = null;
    pendingFiles.B = null;
    pendingWorkdir = null;
    renderSlots();
    renderWorkdirRow();
    toast("プロジェクトを復元しました");
  } catch (err) {
    toast(`復元失敗: ${err.message}`, 8000);
  }
}

// Issue #53: 作業フォルダ衝突の確認。confirmExportOverwrite と同じ <dialog> の
// Promise ラッパーだが、3値（"resume" / "overwrite" / "cancel"）を返す。
// Esc（cancel イベント）と未知の submitter 値は "cancel"（persistence.workdirConflictChoice）。
function confirmWorkdirConflict() {
  const dialog = $("workdirConflictDialog");
  const form = $("workdirConflictForm");
  return new Promise((resolve) => {
    const settle = (choice) => {
      form.removeEventListener("submit", onSubmit);
      dialog.removeEventListener("cancel", onCancel);
      resolve(choice);
    };
    const onSubmit = (event) =>
      settle(persistence.workdirConflictChoice(event.submitter?.value));
    const onCancel = () => settle("cancel");
    form.addEventListener("submit", onSubmit);
    dialog.addEventListener("cancel", onCancel);
    dialog.showModal();
  });
}

// Issue #59 QA: 引数は importFlow が開始時に確定したスナップショット。workdir を
// モジュール変数（pendingWorkdir）から読み直していたのが TOCTOU の実行側の口だった
// ため、呼び出しに閉じた値だけを使う。
async function runImport({ fileA, fileB, workdir = null, overwrite = false } = {}) {
  if (isJobBusy()) return;
  const normalize = !!$("importNormalize").checked;
  beginJob();
  importJobActive = true;
  resetImportProgressView();
  setImportStageLabels(normalize);
  updateImportOverlay();
  const importName = $("projectName").value || "Untitled episode";
  // Issue #57 QA(High): 「この取込が成功した」ことを finally の畳み判定に渡すローカル変数。
  // module 変数の意図フラグと違いこの呼び出しに閉じているため、裏のジョブ完了が便乗できない。
  let importSucceeded = false;
  try {
    const job = await persistence.importFiles(
      fileA,
      fileB,
      importName,
      Number($("importLufs").value || $("targetLufs").value || -16),
      normalize,
      workdir, // スナップショット値（precheck を掛けたのと同じフォルダ）
      // Issue #37: ラウドネス詳細。デフォルト値でも送る（サーバ側既定と同値なら挙動不変）
      {
        truePeak: Number($("importTruePeak").value || -1.5),
        tolerance: Number($("importTolerance").value || 0.5),
      },
      // Issue #53: 確認ダイアログで「上書きして取り込む」を選んだときだけ true
      overwrite,
    );
    importSucceeded = true;
    pendingFiles.A = null;
    pendingFiles.B = null;
    pendingWorkdir = null; // 次の取込に前回の作業フォルダを引き継がない
    renderWorkdirRow();
    renderSlots(); // 未選択に戻ったので「取り込みを開始」を disabled に戻す（#59）
    // Issue #57: 取込中はオーバーレイが進捗モードで固定され通常は detached になりえないが、
    // 全ジョブ種で同じ規律に揃える（万一切り替わっていたら文脈付きで知らせる）
    toast(
      jobFinishToast("import", true, {
        id: job?.project_id,
        name: job?.result?.project?.name || importName,
      }) || "取込が完了しました",
    );
  } catch (err) {
    // 取込失敗はオーバーレイがセットアップモードへ戻り再試行が目前に出るため、
    // 文脈なしの従来文言のまま（Issue #57 の detached 通知は成功側のみで足りる）
    toast(`取込失敗: ${err.message}`, 12000);
  } finally {
    importJobActive = false;
    endJob();
    updateImportOverlay(); // 失敗時はセットアップモードに戻す（ファイルは保持 = 再試行が楽）
    // 成功時: ready になった時点では importJobActive が true だったのでここで畳む。
    // Issue #57: 直前の updateImportOverlay() が importSetup を再表示するため、この時点の
    // projectViewClosed() は真になる = 採用経路の判定では「閉じた状態のジョブ完了」と誤認して
    // 取込が編集画面に入れなくなる。取込もユーザー要求の「開く」経路なので、ここで
    // enterProjectView() が「この取込ジョブの完了」を根拠に直接畳む
    // （廃止対象は背後で走ったジョブの引き戻しだけ。取込オーバーレイ自身の完了遷移は正しい挙動）。
    // 失敗時は畳まない: 旧実装は finally で無条件に畳もうとしており、取込が途中で失敗しても
    // 直前に開いていたプロジェクトが ready のまま残っていると編集画面へ入ってしまう
    // （再試行の場が消える）。成功フラグを条件にして経路を閉じた。
    if (importSucceeded) overlayGate.enterProjectView();
  }
}

// 「閉じる」の確認: はい = 保存を確定してから取込オーバーレイへ戻す
// （プロジェクト自体は削除しない。次の取込 or 復元まで state は残り、✗ で戻れる）。
// いいえ = ダイアログが閉じるだけ（method="dialog" の既定動作）。
// 編集を破棄して閉じる（Issue #54）= 開いた時点のスナップショットへ巻き戻す PUT →
// 取込オーバーレイへ戻す。失敗したら編集画面に留まる（「破棄できていないのに
// 閉じた」と誤認させない — はい の保存失敗時と同じ判断）。
async function onCloseProjectSubmit(event) {
  const choice = event.submitter?.value;
  if (choice === "discard") {
    if (isJobBusy()) return; // ボタン disabled の二重ガード（採用・saveSoon との交錯防止）
    try {
      await persistence.discardToSnapshot();
      showImportOverlay();
    } catch (err) {
      toast(`破棄に失敗しました: ${err.message}`, 8000);
    }
    return;
  }
  if (choice !== "yes") return;
  try {
    await persistence.flushSave(); // 保留中のデバウンス保存を確定
    await persistence.saveProject(); // 予約が無くても最新状態を確実に PUT する
    showImportOverlay();
  } catch (err) {
    // 保存に失敗したら編集画面に留まる（保存できていないのに閉じたと誤認させない）
    toast(`保存に失敗しました: ${err.message}`, 8000);
  }
}

// 復元は「project.json を選ぶ」に一本化（実機フィードバック: 音源は 223MB×2 で
// アップロードは現実的でない）。選んだファイルの親フォルダを source_dir として渡し、
// サーバがフォルダ内の project.json を読む。project.json 以外の .json が選ばれても
// 親フォルダで開けばよいので黙って進める（失敗はサーバの 400 → toast）。
async function onRestoreFromJson() {
  // Issue #57 QA: ジョブ進行中は復元を弾く（自ボタンの disabled だけでは足りない —
  // ファイル選択ダイアログはユーザーが任意に待たせられるので、開始時と選択後の
  // 二度チェックする。ジョブ完了時の採用と復元の採用が交錯するのを防ぐ）。
  if (isJobBusy()) {
    toast("ジョブの進行中は復元できません（完了までお待ちください）", 6000);
    return;
  }
  const button = $("restoreFromJson");
  button.disabled = true; // ダイアログはサーバ側で開くので多重起動を防ぐ
  try {
    const res = await chooseFile("project_json");
    // キャンセルは正常系（サーバ契約: 200 + cancelled）— トーストを出さない
    if (res.cancelled || !res.path) return;
    // ダイアログ表示中にジョブが起票された場合（別経路から）も採用の交錯を避ける
    if (isJobBusy()) {
      toast("ジョブの進行中は復元できません（完了までお待ちください）", 6000);
      return;
    }
    // Issue #36: win32 の chooser はバックスラッシュ区切りを返すため両区切り対応の
    // parentDirOf で算出する。区切りが無いパス（null）は壊れた source_dir を
    // サーバへ投げずにこちらでエラー表示して止める。
    const parentDir = parentDirOf(res.path);
    if (parentDir === null) {
      toast(`復元失敗: 選択したパスから親フォルダを特定できません: ${res.path}`, 8000);
      return;
    }
    // Issue #57: ユーザー要求の「開く」経路 → 成功したら閉じた状態からでもオーバーレイを畳む
    await overlayGate.openAndEnter(() => persistence.openProjectFolder(parentDir));
    toast("プロジェクトを復元しました");
  } catch (err) {
    toast(`復元失敗: ${err.message}`, 8000);
  } finally {
    button.disabled = false;
  }
}

async function onTranscribe() {
  if (isJobBusy() || !isReady()) return;
  beginJob();
  const model = getWhisperModelRef();
  const jobProject = { id: state.project.id, name: state.project.name }; // Issue #57
  try {
    if (state.project?.settings) {
      state.project.settings.whisper_model = model;
      persistence.saveSoon(); // startTranscribe 冒頭の flushSave がまとめて反映する
    }
    toast("文字起こしを開始しました");
    await persistence.startTranscribe(model);
    // Issue #57: 同一プロジェクトが開いたまま（閉じても完了時の全置換採用で開き直る）なら
    // 従来文言。別プロジェクトへ切り替えていた場合は結果が採用されずサーバ保存のみの
    // ため「開き直すと反映」を文脈付きで知らせる。
    toast(jobFinishToast("transcribe", true, jobProject) || "文字起こしが完了しました");
  } catch (err) {
    toast(
      jobFinishToast("transcribe", false, jobProject, err.message) ||
        `文字起こし失敗: ${err.message}`,
      12000,
    );
  } finally {
    endJob();
  }
}

// Issue #32: 上書き確認。closeProjectDialog と同じ <dialog> を Promise で包む
// （ブラウザネイティブの confirm() は使わない — 表示が環境依存でボタン文言も揃えられない）。
// Esc（cancel イベント）は「いいえ」と同じ扱い。リスナーは settle で必ず両方外す
// （片方だけ once で残すと、次回表示時に前回の残骸が発火する）。
function confirmExportOverwrite() {
  const dialog = $("exportOverwriteDialog");
  const form = $("exportOverwriteForm");
  return new Promise((resolve) => {
    const settle = (yes) => {
      form.removeEventListener("submit", onSubmit);
      dialog.removeEventListener("cancel", onCancel);
      resolve(yes);
    };
    const onSubmit = (event) => settle(event.submitter?.value === "yes");
    const onCancel = () => settle(false);
    form.addEventListener("submit", onSubmit);
    dialog.addEventListener("cancel", onCancel);
    dialog.showModal();
  });
}

async function onExport() {
  if (isJobBusy() || !isReady()) return;
  beginJob();
  const jobProject = { id: state.project.id, name: state.project.name }; // Issue #57
  try {
    // 出力先の優先順: フォルダ選択（Issue #32・絶対パス）→ ベース選択（Issue #18・
    // 環境変数設定時のみ表示）→ 既定（null = プロジェクト内 exports 直下）。
    const baseSelect = $("exportBase");
    const basePath = baseSelect && !baseSelect.disabled ? baseSelect.value : "";
    const outputDir = chosenExportDir || basePath || null;
    // Issue #32: 出力先に前回の成果物が**実在するときだけ**上書き確認を出す。
    // 空フォルダ・初回は従来どおり無確認（#28 の「毎回上書きが既定」は変えない）。
    const check = await persistence.precheckExport(outputDir);
    if (check.exists) {
      const proceed = await confirmExportOverwrite();
      if (!proceed) return; // いいえ = 閉じるだけ（トーストも出さない）
    }
    toast("エクスポートを開始しました");
    const job = await persistence.startExport($("exportFormat").value, outputDir);
    // G: 出力先はトーストで流すだけでなく書き出し設定パネルに残す（panels が textContent 描画）
    showExportResult(job);
    const dir = job.result?.output_dir;
    // Issue #57: 閉じた/切り替えたプロジェクトの完了は文脈付き（出力先も添える）
    toast(
      jobFinishToast("export", true, jobProject, dir) ||
        (dir ? `エクスポート完了: ${dir}` : "エクスポートが完了しました"),
      12000,
    );
  } catch (err) {
    // exporter のアクティブ0件 ValueError（"nothing to export: no active blocks"）もここに出る（契約 §C）
    toast(
      jobFinishToast("export", false, jobProject, err.message) ||
        `エクスポート失敗: ${err.message}`,
      12000,
    );
  } finally {
    endJob();
  }
}

// topbar / 取込ボタンの disabled 更新。#57 QA で setJobBusy（main のローカルフラグ + 直接
// 再描画）は廃止し、在否は state（beginJob/endJob）が正・追随は "job-busy" 購読に移した
// （正規化のように main が所有しないジョブでも同じ経路で反映される）。
function updateTopbarEnabled() {
  const busy = isJobBusy();
  $("transcribe").disabled = busy || !isReady();
  $("exportProject").disabled = busy || !isReady();
  $("closeProject").disabled = !state.project;
  $("saveProject").disabled = !state.project;
  renderSlots();
}

// project-set 時の topbar 入力欄同期（編集中の欄は上書きしない — panels と同じ規律）
function syncTopbarInputs() {
  const project = state.project;
  setInputValue("projectName", project?.name ?? "Untitled episode");
  // targetLufs はトラック設定パネルの「ラウドネス」欄 → panels.syncTrackInputs が同期（Issue #37 追加FB）
  setInputValue("importLufs", project?.settings?.target_lufs ?? -16);
  // Issue #37: ラウドネス詳細（取込オーバーレイ側。パネル側は panels.syncTrackInputs が同期）
  setInputValue("importTruePeak", project?.settings?.true_peak ?? -1.5);
  setInputValue("importTolerance", project?.settings?.tolerance ?? 0.5);
  setInputValue("exportFormat", project?.settings?.export_format ?? "wav");
  // whisper系の入力欄同期は transcribeSettings が project-set で行う（§K）
}

function setInputValue(id, value) {
  const input = $(id);
  if (input && input !== document.activeElement) input.value = String(value);
}

// ── テーマ監視（prefers-color-scheme → canvas パレット切替。契約 §2-3） ──
// CSS はメディアクエリで自動追従する。canvas 側は waveform.THEME_COLORS の
// 定数切替（applyThemeColors）で追従させ、切替時のみ再描画する（性能予算維持）。

function initThemeWatcher() {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => waveform.applyThemeColors(mq.matches ? "dark" : "light");
  mq.addEventListener("change", apply);
  apply();
}

// ── 起動（module script は defer 実行 = DOM 構築済み） ──

function init() {
  initThemeWatcher(); // initWaveform より先: 初回描画から正しいテーマで塗る
  waveform.initWaveform({
    gutter: document.querySelector(".track-gutter"),
    scroll: $("tlScroll"),
    content: $("tlContent"),
    ruler: $("rulerCanvas"),
    canvasA: $("trackCanvasA"),
    canvasB: $("trackCanvasB"),
    playhead: $("playhead"),
    dragReadout: $("dragReadout"),
    seamStrip: $("seamStrip"),      // #59 PR4: transport 中央の Seam Strip
  });
  player.initPlayer();
  // Issue #57 QA(Medium): 閉じている間の採用で #54 の破棄ベースラインを前進させない。
  // 閉じ状態の正は DOM（panels.projectViewClosed）なので、DOM 非依存の persistence へ
  // 判定を注入する形にする（subscribe より先: 最初の採用より前に必ず登録されている）。
  persistence.setViewClosedProbe(projectViewClosed);
  subscribe(); // main の購読を panels/transcript/autoEdit/interactions より先に登録
  initPanels();
  initTranscriptPanel();
  initAutoEdit();
  initInteractions();
  initTranscribeSettings();
  bindTopbar();
  bindImportOverlay();
  updateTopbarEnabled();
  updateImportOverlay(); // 初期状態はプロジェクト無し → オンボーディング表示
  initExportTargets(); // Issue #18: 非同期。失敗しても従来UIのまま使える
}

// Issue #18: SEAM_EXPORT_DIR が設定されているときだけ書き出し先を
// プルダウン表示に切り替える。未設定・取得失敗時は従来のラベル入力のまま。
async function initExportTargets() {
  const row = $("exportBaseRow");
  const select = $("exportBase");
  const hint = $("exportDirHint");
  if (!row || !select) return;
  let data;
  try {
    data = await persistence.fetchExportTargets(state.project?.id || null);
  } catch {
    return; // ネットワーク不調でエクスポート機能ごと壊さない
  }
  const extra = (data?.targets || []).filter((t) => t && t.path && !t.is_default);
  if (!data?.configured || !extra.length) return;
  select.replaceChildren();
  // 先頭は常に「プロジェクト内」= 従来挙動（value 空 → ラベル指定に倒れる）
  const projectOption = document.createElement("option");
  projectOption.value = "";
  projectOption.textContent = "プロジェクト内";
  select.appendChild(projectOption);
  for (const target of extra) {
    const option = document.createElement("option");
    option.value = target.path; // textContent 経由で描画（XSS規律: innerHTML は使わない）
    option.textContent = `${target.label}: ${target.path}`;
    select.appendChild(option);
  }
  row.hidden = false;
  if (hint) hint.hidden = true;
}

init();
