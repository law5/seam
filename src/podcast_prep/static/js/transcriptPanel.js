// transcriptPanel.js — 文字起こしパネル。
// projectTimelineTranscripts のクライアント側射影を #transcriptList に全行描画（textContent厳守）。
// - playhead-tick（パネル内100ms間引き）で現在行ハイライト + リスト内スクロール追従
//   （scrollIntoView はページも動かすため不使用 — scrollListToRow 参照）
// - ユーザーがパネルをスクロールしたら追従を4秒停止（自動再開）
// - 行クリック = seek + ブロック選択 + タイムラインスクロール
// - #search は部分一致フィルタ（hidden 切替）
// refreshTranscripts は main が project-set / blocks-changed で呼ぶ（§10.4）。
// playhead-tick とパネル内スクロールは自モジュールで購読する。
// 選択は state.selectedBlockId + selection-changed emit を直接行う
// （依存図で transcriptPanel → edits が無いため。意味論は edits.selectBlock と同一）。

import { state, emit, on } from "./state.js";
import { fmt, nearestScrollTop } from "./utils.js";
import { projectTimelineTranscripts } from "./timelineModel.js";
import * as player from "./player.js";
import * as waveform from "./waveform.js";

const TICK_THROTTLE_MS = 100;
const FOLLOW_PAUSE_MS = 4000;
const PROGRAMMATIC_SCROLL_WINDOW_MS = 150;
const BACKSCAN_LIMIT = 64; // 現在行探索の後方走査上限（行の重なりは高々数件）

let els = null;
let rows = [];
let rowEls = [];
let activeIdx = -1;
let lastTickAt = 0;
let lastT = 0;
let userScrollUntil = 0;
let programmaticScrollAt = 0;
let filterQuery = "";

export function initTranscriptPanel(elements) {
  els = elements || {
    list: document.getElementById("transcriptList"),
    search: document.getElementById("search"),
  };
  els.list.addEventListener("click", onListClick);
  els.list.addEventListener("scroll", onListScroll);
  if (els.search) {
    els.search.addEventListener("input", () => {
      filterQuery = els.search.value || "";
      applyFilter();
    });
  }
  on("playhead-tick", onTick);
  refreshTranscripts();
}

export function refreshTranscripts() {
  if (!els) return;
  const list = els.list;
  const prevScroll = list.scrollTop;
  activeIdx = -1;
  rowEls = [];
  rows = state.project ? projectTimelineTranscripts(state.project, state.editVersion) : [];

  if (!state.project) {
    list.classList.add("empty");
    list.textContent = "プロジェクトを取り込んでください";
    return;
  }
  if (rows.length === 0) {
    list.classList.add("empty");
    list.textContent = "まだ文字起こしがありません。上の「2 文字起こし」を実行すると、ここに会話が表示されます";
    return;
  }

  list.classList.remove("empty");
  list.textContent = "";
  const frag = document.createDocumentFragment();
  rows.forEach((seg, i) => {
    const row = document.createElement("div");
    row.className = "transcript-row";
    row.dataset.i = String(i);
    const time = document.createElement("span");
    time.className = "t-time";
    time.textContent = fmt(seg.start);
    const speaker = document.createElement("span");
    speaker.className = `t-speaker ${seg.speaker === "A" ? "sp-a" : "sp-b"}`;
    speaker.textContent = seg.speaker;
    const text = document.createElement("span");
    text.className = "t-text";
    text.textContent = seg.text || ""; // 音声由来テキストは textContent（XSS規律）
    row.append(time, speaker, text);
    frag.append(row);
    rowEls.push(row);
  });
  list.append(frag);
  applyFilter();
  // 再構築後も現在行ハイライトを維持（スクロールはしない）
  setActive(_findRowAt(rows, lastT));
  programmaticScrollAt = performance.now();
  list.scrollTop = prevScroll;
}

// ── 再生ヘッド連動 ──────────────────────────────────────

function onTick(t) {
  if (!els || !Number.isFinite(t)) return;
  lastT = t;
  const now = performance.now();
  if (now - lastTickAt < TICK_THROTTLE_MS) return;
  lastTickAt = now;
  const idx = _findRowAt(rows, t);
  if (idx === activeIdx) return;
  setActive(idx);
  if (idx >= 0 && now > userScrollUntil) {
    programmaticScrollAt = now;
    scrollListToRow(els.list, rowEls[idx]);
  }
}

// リスト内スクロールに限定した現在行追従（Issue #20 実機FB）。
// scrollIntoView({block:"nearest"}) はページ等の祖先もスクロールしてしまい、
// 縦が狭い環境で「画面が勝手に下スクロールする」原因になっていた。
function scrollListToRow(list, rowEl) {
  // 検索フィルタで hidden の行は getBoundingClientRect が全ゼロを返し
  // itemTop が壊れてリストが先頭へ飛ぶ（QA #41 指摘。旧 scrollIntoView は
  // hidden 要素で no-op だった挙動に合わせて追従しない）
  if (rowEl.hidden) return;
  const cRect = list.getBoundingClientRect();
  const rRect = rowEl.getBoundingClientRect();
  const itemTop = rRect.top - cRect.top + list.scrollTop;
  const next = nearestScrollTop(list.scrollTop, list.clientHeight, itemTop, rRect.height);
  if (next !== list.scrollTop) list.scrollTop = next;
}

function setActive(idx) {
  if (activeIdx >= 0 && rowEls[activeIdx]) rowEls[activeIdx].classList.remove("active");
  activeIdx = idx;
  if (idx >= 0 && rowEls[idx]) rowEls[idx].classList.add("active");
}

// t を含む行 index（start <= t < end）を返す。無ければ -1。
// rows は (start, end, speaker) 昇順。upperBound(start<=t) から後方へ有界走査
// （行区間の重なりは同時発話ぶんだけなので実際は数行）。テスト用に export。
export function _findRowAt(rowList, t) {
  let lo = 0;
  let hi = rowList.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rowList[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo - 1, steps = 0; i >= 0 && steps < BACKSCAN_LIMIT; i--, steps++) {
    if (rowList[i].start <= t && t < rowList[i].end) return i;
  }
  return -1;
}

// ── スクロール / クリック / フィルタ ────────────────────

function onListScroll() {
  if (performance.now() - programmaticScrollAt < PROGRAMMATIC_SCROLL_WINDOW_MS) return;
  userScrollUntil = performance.now() + FOLLOW_PAUSE_MS; // 手動スクロール: 追従4秒停止
}

function onListClick(event) {
  const rowEl = event.target.closest(".transcript-row");
  if (!rowEl || !els.list.contains(rowEl)) return;
  const seg = rows[Number(rowEl.dataset.i)];
  if (!seg) return;
  player.seek(seg.start);
  if (state.selectedBlockId !== seg.blockId) {
    state.selectedBlockId = seg.blockId;
    emit("selection-changed");
  }
  waveform.scrollToTime(seg.start, "center");
}

function applyFilter() {
  const query = filterQuery.trim().toLowerCase();
  for (let i = 0; i < rowEls.length; i++) {
    const match = !query || (rows[i].text || "").toLowerCase().includes(query);
    rowEls[i].hidden = !match;
  }
}
