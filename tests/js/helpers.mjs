// tests/js 共通ヘルパ（テストファイルではない）
import { readFileSync } from "node:fs";

export function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

// 決定的PRNG（プロパティテスト用）
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeBlock(id, speaker, sourceStart, sourceEnd, start, extra = {}) {
  return {
    id,
    speaker,
    source_start: sourceStart,
    source_end: sourceEnd,
    start,
    text: "",
    deleted: false,
    ...extra,
  };
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// recompute_overlaps のナイーブ O(A×B) リファレンス実装（sweep のプロパティテスト対象）
export function naiveOverlaps(blocks, minOv) {
  const act = (sp) =>
    blocks
      .filter((b) => !b.deleted && b.source_end - b.source_start > 0 && b.speaker === sp)
      .sort(
        (a, b) =>
          a.start - b.start || a.source_start - b.source_start || cmpStr(a.id, b.id),
      );
  const out = [];
  for (const a of act("A")) {
    const aEnd = a.start + (a.source_end - a.source_start);
    for (const b of act("B")) {
      const bEnd = b.start + (b.source_end - b.source_start);
      const start = Math.max(a.start, b.start);
      const end = Math.min(aEnd, bEnd);
      const duration = end - start;
      if (duration >= minOv) {
        out.push({
          start: r6(start),
          end: r6(end),
          duration: r6(duration),
          block_ids: [a.id, b.id],
        });
      }
    }
  }
  return out.sort((x, y) => x.start - y.start || x.end - y.end);
}

// ランダムプロジェクト生成（タイ・接触境界を意図的に多発させる）
export function randomProject(rand, nPerSpeaker, { minOverlapS = 0.3, quantize = false } = {}) {
  const blocks = [];
  for (const [speaker, prefix] of [["A", "a"], ["B", "b"]]) {
    let src = 0;
    for (let i = 0; i < nPerSpeaker; i++) {
      src += 0.05 + rand() * 2.5;
      const dur = 0.15 + rand() * 5;
      const sourceStart = Math.round(src * 1000) / 1000;
      const sourceEnd = Math.round((src + dur) * 1000) / 1000;
      let start = Math.max(0, sourceStart + (rand() - 0.5) * 8);
      start = quantize
        ? Math.round(start * 2) / 2 // 0.5刻み → start同値・接触が多発
        : Math.round(start * 1000) / 1000;
      const deleted = rand() < 0.1;
      const zeroDur = rand() < 0.03;
      blocks.push(
        makeBlock(`${prefix}-${String(i).padStart(5, "0")}`, speaker, sourceStart, zeroDur ? sourceStart : sourceEnd, start, { deleted }),
      );
      src += dur;
    }
  }
  return { blocks, transcripts: [], overlaps: [], settings: { min_overlap_s: minOverlapS } };
}
