// peaks.js — PPK1 ピークサイドカーのロードと区間 max 参照。
// 依存: api（fetch）+ state（格納先・epoch照合）。描画側への invalidate 要求は main が行う。
import { fetchPeaksBinary } from "./api.js";
import { state } from "./state.js";

// A/B を並列 fetch して state.peaks へ格納する。
// epoch が state.projectEpoch と一致しない応答（プロジェクト切替後に届いた旧世代）は破棄。
// fetch 失敗（404 = peaks未生成の旧プロジェクト等）は null のまま解決し、throw しない
// （フロントは「クリップ枠のみ描画」で編集続行できる）。
export async function loadPeaks(projectId, epoch) {
  await Promise.all(["A", "B"].map(async (speaker) => {
    let data = null;
    try {
      data = await fetchPeaksBinary(projectId, speaker);
    } catch {
      data = null;
    }
    if (state.projectEpoch !== epoch) return;
    state.peaks[speaker] = data;
  }));
}

// ソース時間区間 [srcT0, srcT1) と交差する bin の max（0..255）を返す。
// 端数バケットは両端とも含める（floor/ceil）。区間が bins の範囲外なら 0。
// srcT1 == srcT0 のとき（極小区間）は srcT0 の属する単一 bin を参照する。
export function peakMaxIn(peakData, srcT0, srcT1) {
  if (!peakData || !peakData.bins || peakData.bins.length === 0) return 0;
  if (!Number.isFinite(srcT0) || !Number.isFinite(srcT1) || srcT1 < srcT0) return 0;
  const { binsPerSec, bins } = peakData;
  let lo = Math.floor(srcT0 * binsPerSec);
  let hi = Math.max(lo + 1, Math.ceil(srcT1 * binsPerSec));
  if (hi <= 0 || lo >= bins.length) return 0;
  lo = Math.max(0, lo);
  hi = Math.min(bins.length, hi);
  let max = 0;
  for (let i = lo; i < hi; i += 1) {
    if (bins[i] > max) max = bins[i];
  }
  return max;
}
