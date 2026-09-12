// utils.js — 汎用ユーティリティ。依存なし・純関数のみ（node実行可）。

export function fmt(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

// 秒 → "+1,234 ms"（符号 + 3桁区切り）。ドラッグ中のオフセット表示用。
export function fmtMs(seconds) {
  const ms = Math.round((Number(seconds) || 0) * 1000);
  const sign = ms < 0 ? "-" : "+";
  const grouped = String(Math.abs(ms)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped} ms`;
}

export function dbToLinear(db) {
  return Math.max(0, Math.pow(10, Number(db || 0) / 20));
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function round3(v) {
  return Math.round(v * 1e3) / 1e3;
}

// サーバ timeline.py の round(x, 6) と揃える丸め（ゴールデンフィクスチャで同値検証）。
export function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

export function blockDuration(b) {
  return Math.max(0, b.source_end - b.source_start);
}

export function blockEnd(b) {
  return b.start + blockDuration(b);
}

// buildExportOutputDir（Issue #18 のサブフォルダ名手書き入力）は Issue #32 で廃止:
// 出力先はネイティブのフォルダ選択（main.js の #exportDirChoose）で絶対パスを渡す。

// コンテナ内スクロールの "nearest" 計算（scrollIntoView の代替。Issue #20 実機FB）。
// scrollIntoView({block:"nearest"}) はスクロール可能な**全祖先**（ページ含む）を
// 動かすため、リスト追従のたびにページが勝手に下スクロールしてしまう。
// リストのコンテナだけを動かすための純関数: 行が全部見えていれば現状維持、
// 上にはみ出していれば行頭が上端に、下にはみ出していれば行末が下端に来る位置を返す。
// itemTop はコンテナのコンテンツ座標（scrollTop と同系）で渡す。
export function nearestScrollTop(scrollTop, viewportH, itemTop, itemH) {
  if (itemTop < scrollTop) return itemTop;
  const bottomOverflow = itemTop + itemH - (scrollTop + viewportH);
  if (bottomOverflow > 0) return Math.min(itemTop, scrollTop + bottomOverflow);
  return scrollTop;
}

// 二分探索: keyFn昇順の arr で最初に keyFn(arr[i]) >= target となる位置を返す。
export function lowerBound(arr, target, keyFn) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keyFn(arr[mid]) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Issue #37: ラウドネス設定の既定値。サーバ側 models.py の default_settings()
// （target_lufs: -16.0 / true_peak: -1.5 / tolerance: 0.5）と対応。片方を変えたら
// もう片方も揃えること（クライアント側の既定値参照はこの定数に一元化する）。
export const LOUDNORM_DEFAULTS = Object.freeze({
  target_lufs: -16,
  true_peak: -1.5,
  tolerance: 0.5,
});

// Issue #37: ラウドネス設定リセット。settings のラウドネス3項目を既定値へ戻し、
// 1項目でも書き換えたら true を返す（保存の要否判断に使う）。DOM 非依存・テスト対象。
export function applyLoudnormDefaults(settings) {
  if (!settings) return false;
  let changed = false;
  for (const [key, value] of Object.entries(LOUDNORM_DEFAULTS)) {
    if (settings[key] !== value) {
      settings[key] = value;
      changed = true;
    }
  }
  return changed;
}

// Issue #36: choose_file が返したフルパスから親フォルダを求める。
// win32 の PowerShell ダイアログはバックスラッシュ区切りを返すため両区切りに対応する。
// 区切りが1つも無いパスは親を特定できないので null を返す（呼び出し側でエラー表示。
// 壊れたパスを source_dir としてサーバへ投げない安全側の倒し方）。
export function parentDirOf(path) {
  const p = String(path ?? "");
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx < 0) return null;
  const parent = p.slice(0, idx);
  // ルート直下は区切りを保ったルートを返す:
  //   "/project.json"    → "/"（POSIX ルート。parent が空になるケース）
  //   "C:\project.json"  → "C:\"（"C:" だけ返すと drive-relative パスになり
  //                         Windows では「C: の現在ディレクトリ」を指してしまう）
  if (!parent || /^[A-Za-z]:$/.test(parent)) return p.slice(0, idx + 1);
  return parent;
}
