// transcribeSettings.js — 文字起こし設定パネル（Issue #12 / 契約 §K）。
// 担当: Whisperモデルのプルダウン（未取得表示 + ダウンロードジョブ）/
//       カスタムパス入力（上級者向けの逃げ道）/ 計算精度・デバイスのプルダウン
//       （環境非対応の選択肢は disabled + 注記）/ settings への保存（saveSoon 経路）。
// データ源: GET /api/whisper/models（契約 §K-1）。取得失敗時は FALLBACK_* で
//   同じUIを静的に構成する（オフライン・サーバ旧版でも操作不能にしない）。
// ダウンロード: POST /api/whisper/models/download → 既存ジョブ形式
//   （kind="model_download"）。pollJob の onProgress で "job-progress" を emit して
//   topbar のジョブチップに乗せつつ、パネル内 #whisperDownloadStatus にも%を出す。
// モジュールトップで DOM に触らない（純関数は node でテスト可能）。
// 依存: state / api / persistence（saveSoon）。main が initTranscribeSettings() を呼び、
//   文字起こし実行時は getWhisperModelRef() で参照値を読む。

import { state, on, emit } from "./state.js";
import { api, pollJob } from "./api.js";
import { saveSoon } from "./persistence.js";

export const CUSTOM_MODEL_VALUE = "__custom__";

// サーバ到達不能時のフォールバック（server.py WHISPER_MODEL_NAMES / SPEED_HINTS と同値）。
// downloaded: null = 取得状況不明（未取得扱いの注記は出さない）。
export const FALLBACK_MODELS = [
  { name: "tiny", downloaded: null, size_bytes: null, speed_hint: "mediumの約8倍速・精度低" },
  { name: "base", downloaded: null, size_bytes: null, speed_hint: "mediumの約5倍速" },
  { name: "small", downloaded: null, size_bytes: null, speed_hint: "mediumの2〜3倍速・日本語会話で実用的" },
  { name: "medium", downloaded: null, size_bytes: null, speed_hint: "既定・バランス型" },
  { name: "large-v3", downloaded: null, size_bytes: null, speed_hint: "最高精度・mediumの約2倍遅" },
];

export const FALLBACK_COMPUTE_TYPES = [
  { value: "auto", label: "自動", available: true, note: null },
  { value: "int8", label: "int8（高速）", available: true, note: "CPUで1.5〜2倍速。精度低下は軽微。macOSで推奨" },
  { value: "float16", label: "float16", available: false, note: "CUDA環境のみ選択可能" },
  { value: "float32", label: "float32（最高精度）", available: true, note: "最も遅い" },
];

// 未取得モデルの概算サイズ表示（server.py WHISPER_MODEL_APPROX_BYTES と同値の目安）
const APPROX_SIZE_LABELS = {
  tiny: "約75MB",
  base: "約145MB",
  small: "約480MB",
  medium: "約1.5GB",
  "large-v3": "約3.1GB",
};

let els = null;
let catalog = null;        // {models, environment} | null（フォールバック時も同形）
let catalogStale = false;  // フォールバック表示中か（注記に出す）
let downloadBusy = false;

// ── 純関数（テスト対象） ────────────────────────────────

// bytes → "484 MB" / "1.5 GB"。null/0/不正は ""。
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

// settings.whisper_model がローカルパス指定かどうか（"/" "\" "~" "." 始まりや区切り含み）。
export function isCustomModelRef(ref) {
  const s = String(ref || "");
  return /[\\/]/.test(s) || s.startsWith("~") || s.startsWith(".");
}

// モデル → プルダウン表示文言。未取得（downloaded === false）だけ「（未取得）」を付ける。
export function modelOptionLabel(model) {
  let label = model.name;
  if (model.speed_hint) label += ` — ${model.speed_hint}`;
  if (model.downloaded === false) label += "（未取得）";
  return label;
}

// 計算精度 → プルダウン表示文言。選べない選択肢は注記を文言に埋め込む
// （disabled な option は選択できず note 表示が出せないため、一覧上で見えるようにする）。
export function computeOptionLabel(ct) {
  if (ct.available === false && ct.note) return `${ct.label} — ※${ct.note}`;
  return ct.label;
}

// デバイスの選択肢。cuda は環境に無ければ disabled + 注記。
export function deviceOptions(cudaAvailable) {
  return [
    { value: "auto", label: "自動", available: true, note: null },
    { value: "cpu", label: "CPU", available: true, note: null },
    { value: "cuda", label: "CUDA (GPU)", available: !!cudaAvailable, note: "CUDA環境のみ選択可能" },
  ];
}

