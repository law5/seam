// timelineModel.js — タイムライン純関数群。DOM / fetch / state 直接参照は禁止（node --test 対象）。
// recomputeOverlapsSweep / projectTimelineTranscripts はサーバ timeline.py と完全同値
// （ゴールデンフィクスチャ tests/js/fixtures/ で固定）。

import { blockDuration, blockEnd, lowerBound, round3, round6 } from "./utils.js";

const SPEAKERS = ["A", "B"];
const SPLIT_GUARD_S = 0.05; // ブロック端から50ms以内の分割は拒否

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isActive(b) {
  return !b.deleted && blockDuration(b) > 0;
}

// timeline.py active_blocks と同じ (start, source_start, id) 昇順
function activeSorted(blocks, speaker) {
  const out = [];
  for (const b of blocks || []) {
    if (isActive(b) && b.speaker === speaker) out.push(b);
  }
  out.sort((a, b) => a.start - b.start || a.source_start - b.source_start || cmpStr(a.id, b.id));
  return out;
}

// ── インデックス（editVersionキーの単一スロットメモ化） ──

let indexMemo = { project: null, version: -1, index: null };

export function getIndex(project, editVersion) {
  if (indexMemo.index && indexMemo.project === project && indexMemo.version === editVersion) {
    return indexMemo.index;
  }
  const byStart = { A: [], B: [] };
  const bySource = { A: [], B: [] };
  const maxDur = { A: 0, B: 0 };
  let timelineEnd = 0;
  for (const sp of SPEAKERS) {
    const arr = activeSorted(project?.blocks, sp);
    byStart[sp] = arr;
    bySource[sp] = arr
      .slice()
      .sort((a, b) => a.source_start - b.source_start || a.source_end - b.source_end || cmpStr(a.id, b.id));
    for (const b of arr) {
      const d = blockDuration(b);
      if (d > maxDur[sp]) maxDur[sp] = d;
      const e = blockEnd(b);
      if (e > timelineEnd) timelineEnd = e;
    }
  }
  const index = { byStart, bySource, maxDur, timelineEnd };
  indexMemo = { project, version: editVersion, index };
  return index;
}

// ── カリング / ヒットテスト ──

export function visibleBlocks(index, speaker, t0, t1) {
  const arr = index.byStart[speaker] || [];
  const from = lowerBound(arr, t0 - (index.maxDur[speaker] || 0), (b) => b.start);
  const out = [];
  for (let i = from; i < arr.length; i++) {
    const b = arr[i];
    if (b.start >= t1) break;
    if (blockEnd(b) > t0) out.push(b);
  }
  return out;
}

// 最初に start > t となる位置
function upperBoundStart(arr, t) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// 含有判定は start <= t < end。同話者の重なりは start最大（=最前面）を返す。
export function findBlockAt(index, speaker, t) {
  const arr = index.byStart[speaker] || [];
  const maxDur = index.maxDur[speaker] || 0;
  for (let i = upperBoundStart(arr, t) - 1; i >= 0; i--) {
    const b = arr[i];
    if (b.start <= t - maxDur) break; // これ以前は end <= start + maxDur <= t で含有不可能
    if (blockEnd(b) > t) return b;
  }
  return null;
}

// ── 被り検出（サーバ recompute_overlaps と完全同値のスイープ版） ──
// 同値条件: A×B・duration >= min_overlap_s（丸め前の生値で判定）・round(6)・
// (start, end) 安定ソート・block_ids は [A側, B側]。
//
// category（分類チップ）の扱い: 分類はサーバ導出（server._project_payload の
// classify_overlaps）で、ローカルスイープは座標しか計算できない。素の被りで
// 置き換えると一覧のチップが全て「不明」に退行するため、**同一ペア
// （block_ids）の旧被りから category を引き継ぐ**（Issue #20 実機FB）。
// 頭出し・ギャップ・削除などの編集後も残存ペアの分類が生き残る。編集で分類が
// 真に変わりうるケース（ブロック移動で相槌→解消可 等）は暫定値のまま表示し、
// 保存 echo（persistence.mergeServerEcho）がサーバの最新分類で上書き収束する。
// category を持たない被りには付けない（サーバ echo / ゴールデンと同形を保つ）。

export function recomputeOverlapsSweep(project) {
  const minOv = Number(project?.settings?.min_overlap_s ?? 0.3);
  const A = activeSorted(project?.blocks, "A");
  const B = activeSorted(project?.blocks, "B");
  const prevCategory = new Map(); // "aId|bId"（block_ids順そのまま）→ category
  for (const ov of project?.overlaps || []) {
    if (ov.category != null && Array.isArray(ov.block_ids) && ov.block_ids.length === 2) {
      prevCategory.set(`${ov.block_ids[0]}|${ov.block_ids[1]}`, ov.category);
    }
  }
  const out = [];
  let bLow = 0;
  for (const a of A) {
    const aStart = a.start;
    const aEnd = blockEnd(a);
    // 先頭連続部分のみ恒久スキップ: blockEnd(b) - a.start < minOv は以後の a でも成立し続ける
    while (bLow < B.length && blockEnd(B[bLow]) - aStart < minOv) bLow++;
    for (let j = bLow; j < B.length; j++) {
      const b = B[j];
      if (aEnd - b.start < minOv) break; // startは昇順なので以後 duration < minOv
      const start = Math.max(aStart, b.start);
      const end = Math.min(aEnd, blockEnd(b));
      const duration = end - start;
      if (duration >= minOv) {
        const row = {
          start: round6(start),
          end: round6(end),
          duration: round6(duration),
          block_ids: [a.id, b.id],
        };
        const category = prevCategory.get(`${a.id}|${b.id}`);
        if (category !== undefined) row.category = category;
        out.push(row);
      }
    }
  }
  out.sort((x, y) => x.start - y.start || x.end - y.end); // 安定ソート＝Python同順
  if (project) project.overlaps = out;
  return out;
}

