// api.js — 通信のみ（DOM / state 参照禁止）。
// 契約: このモジュールは fetch と応答のパースだけを行い、DOM・state には触れない。
// 注: fetchWavMeta はヘッダ解析に pcm.parseWavHeader（純関数）を使うため pcm.js を import する。
//     pcm → api（fetchPcmRange）と相互参照になるが、双方とも関数本体内でしか相手の
//     エクスポートを参照しないため ES modules の評価順序に依存しない。

import { parseWavHeader } from "./pcm.js";

const JOB_POLL_INTERVAL_MS = 1400;
const WAV_HEADER_PROBE_BYTES = 4096;
const WAV_HEADER_RETRY_BYTES = 65536;

async function errorMessage(response) {
  let message = `${response.status} ${response.statusText}`;
  try {
    const text = await response.text();
    if (text) {
      try {
        const data = JSON.parse(text);
        const detail = data.detail ?? data.error;
        if (detail !== undefined && detail !== null) {
          message = typeof detail === "string" ? detail : JSON.stringify(detail);
        }
      } catch (_err) {
        message = text;
      }
    }
  } catch (_err) {
    // 本文が読めなくてもステータス行で報告する
  }
  return message;
}

// fetch + !ok → Error(detail 整形)。JSON を返す全エンドポイントの共通経路。
export async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

// PPK1 サイドカーのパース（純関数・テスト対象）。
// offset 0: "PPK1" / 4: uint32LE bins_per_sec / 8: uint32LE bin_count / 12: reserved / 16: uint8×bin_count
export function parsePpk1(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 16) throw new Error("peaks: PPK1 ヘッダが不足しています");
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "PPK1") throw new Error(`peaks: 不明なフォーマットです (magic=${JSON.stringify(magic)})`);
  const binsPerSec = view.getUint32(4, true);
  const binCount = view.getUint32(8, true);
  if (binsPerSec === 0) throw new Error("peaks: bins_per_sec が 0 です");
  if (binCount === 0) throw new Error("peaks: bin_count が 0 です");
  if (view.byteLength < 16 + binCount) {
    throw new Error(`peaks: 本文が切り詰められています（宣言 ${binCount} bins / 実 ${view.byteLength - 16} bytes）`);
  }
  return { binsPerSec, bins: new Uint8Array(arrayBuffer, 16, binCount) };
}

// ピークサイドカーの取得 → PeakData {binsPerSec, bins: Uint8Array}
export async function fetchPeaksBinary(projectId, speaker) {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/peaks/${speaker}`);
  if (!response.ok) throw new Error(await errorMessage(response));
  return parsePpk1(await response.arrayBuffer());
}

async function fetchAudioRange(projectId, speaker, byteStart, byteEndInclusive) {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/audio/${speaker}`, {
    headers: { Range: `bytes=${byteStart}-${byteEndInclusive}` },
  });
  if (response.status !== 206) {
    // 200 を slice で受理しない: FileResponse が Range 非対応実装に差し替えられた場合に
    // 316MB 級 WAV を全量ダウンロードする事故を防ぐ安全弁
    throw new Error(`audio ${speaker}: Range 応答が 206 ではありません (got ${response.status})`);
  }
  return response.arrayBuffer();
}

// WAV ヘッダの取得と解析 → WavMeta。
// bytes=0-4095 で解析し、切詰めが原因で fmt/data に届かないときだけ bytes=0-65535 で1回再試行。
export async function fetchWavMeta(projectId, speaker) {
  const head = await fetchAudioRange(projectId, speaker, 0, WAV_HEADER_PROBE_BYTES - 1);
  try {
    return parseWavHeader(head);
  } catch (err) {
    if (!err || err.code !== "WAV_HEADER_INCOMPLETE") throw err;
  }
  const wider = await fetchAudioRange(projectId, speaker, 0, WAV_HEADER_RETRY_BYTES - 1);
  return parseWavHeader(wider);
}

// PCM バイト範囲の取得（206 必須）。meta は契約上のシグネチャ維持のため受け取る（範囲計算は pcm.js 側）。
export async function fetchPcmRange(projectId, speaker, meta, byteStart, byteEndInclusive) {
  return fetchAudioRange(projectId, speaker, byteStart, byteEndInclusive);
}

// ジョブ完了までポーリング。onProgress(job) は毎回（初回・完了時含む）呼ぶ。error 時は throw。
export async function pollJob(job, onProgress) {
  let current = job;
  if (onProgress) onProgress(current);
  while (current && current.status === "running") {
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
    current = await api(`/api/jobs/${job.id}`);
    if (onProgress) onProgress(current);
  }
  if (!current || current.status === "error") {
    throw new Error(current?.error || `${current?.kind || "job"} が失敗しました`);
  }
  return current;
}

// OS のフォルダ選択ダイアログ（POST /api/system/choose_folder）→ {path, cancelled}。
// キャンセルは 200 + {path: null, cancelled: true} で返る**正常系**（サーバ契約）:
// 呼び出し側は cancelled のときエラートーストを出してはいけない。
export async function chooseFolder(purpose, prompt) {
  const payload = { purpose };
  if (prompt != null) payload.prompt = prompt;
  return api("/api/system/choose_folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// OS のファイル選択ダイアログ（POST /api/system/choose_file）→ {path, cancelled}。
// キャンセル契約は chooseFolder と同じ（200 + cancelled は正常系。トースト禁止）。
export async function chooseFile(purpose, prompt) {
  const payload = { purpose };
  if (prompt != null) payload.prompt = prompt;
  return api("/api/system/choose_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// プロジェクト全量 PUT → {project}
export async function putProject(projectDict) {
  return api(`/api/projects/${encodeURIComponent(projectDict.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(projectDict),
  });
}

// 契約 §A の正準ペイロードキーのみ送る（close_gaps / gap_threshold_s 系は廃案）。
// target_pairs（D: 選択適用）は [[a_id, b_id], ...]。**省略/null と空配列 [] は意味が違う**:
// 省略 = 全被りが対象 / [] = 被り解消0件（無音詰めは独立して走る）。
// 呼び出し側が「全チェックを外した」状態を送るときに undefined を渡すと全件適用になるため、
// 選択適用モードでは常に配列を明示送信すること（BE1 申し送り3）。
const AUTO_EDIT_KEYS = [
  "tighten_gaps",
  "tighten_overlaps",
  "dry_run",
  "max_gap_s",
  "keep_gap_s",
  "max_overlap_s",
  "if_blocks_digest",
  "target_pairs",
];

export async function postAutoEdit(projectId, opts = {}) {
  const payload = {};
  for (const key of AUTO_EDIT_KEYS) {
    if (opts[key] !== undefined) payload[key] = opts[key];
  }
  return api(`/api/projects/${encodeURIComponent(projectId)}/auto_edit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