// settings.whisper_model → プルダウンの選択状態。
// 一覧に無い値（パスや未知名）はカスタム扱いにして入力欄へ引き継ぐ（値を握り潰さない）。
export function selectionForModelRef(models, ref) {
  const name = String(ref || "medium");
  if ((models || []).some((m) => m.name === name)) {
    return { value: name, customPath: "" };
  }
  return { value: CUSTOM_MODEL_VALUE, customPath: name };
}

// ── 初期化 / 結線 ───────────────────────────────────────

const $ = (id) => document.getElementById(id);

export function initTranscribeSettings() {
  els = {
    model: $("whisperModelSelect"),
    modelNote: $("whisperModelNote"),
    downloadRow: $("whisperDownloadRow"),
    download: $("whisperDownload"),
    downloadStatus: $("whisperDownloadStatus"),
    customRow: $("whisperCustomRow"),
    customPath: $("whisperCustomPath"),
    compute: $("whisperComputeType"),
    computeNote: $("whisperComputeNote"),
    device: $("whisperDevice"),
  };

  els.model.addEventListener("change", () => {
    renderModelDetail();
    saveModelSetting();
  });
  els.customPath.addEventListener("change", saveModelSetting);
  els.compute.addEventListener("change", () => {
    renderComputeNote();
    saveSetting("whisper_compute_type", els.compute.value);
  });
  els.device.addEventListener("change", () => {
    saveSetting("whisper_device", els.device.value);
  });
  els.download.addEventListener("click", () => {
    void runDownload();
  });

  on("project-set", syncFromSettings);

  renderAll(); // まずフォールバックで即席レンダー（カタログ到着で差し替え）
  void refreshCatalog();
}

// GET /api/whisper/models。失敗したらフォールバック構成（catalogStale=true）。
async function refreshCatalog() {
  try {
    const data = await api("/api/whisper/models");
    if (Array.isArray(data?.models) && data.models.length) {
      catalog = data;
      catalogStale = false;
    } else {
      catalog = null;
      catalogStale = true;
    }
  } catch {
    catalog = null;
    catalogStale = true;
  }
  renderAll();
}

function currentModels() {
  return catalog?.models || FALLBACK_MODELS;
}

function currentComputeTypes() {
  return catalog?.environment?.compute_types || FALLBACK_COMPUTE_TYPES;
}

function cudaAvailable() {
  return !!catalog?.environment?.cuda_available;
}

// ── 描画 ────────────────────────────────────────────────

function renderAll() {
  renderModelSelect();
  renderComputeSelect();
  renderDeviceSelect();
  syncFromSettings();
}

function buildOption(value, label, disabled = false) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label; // 表示文言は textContent（XSS規律）
  if (disabled) opt.disabled = true;
  return opt;
}

function renderModelSelect() {
  const keep = els.model.value;
  els.model.textContent = "";
  for (const model of currentModels()) {
    els.model.append(buildOption(model.name, modelOptionLabel(model)));
  }
  els.model.append(buildOption(CUSTOM_MODEL_VALUE, "カスタムパス…（上級者向け）"));
  if (keep && [...els.model.options].some((o) => o.value === keep)) {
    els.model.value = keep;
  }
}

function renderComputeSelect() {
  const keep = els.compute.value;
  els.compute.textContent = "";
  for (const ct of currentComputeTypes()) {
    els.compute.append(buildOption(ct.value, computeOptionLabel(ct), ct.available === false));
  }
  if (keep && [...els.compute.options].some((o) => o.value === keep && !o.disabled)) {
    els.compute.value = keep;
  }
}

function renderDeviceSelect() {
  const keep = els.device.value;
  els.device.textContent = "";
  for (const dev of deviceOptions(cudaAvailable())) {
    const label = dev.available === false && dev.note ? `${dev.label} — ※${dev.note}` : dev.label;
    els.device.append(buildOption(dev.value, label, dev.available === false));
  }
  if (keep && [...els.device.options].some((o) => o.value === keep && !o.disabled)) {
    els.device.value = keep;
  }
}

function selectedModel() {
  const value = els.model.value;
  if (value === CUSTOM_MODEL_VALUE) return null;
  return currentModels().find((m) => m.name === value) || null;
}