// ── 文字起こし射影（timeline.py map_transcript_to_timeline / timeline_transcript_segments のJSミラー） ──
// 前提: 同話者ブロックのソース範囲は互いに素（VAD生成+splitの不変条件）。
// 出力は (start, end, speaker) 昇順の TimelineSegment[]（行キー = id + blockId）。
// 跨ぎセグメントのテキストは words（単語タイムスタンプ）を中点所属で断片に分配。
// words 無し（旧データ）は先頭断片にのみ全文（全行複製はしない）。

// Python " ".join(t.split()) と同値の空白正規化（ASCII/一般Unicode空白域で一致）
function normalizeSpace(text) {
  const parts = String(text).split(/\s+/u).filter((p) => p !== "");
  return parts.join(" ");
}

// timeline.py _word_fragment_index と同値必須。
// s <= m < e の断片。無ければ最近傍（同距離は先頭側）。frags は非空・ソース昇順。
function wordFragmentIndex(m, frags) {
  for (let i = 0; i < frags.length; i++) {
    if (frags[i].s <= m && m < frags[i].e) return i;
  }
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < frags.length; i++) {
    const { s, e } = frags[i];
    const dist = m < s ? s - m : m >= e ? m - e : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

// timeline.py _distribute_segment_text と同値必須。
// 各単語はちょうど1断片に割当（取りこぼし・二重割当なし）。
function distributeSegmentText(seg, frags) {
  const count = frags.length;
  if (count === 0) return [];
  const words = seg.words || [];
  if (count === 1 || words.length === 0) {
    const out = new Array(count).fill("");
    out[0] = seg.text;
    return out;
  }
  const parts = frags.map(() => []);
  for (const w of words) {
    const start = Number(w.start ?? 0);
    const end = w.end == null ? start : Number(w.end);
    parts[wordFragmentIndex((start + end) / 2, frags)].push(String(w.text ?? ""));
  }
  // 生 word は先頭空白を含みうる: 無区切り join 後に空白正規化（Python側と同一）
  return parts.map((p) => normalizeSpace(p.join("")));
}

let transcriptMemo = { project: null, version: -1, rows: null };

export function projectTimelineTranscripts(project, editVersion) {
  if (transcriptMemo.rows && transcriptMemo.project === project && transcriptMemo.version === editVersion) {
    return transcriptMemo.rows;
  }
  const index = getIndex(project, editVersion);
  const rows = [];
  for (const sp of SPEAKERS) {
    const blocks = index.bySource[sp];
    const segs = (project?.transcripts || []).filter((s) => s.speaker === sp);
    segs.sort((a, b) => a.source_start - b.source_start);
    let bi = 0; // 二点走査: セグメントのsource_startは昇順なので戻らない
    for (const seg of segs) {
      while (bi < blocks.length && blocks[bi].source_end <= seg.source_start) bi++;
      const frags = []; // bySource走査 = ソース昇順（Python側 frags.sort(s, e) と同順）
      for (let j = bi; j < blocks.length; j++) {
        const block = blocks[j];
        if (block.source_start >= seg.source_end) break;
        const s = Math.max(seg.source_start, block.source_start);
        const e = Math.min(seg.source_end, block.source_end);
        if (e <= s) continue;
        frags.push({ block, s, e });
      }
      const texts = distributeSegmentText(seg, frags);
      for (let k = 0; k < frags.length; k++) {
        const { block, s, e } = frags[k];
        rows.push({
          id: seg.id,
          speaker: sp,
          start: round6(block.start + (s - block.source_start)),
          end: round6(block.start + (e - block.source_start)),
          text: texts[k],
          blockId: block.id,
        });
      }
    }
  }
  rows.sort((x, y) => x.start - y.start || x.end - y.end || cmpStr(x.speaker, y.speaker));
  transcriptMemo = { project, version: editVersion, rows };
  return rows;
}

// ── ギャップ / スナップ / 分割ガード ──

// t を含む「指定した全話者にブロックが無い区間」。いずれかの話者のブロックが t を
// 含む場合と、後続ブロックが存在しない場合は null。
export function computeGapAt(index, t, speakers) {
  let gapStart = 0;
  let gapEnd = Infinity;
  for (const sp of speakers) {
    const arr = index.byStart[sp] || [];
    for (const b of arr) {
      const e = blockEnd(b);
      if (b.start <= t && t < e) return null; // ブロックが被っている
      if (e <= t) {
        if (e > gapStart) gapStart = e;
      } else if (b.start > t) {
        if (b.start < gapEnd) gapEnd = b.start;
        break; // start昇順なのでこの話者の後続はより遠い
      }
    }
  }
  if (!Number.isFinite(gapEnd) || gapEnd - gapStart <= 0) return null;
  return { gapStart: round6(gapStart), gapEnd: round6(gapEnd) };
}

// スナップ先: 同トラックブロック端 / playhead / 0。閾値 8px/pxPerSec 以内（両端とも判定）。
// スナップ後の start（number）か null を返す。
export function computeSnap(index, speaker, proposedStart, dur, pxPerSec, playheadT) {
  const threshold = 8 / pxPerSec;
  const targets = [0];
  if (playheadT != null && Number.isFinite(playheadT)) targets.push(playheadT);
  for (const b of index.byStart[speaker] || []) {
    targets.push(b.start, blockEnd(b));
  }
  const proposedEnd = proposedStart + dur;
  let best = null;
  let bestDist = Infinity;
  for (const target of targets) {
    let d = Math.abs(proposedStart - target);
    if (d <= threshold && d < bestDist && target >= 0) {
      best = target;
      bestDist = d;
    }
    d = Math.abs(proposedEnd - target);
    if (d <= threshold && d < bestDist && target - dur >= 0) {
      best = target - dur;
      bestDist = d;
    }
  }
  return best;
}

// 分割可否: 端から50ms以内（境界含む）は false。ブロック外・削除済みも false。
export function computePlayheadSplitGuard(block, at) {
  if (!block || block.deleted) return false;
  return at - block.start > SPLIT_GUARD_S && blockEnd(block) - at > SPLIT_GUARD_S;
}

// ── ミューテータ（project引数を直接変更。呼び出しは edits.commitEdit 経由のみ） ──
// 不変条件: split以外は source_start / source_end を一切変更しない。

function findBlock(project, blockId) {
  for (const b of project?.blocks || []) {
    if (b.id === blockId) return b;
  }
  return null;
}

export function moveBlock(project, blockId, newStart) {
  const block = findBlock(project, blockId);
  if (!block) return false;
  block.start = Math.max(0, round3(newStart));
  return true;
}

let splitSeq = 0; // セッション内連番（同msの連続分割でもID一意）

export function splitBlockAt(project, blockId, atTimeline) {
  const block = findBlock(project, blockId);
  if (!computePlayheadSplitGuard(block, atTimeline)) return null;
  const sourceSplit = round3(block.source_start + (atTimeline - block.start));
  const right = {
    ...block,
    id: `${block.id}-split-${Date.now().toString(36)}-${(splitSeq++).toString(36)}`,
    source_start: sourceSplit,
    start: round3(atTimeline),
    text: "",
    deleted: false,
  };
  block.source_end = sourceSplit;
  project.blocks.push(right); // 末尾追加。表示順は index が吸収する
  return right;
}

export function softDeleteBlock(project, blockId) {
  const block = findBlock(project, blockId);
  if (!block) return false;
  block.deleted = true;
  return true;
}

function selectedSpeakers(speakers) {
  if (speakers == null) return new Set(SPEAKERS);
  return new Set(speakers); // 空配列は no-op（対象話者ゼロ＝何もしない）
}

// start >= at の対象話者ブロックを +duration（旧 insertGapAt と同じ意味論）
export function insertGap(project, at, duration, speakers) {
  const selected = selectedSpeakers(speakers);
  for (const block of project?.blocks || []) {
    if (selected.has(block.speaker) && !block.deleted && block.start >= at) {
      block.start = round3(block.start + duration);
    }
  }
}

// start >= at + duration の対象話者ブロックを -duration（旧 deleteGapAt と同じ意味論）
export function deleteGap(project, at, duration, speakers) {
  const selected = selectedSpeakers(speakers);
  const end = at + duration;
  for (const block of project?.blocks || []) {
    if (selected.has(block.speaker) && !block.deleted && block.start >= end) {
      block.start = round3(block.start - duration);
    }
  }
}

// offset_seconds 更新 + 非削除の同話者全ブロックの start をシフト。
// クランプ: 最小 block.start + delta >= 0。実適用 delta を返す。
export function applyTrackOffsetMut(project, speaker, newOffsetSeconds) {
  const track = project?.tracks?.[speaker];
  if (!track) return 0;
  const oldOffset = Number(track.offset_seconds || 0);
  let delta = Number(newOffsetSeconds) - oldOffset;
  const own = [];
  for (const b of project.blocks || []) {
    if (b.speaker === speaker && !b.deleted) own.push(b);
  }
  if (own.length > 0) {
    let minStart = Infinity;
    for (const b of own) {
      if (b.start < minStart) minStart = b.start;
    }
    if (minStart + delta < 0) delta = -minStart;
  }
  delta = round6(delta);
  track.offset_seconds = round6(oldOffset + delta);
  for (const b of own) {
    b.start = round3(b.start + delta);
  }
  return delta;
}