// モデル選択の従属表示: カスタム行 / 未取得注記 + ダウンロード行
function renderModelDetail() {
  const isCustom = els.model.value === CUSTOM_MODEL_VALUE;
  els.customRow.hidden = !isCustom;

  const model = selectedModel();
  const notes = [];
  let showDownload = false;

  if (catalogStale) {
    notes.push("モデル一覧を取得できませんでした（既定リストを表示中）");
  }
  if (!isCustom && model && model.downloaded === false) {
    const size = APPROX_SIZE_LABELS[model.name] ? `（${APPROX_SIZE_LABELS[model.name]}）` : "";
    notes.push(`このモデルは未取得です${size}。下のボタンでダウンロードできます`);
    showDownload = true;
  }
  if (isCustom) {
    notes.push("faster-whisper 形式のモデルディレクトリを指定します");
  }

  els.modelNote.textContent = notes.join("。");
  els.modelNote.hidden = notes.length === 0;
  els.downloadRow.hidden = !showDownload;
  els.download.disabled = downloadBusy;
  if (!showDownload) els.downloadStatus.textContent = "";
}

// 計算精度の従属表示: 選択中の選択肢の note を出す（int8 の「macOSで推奨」等）
function renderComputeNote() {
  const ct = currentComputeTypes().find((item) => item.value === els.compute.value);
  const note = ct?.note || "";
  els.computeNote.textContent = note ? `※${note}` : "";
  els.computeNote.hidden = !note;
}

// project-set / カタログ更新時に settings から選択状態を復元。
// プロジェクト未取込（settings 無し）のときはユーザーの一時選択を上書きしない
// （カタログ再取得＝ダウンロード完了後に選択が medium へ戻る事故を防ぐ）。
// 初回だけ既定 medium を立てる（select の既定は先頭 option = tiny になってしまうため）。
function syncFromSettings() {
  const settings = state.project?.settings || null;
  if (settings) {
    const sel = selectionForModelRef(currentModels(), settings.whisper_model ?? "medium");
    if (els.model !== document.activeElement) els.model.value = sel.value;
    if (sel.customPath && els.customPath !== document.activeElement) {
      els.customPath.value = sel.customPath;
    }
    const compute = String(settings.whisper_compute_type ?? "auto");
    if ([...els.compute.options].some((o) => o.value === compute)) {
      els.compute.value = compute;
    }
    const device = String(settings.whisper_device ?? "auto");
    if ([...els.device.options].some((o) => o.value === device)) {
      els.device.value = device;
    }
  } else {
    // プロジェクト未読込のときは既定(medium)を選ぶ。select は一覧描画直後に
    // 先頭(tiny)を自動選択しているため `!els.model.value` では捕まらず、
    // 取得済みの medium があるのに「未取得」と表示されていた（実機フィードバック）。
    if (els.model !== document.activeElement) {
      els.model.value = selectionForModelRef(currentModels(), "medium").value;
    }
  }
  renderModelDetail();
  renderComputeNote();
}

// ── 保存（既存 saveSoon 経路） ──────────────────────────

function saveSetting(key, value) {
  if (!state.project?.settings) return;
  state.project.settings[key] = value;
  saveSoon();
}

function saveModelSetting() {
  const ref = getWhisperModelRef();
  if (ref) saveSetting("whisper_model", ref);
}

// main.onTranscribe が読む公開API。カスタム時は入力パス（空なら medium にフォールバック）。
export function getWhisperModelRef() {
  if (!els) return state.project?.settings?.whisper_model ?? "medium";
  if (els.model.value === CUSTOM_MODEL_VALUE) {
    return els.customPath.value.trim() || "medium";
  }
  return els.model.value || state.project?.settings?.whisper_model || "medium";
}

// ── モデルダウンロード（既存ジョブ基盤に乗せる） ────────

async function runDownload() {
  const model = selectedModel();
  if (!model || downloadBusy) return;
  downloadBusy = true;
  els.download.disabled = true;
  els.downloadStatus.textContent = "開始中…";
  try {
    const data = await api("/api/whisper/models/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model.name }),
    });
    const job = await pollJob(data.job, (j) => {
      emit("job-progress", j); // topbar ジョブチップにも進捗を出す
      const pct = Math.round(Math.max(0, Math.min(1, Number(j?.progress) || 0)) * 100);
      if (j?.status === "running") {
        // DL中に別モデルへ切り替えると、旧DLの%が新モデルの行に出て
        // 取り違えるため、対象モデル名を必ず添える（QA指摘）
        els.downloadStatus.textContent = `${model.name} をダウンロード中… ${pct}%`;
      }
    });
    const size = formatBytes(job.result?.size_bytes);
    els.downloadStatus.textContent = "";
    emit("toast", {
      message: `モデル ${model.name} のダウンロードが完了しました${size ? `（${size}）` : ""}`,
    });
    await refreshCatalog(); // downloaded 状態を反映（「未取得」表示が消える）
  } catch (err) {
    els.downloadStatus.textContent = "";
    emit("toast", { message: `モデルのダウンロードに失敗: ${err.message}`, timeout: 8000 });
  } finally {
    downloadBusy = false;
    els.download.disabled = false;
    renderModelDetail();
  }
}
