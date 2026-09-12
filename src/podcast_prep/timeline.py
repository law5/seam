from __future__ import annotations

import bisect
import copy
import itertools
import re
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import asdict, dataclass, replace
from typing import Any, NamedTuple

from .models import Block, Overlap, SPEAKERS, Speaker, TranscriptSegment, _float


class TimelineSegment(NamedTuple):
    id: str
    speaker: Speaker
    start: float
    end: float
    text: str
    block_id: str


EPS = 1e-6  # 秒。比較はすべて EPS 許容、最終 start のみ round(x, 6)（コードベース慣例）


class Gap(NamedTuple):
    start: float
    end: float
    duration: float
    next_block_id: str  # ギャップ直後（start == end）の先頭ブロックid。UIジャンプ用


@dataclass(slots=True)
class AutoEditAction:
    kind: str            # "resolve_overlap" | "skip_overlap" | "close_gap"
    start: float         # そのパス実行時点の座標での区間（被り区間 / ギャップ区間）
    end: float
    amount: float        # 挿入(+) / 除去(-) 秒数。skip_overlap は 0.0
    block_ids: list[str] # resolve/skip: [earlier.id, later.id] / close_gap: [next_block_id]
    reason: str = ""     # skip_overlap のみ: "contained" | "too_long" | "same_start"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class AutoEditResult:
    blocks: list[Block]
    actions: list[AutoEditAction]
    duration_before: float
    duration_after: float
    blocks_moved: int

    def summary(self) -> dict[str, Any]:
        closed = [a for a in self.actions if a.kind == "close_gap"]
        resolved = [a for a in self.actions if a.kind == "resolve_overlap"]
        skipped = [a for a in self.actions if a.kind == "skip_overlap"]
        return {
            "gaps_closed": len(closed),
            "overlaps_resolved": len(resolved),
            "overlaps_skipped": len(skipped),
            "skipped_reasons": {r: sum(1 for a in skipped if a.reason == r)
                                for r in ("contained", "too_long", "same_start")},
            "removed_s": round(-sum(a.amount for a in closed), 6),
            "inserted_s": round(sum(a.amount for a in resolved), 6),
            "blocks_moved": self.blocks_moved,
            "duration_before": round(self.duration_before, 6),
            "duration_after": round(self.duration_after, 6),
            "would_change": self.blocks_moved > 0,
        }


def clamp_seconds(value: float) -> float:
    return max(0.0, round(float(value), 6))


def active_blocks(blocks: Iterable[Block], speaker: Speaker | None = None) -> list[Block]:
    result = [b for b in blocks if not b.deleted and b.duration > 0]
    if speaker is not None:
        result = [b for b in result if b.speaker == speaker]
    return sorted(result, key=lambda b: (b.start, b.source_start, b.id))


def blocks_from_vad(
    speaker: Speaker,
    intervals: Sequence[tuple[float, float]],
    offset_seconds: float = 0.0,
    min_duration: float = 0.12,
    id_prefix: str | None = None,
) -> list[Block]:
    prefix = id_prefix or speaker.lower()
    blocks: list[Block] = []
    counter = itertools.count(1)
    for start, end in intervals:
        source_start = clamp_seconds(start)
        source_end = clamp_seconds(end)
        if source_end - source_start < min_duration:
            continue
        idx = next(counter)
        blocks.append(
            Block(
                id=f"{prefix}-{idx:05d}",
                speaker=speaker,
                source_start=source_start,
                source_end=source_end,
                start=round(source_start + float(offset_seconds), 6),
            )
        )
    return blocks


def timeline_end(blocks: Sequence[Block]) -> float:
    """アクティブブロックの end の最大値。無ければ 0.0。"""
    return max((b.end for b in active_blocks(blocks)), default=0.0)


def _iter_cross_overlaps(blocks: Sequence[Block]) -> Iterator[tuple[Block, Block, float, float]]:
    """(earlier, later, ov_start, ov_end) を later.start 昇順で1回ずつ yield。
    earlier/later は active_blocks のソート順で先着/後着。ov_start = later.start。
    open-list 方式: 同一話者内に重なりがあっても全ペアを漏らさない
    （二点走査は話者内 disjoint 前提が要るため不採用）。O(n log n + n + K)。"""
    open_by: dict[Speaker, list[Block]] = {"A": [], "B": []}
    for block in active_blocks(blocks):
        other: Speaker = "B" if block.speaker == "A" else "A"
        alive: list[Block] = []
        for cand in open_by[other]:
            if cand.end <= block.start + EPS:
                continue                      # 終了済み → open list から除去（各ブロック除去は1回）
            alive.append(cand)
            yield (cand, block, block.start, min(cand.end, block.end))
        open_by[other] = alive
        open_by[block.speaker].append(block)


def recompute_overlaps(blocks: Sequence[Block], min_duration: float = 0.3) -> list[Overlap]:
    """A×B 交差のスイープ検出。min_duration > 0 を前提とする
    （交差長 <= EPS の接触ペアは列挙されないため）。

    旧 `previous` 引数（block_ids ペア一致で Overlap.resolved を引き継ぐ機構）は
    resolved フィールドの削除に伴い撤去した。resolved を true にする経路は
    元々コード上に存在せず、引き継ぐ状態が無かった。"""
    overlaps: list[Overlap] = []
    for earlier, later, ov_start, ov_end in _iter_cross_overlaps(blocks):
        duration = ov_end - ov_start
        if duration >= min_duration:
            a_id, b_id = (earlier.id, later.id) if earlier.speaker == "A" else (later.id, earlier.id)
            overlaps.append(Overlap(
                start=round(ov_start, 6), end=round(ov_end, 6), duration=round(duration, 6),
                block_ids=[a_id, b_id],
            ))
    return sorted(overlaps, key=lambda item: (item.start, item.end))


def clone_blocks(blocks: Sequence[Block]) -> list[Block]:
    return [copy.copy(block) for block in blocks]


def replace_block(blocks: Sequence[Block], replacement: Block) -> list[Block]:
    found = False
    output: list[Block] = []
    for block in blocks:
        if block.id == replacement.id:
            output.append(replacement)
            found = True
        else:
            output.append(copy.copy(block))
    if not found:
        raise ValueError(f"block not found: {replacement.id}")
    return output


def move_block(blocks: Sequence[Block], block_id: str, new_start: float) -> list[Block]:
    output = clone_blocks(blocks)
    for idx, block in enumerate(output):
        if block.id == block_id:
            output[idx] = replace(block, start=round(float(new_start), 6))
            return output
    raise ValueError(f"block not found: {block_id}")


def delete_block(blocks: Sequence[Block], block_id: str) -> list[Block]:
    output = clone_blocks(blocks)
    for idx, block in enumerate(output):
        if block.id == block_id:
            output[idx] = replace(block, deleted=True)
            return output
    raise ValueError(f"block not found: {block_id}")


def insert_gap(
    blocks: Sequence[Block],
    at_seconds: float,
    duration_seconds: float,
    speakers: set[Speaker] | None = None,
) -> list[Block]:
    if duration_seconds < 0:
        raise ValueError("gap duration must be positive")
    selected = speakers or set(SPEAKERS)
    output: list[Block] = []
    for block in blocks:
        if block.speaker in selected and not block.deleted and block.start >= at_seconds:
            output.append(replace(block, start=round(block.start + duration_seconds, 6)))
        else:
            output.append(copy.copy(block))
    return output


def delete_gap(
    blocks: Sequence[Block],
    gap_start: float,
    gap_end: float,
    speakers: set[Speaker] | None = None,
) -> list[Block]:
    if gap_end <= gap_start:
        raise ValueError("gap end must be greater than gap start")
    duration = gap_end - gap_start
    selected = speakers or set(SPEAKERS)
    output: list[Block] = []
    for block in blocks:
        if block.speaker in selected and not block.deleted and block.start >= gap_end:
            output.append(replace(block, start=round(block.start - duration, 6)))
        else:
            output.append(copy.copy(block))
    return output


def detect_silence_gaps(blocks: Sequence[Block], min_gap_s: float = 0.0) -> list[Gap]:
    """長さ > min_gap_s（strict、EPS 許容）の無音ギャップを昇順で返す。
    t=0 被覆起点。末尾はギャップにしない。O(n log n)。"""
    gaps: list[Gap] = []
    cursor = 0.0
    for b in active_blocks(blocks):
        if b.start - cursor > min_gap_s + EPS:
            gaps.append(Gap(round(cursor, 6), round(b.start, 6),
                            round(b.start - cursor, 6), b.id))
        cursor = max(cursor, b.end)   # 内包ブロックでも被覆右端を正しく維持
    return gaps


def close_gaps(
    blocks: Sequence[Block],
    *,
    max_gap_s: float,
    keep_gap_s: float,
) -> tuple[list[Block], list[AutoEditAction]]:
    """長さ > max_gap_s のギャップを keep_gap_s だけ残して左詰め。非破壊。
    意味論: ギャップを時刻降順に delete_gap(gap_start + keep_gap_s, gap_end) を
    適用したのと厳密等価（性質テストで固定）。実装は prefix-sum + bisect の1パス。"""
    if keep_gap_s < 0 or max_gap_s < 0:
        raise ValueError("gap thresholds must be >= 0")
    if keep_gap_s > max_gap_s:
        raise ValueError("keep_gap_s must be <= max_gap_s")   # 冪等性の条件
    gaps = detect_silence_gaps(blocks, min_gap_s=max_gap_s)
    cuts = [(g.end, g.duration - keep_gap_s, g) for g in gaps if g.duration - keep_gap_s > EPS]
    if not cuts:
        return clone_blocks(blocks), []
    ends = [c[0] for c in cuts]
    prefix = list(itertools.accumulate(c[1] for c in cuts))
    output: list[Block] = []
    for block in blocks:                                  # 入力リスト順を保存
        if block.deleted:                                 # delete_gap と同じ述語: tombstone は不動
            output.append(copy.copy(block))
            continue
        idx = bisect.bisect_right(ends, block.start + EPS)  # gap_end <= start（EPS許容）
        shift = prefix[idx - 1] if idx else 0.0
        output.append(replace(block, start=round(block.start - shift, 6)) if shift else copy.copy(block))
    actions = [AutoEditAction("close_gap", g.start, g.end, round(-(g.duration - keep_gap_s), 6),
                              [g.next_block_id]) for (_, _, g) in cuts]
    return output, actions


def _classify_overlap(
    *,
    earlier_start: float,
    later_start: float,
    cur_e_end: float,
    cur_l_start: float,
    cur_l_end: float,
    max_overlap_s: float,
) -> str:
    """被り1件の分類。resolve_overlaps と classify_overlaps の**唯一の**判定式。

    座標は「そのパス実行時点」で渡す（resolve_overlaps は先行カットのシフトを
    反映した現在座標、classify_overlaps はカット無しの元座標）。判定順序も
    resolve_overlaps の逐次評価と同一に保つこと。
    戻り値: "resolvable" | "contained" | "too_long" | "same_start"
    """
    if later_start - earlier_start <= EPS:
        return "same_start"
    if cur_l_end <= cur_e_end + EPS:
        return "contained"
    if cur_e_end - cur_l_start > max_overlap_s + EPS:   # tail型の現在交差長
        return "too_long"
    return "resolvable"


def classify_overlaps(
    blocks: Sequence[Block],
    *,
    min_overlap_s: float,
    max_overlap_s: float,
) -> list[dict[str, Any]]:
    """被り一覧を常時表示するための分類（UI チップ用）。非破壊・純関数。

    resolve_overlaps を実行せずに「自動解消できるか」を先出しするための関数。
    判定は `_classify_overlap` を共有するので分類ロジックの重複実装はない。

    ただし **カット無しの元座標で評価する**点が resolve_overlaps と異なる。
    resolve_overlaps は先行カットのシフトを反映した現在座標で再評価するため、
    同話者内に重なりのある病的データでは結果がズレうる。ズレの向きは
    必ず「より解消される側」で、UI のチップが嘘をつく逆向き
    （= 自動解消可と表示したのに実行時 skip される）は起きない:
      - resolvable → 実行時 resolve、または先行カットで解消済み
        （delta <= EPS のサイレント収束。被りは実際に消えるので表示と矛盾しない）
      - contained  → 実行時 contained / tail 化して resolve / サイレント収束
      - too_long / same_start → 座標シフトで変わらないので実行時も同じ
    クリーンデータ（同話者内に重なりなし）では両者は完全一致する。
    この不変条件は tests/test_auto_tighten.py の性質テストで固定している。

    返り値の各要素: {block_ids: [a_id, b_id], start, end, duration, category}
    block_ids は recompute_overlaps と同じ [A話者, B話者] 順。
    """
    if max_overlap_s < min_overlap_s:
        raise ValueError("max_overlap_s must be >= min_overlap_s")
    rows: list[dict[str, Any]] = []
    for earlier, later, ov_start, ov_end in _iter_cross_overlaps(blocks):
        if ov_end - ov_start < min_overlap_s:
            continue
        category = _classify_overlap(
            earlier_start=earlier.start,
            later_start=later.start,
            cur_e_end=earlier.end,
            cur_l_start=later.start,
            cur_l_end=later.end,
            max_overlap_s=max_overlap_s,
        )
        a_id, b_id = (earlier.id, later.id) if earlier.speaker == "A" else (later.id, earlier.id)
        rows.append({
            "block_ids": [a_id, b_id],
            "start": round(ov_start, 6),
            "end": round(ov_end, 6),
            "duration": round(ov_end - ov_start, 6),
            "category": category,
        })
    return sorted(rows, key=lambda item: (item["start"], item["end"]))


def resolve_overlaps(
    blocks: Sequence[Block],
    *,
    min_overlap_s: float,
    max_overlap_s: float,
    keep_overlap_s: float = 0.0,
    target_pairs: set[frozenset[str]] | None = None,
) -> tuple[list[Block], list[AutoEditAction]]:
    """tail 型の被りを解消: later を earlier.end - keep_overlap_s に着地させ、
    カット点以降の両話者全ブロックを等量右シフト（insert_gap と同じ意味論）。
    contained / too_long / same_start は理由つき skip。
    前提: 同話者内は重なりなし（クリーンデータ）。病的データ（deleteGapAt 起因の
    同話者重なり）でも source 座標は不変で収束するが、1回の実行での完全解消は
    保証しない（残数は recompute_overlaps が正直に報告する）。

    target_pairs: None なら全被りが対象（既定・現行動作）。集合を渡すと
    **その block_ids ペア（frozenset）に一致する被りだけ**を処理し、対象外は
    分類に関わらず完全に無視する（skip アクションも出さない = 一覧に出さない）。
    空集合は「1件も対象にしない」= 完全 no-op。存在しないペアの指定は自然に無視。
    ペアは recompute_overlaps / classify_overlaps と同じ block_ids で表す
    （frozenset なので A/B の順序は問わない）。"""
    if keep_overlap_s < 0:
        raise ValueError("keep_overlap_s must be >= 0")
    if keep_overlap_s >= min_overlap_s:
        raise ValueError("keep_overlap_s must be < min_overlap_s")   # 冪等性の条件
    if max_overlap_s < min_overlap_s:
        raise ValueError("max_overlap_s must be >= min_overlap_s")

    cut_pos: list[float] = []     # 挿入点（元座標）。列挙順により非減少 → bisect 可
    cut_pre: list[float] = [0.0]  # delta の prefix-sum（先頭に番兵 0.0）

    def inserted_before(x: float) -> float:
        return cut_pre[bisect.bisect_right(cut_pos, x + EPS)]   # 位置 <= x のカットの delta 合計

    actions: list[AutoEditAction] = []
    for earlier, later, ov_start, ov_end in _iter_cross_overlaps(blocks):
        if ov_end - ov_start < min_overlap_s:
            continue
        if target_pairs is not None and frozenset((earlier.id, later.id)) not in target_pairs:
            continue          # 選択外（D）: 分類に関わらず触らない・アクションも出さない
        # 現在座標で再評価: 連鎖・同話者重なりデータで過剰シフトしない（性質6）
        cur_e_end = earlier.end + inserted_before(earlier.start)   # ブロックは剛体移動
        cur_l_start = later.start + inserted_before(later.start)
        cur_l_end = later.end + inserted_before(later.start)
        category = _classify_overlap(
            earlier_start=earlier.start,
            later_start=later.start,
            cur_e_end=cur_e_end,
            cur_l_start=cur_l_start,
            cur_l_end=cur_l_end,
            max_overlap_s=max_overlap_s,
        )
        if category != "resolvable":
            actions.append(AutoEditAction("skip_overlap", round(ov_start, 6), round(ov_end, 6),
                                          0.0, [earlier.id, later.id], category))
            continue
        delta = cur_e_end - keep_overlap_s - cur_l_start
        if delta <= EPS:
            continue        # 先行カットの副作用で解消済み。アクションなし（サイレント収束）
        cut_pos.append(later.start)
        cut_pre.append(cut_pre[-1] + delta)
        actions.append(AutoEditAction("resolve_overlap", round(ov_start, 6), round(ov_end, 6),
                                      round(delta, 6), [earlier.id, later.id]))
    if len(cut_pre) == 1:
        return clone_blocks(blocks), actions
    output: list[Block] = []
    for block in blocks:
        if block.deleted:
            output.append(copy.copy(block))
            continue
        shift = inserted_before(block.start)      # insert_gap の start >= at と同じ述語（EPS許容）
        output.append(replace(block, start=round(block.start + shift, 6)) if shift > 0 else copy.copy(block))
    return output, actions


def auto_tighten(
    blocks: Sequence[Block],
    *,
    tighten_overlaps: bool = True,   # チェックボックス「被りを解消」
    tighten_gaps: bool = True,       # チェックボックス「無音を詰める」
    max_gap_s: float = 1.5,
    keep_gap_s: float = 0.5,
    min_overlap_s: float = 0.3,
    max_overlap_s: float = 3.0,
    keep_overlap_s: float = 0.0,
    target_pairs: set[frozenset[str]] | None = None,
) -> AutoEditResult:
    """自動編集オーケストレータ。順序 = 被り解消 → 無音詰め で固定
    （解消は新規ギャップを作らず、詰めは新規被りを作らないので1回実行が不動点）。

    target_pairs は被り解消パスにのみ効く（無音詰めは選択の対象外）。
    None = 全件（現行動作）。詳細は resolve_overlaps を参照。"""
    before = timeline_end(blocks)
    current: Sequence[Block] = blocks
    actions: list[AutoEditAction] = []
    if tighten_overlaps:
        current, acts = resolve_overlaps(current, min_overlap_s=min_overlap_s,
                                         max_overlap_s=max_overlap_s, keep_overlap_s=keep_overlap_s,
                                         target_pairs=target_pairs)
        actions += acts
    if tighten_gaps:
        current, acts = close_gaps(current, max_gap_s=max_gap_s, keep_gap_s=keep_gap_s)
        actions += acts
    if current is blocks:
        current = clone_blocks(blocks)            # 両方OFFでも非破壊契約を守る
    moved = sum(1 for old, new in zip(blocks, current) if old.start != new.start)
    return AutoEditResult(list(current), actions, before, timeline_end(current), moved)


def split_block_at(blocks: Sequence[Block], block_id: str, at_seconds: float) -> list[Block]:
    output: list[Block] = []
    did_split = False
    for block in blocks:
        if block.id != block_id:
            output.append(copy.copy(block))
            continue
        if block.deleted:
            raise ValueError("cannot split a deleted block")
        if not (block.start < at_seconds < block.end):
            raise ValueError("split point must be inside the block")
        left_duration = at_seconds - block.start
        source_split = block.source_start + left_duration
        left = replace(
            block,
            source_end=round(source_split, 6),
        )
        right = Block(
            id=f"{block.id}-split",
            speaker=block.speaker,
            source_start=round(source_split, 6),
            source_end=block.source_end,
            start=round(at_seconds, 6),
            text="",
            deleted=False,
        )
        output.extend([left, right])
        did_split = True
    if not did_split:
        raise ValueError(f"block not found: {block_id}")
    return output


def link_transcripts_to_blocks(
    blocks: Sequence[Block],
    transcripts: Sequence[TranscriptSegment],
) -> list[TranscriptSegment]:
    linked: list[TranscriptSegment] = []
    by_speaker = {speaker: active_blocks(blocks, speaker) for speaker in SPEAKERS}
    for segment in transcripts:
        best_block: Block | None = None
        best_overlap = 0.0
        for block in by_speaker[segment.speaker]:
            overlap = max(
                0.0,
                min(segment.source_end, block.source_end)
                - max(segment.source_start, block.source_start),
            )
            if overlap > best_overlap:
                best_overlap = overlap
                best_block = block
        linked.append(replace(segment, block_id=best_block.id if best_block else None))
    return linked


def _word_fragment_index(midpoint: float, frags: Sequence[tuple[Block, float, float]]) -> int:
    """単語中点が入る交差断片の index（s <= m < e）。どの断片にも入らなければ
    最近傍断片（同距離は先頭側）。frags は非空・ソース昇順前提。
    JSミラー: timelineModel.js wordFragmentIndex と同値必須。"""
    for i, (_, s, e) in enumerate(frags):
        if s <= midpoint < e:
            return i
    best = 0
    best_dist: float | None = None
    for i, (_, s, e) in enumerate(frags):
        dist = s - midpoint if midpoint < s else (midpoint - e if midpoint >= e else 0.0)
        if best_dist is None or dist < best_dist:
            best = i
            best_dist = dist
    return best


def _distribute_segment_text(
    segment: TranscriptSegment, frags: Sequence[tuple[Block, float, float]]
) -> list[str]:
    """交差断片ごとの表示テキスト。words があれば各単語を中点所属の断片へ分配
    （各単語はちょうど1断片に入る: 取りこぼし・二重割当なし）。words 無し（旧データ）
    と断片1つの場合は先頭断片に全文・残りは空文字（全行複製はしない）。
    JSミラー: timelineModel.js distributeSegmentText と同値必須。"""
    count = len(frags)
    if count == 0:
        return []
    if count == 1 or not segment.words:
        return [segment.text] + [""] * (count - 1)
    parts: list[list[str]] = [[] for _ in range(count)]
    for word in segment.words:
        start = _float(word.get("start"))
        end = _float(word.get("end"), start)
        idx = _word_fragment_index((start + end) / 2, frags)
        parts[idx].append(str(word.get("text", "")))
    # 生 word は先頭空白を含みうる: 無区切り join 後に空白正規化（Whisper互換）
    return [" ".join("".join(p).split()) for p in parts]


def map_transcript_to_timeline(
    blocks: Sequence[Block],
    segment: TranscriptSegment,
) -> list[TimelineSegment]:
    candidates = active_blocks(blocks, segment.speaker)
    frags: list[tuple[Block, float, float]] = []
    for block in candidates:
        source_start = max(segment.source_start, block.source_start)
        source_end = min(segment.source_end, block.source_end)
        if source_end <= source_start:
            continue
        frags.append((block, source_start, source_end))
    # words 分配はソース座標順が基準（同話者ブロックのソース範囲は互いに素な前提）
    frags.sort(key=lambda item: (item[1], item[2]))
    texts = _distribute_segment_text(segment, frags)
    mapped = [
        TimelineSegment(
            id=segment.id,
            speaker=segment.speaker,
            start=round(block.start + (s - block.source_start), 6),
            end=round(block.start + (e - block.source_start), 6),
            text=text,
            block_id=block.id,
        )
        for (block, s, e), text in zip(frags, texts)
    ]
    return sorted(mapped, key=lambda item: (item.start, item.end))


def timeline_transcript_segments(
    blocks: Sequence[Block],
    transcripts: Sequence[TranscriptSegment],
) -> list[TimelineSegment]:
    output: list[TimelineSegment] = []
    for segment in transcripts:
        output.extend(map_transcript_to_timeline(blocks, segment))
    return sorted(output, key=lambda item: (item.start, item.end, item.speaker))


def searchable_block_text(blocks: Sequence[Block], transcripts: Sequence[TranscriptSegment]) -> list[Block]:
    snippets: dict[str, str] = {}
    for segment in transcripts:
        if segment.words:
            # words があればブロック単位に分配したテキストを転記する
            # （跨ぎセグメントでも各ブロックには自分の単語だけが載る）。
            # テキスト分配はソース座標のみに依存するため timeline 射影を再利用できる
            for row in map_transcript_to_timeline(blocks, segment):
                if row.text and row.block_id not in snippets:
                    snippets[row.block_id] = row.text.strip()[:80]
        elif segment.block_id and segment.text and segment.block_id not in snippets:
            # 旧データ（words無し）は従来どおり最大交差ブロックに全文
            snippets[segment.block_id] = segment.text.strip()[:80]
    return [replace(block, text=snippets.get(block.id, block.text)) for block in blocks]


def seconds_to_srt_time(seconds: float) -> str:
    total_ms = max(0, int(round(seconds * 1000)))
    ms = total_ms % 1000
    total_s = total_ms // 1000
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def segments_to_srt(segments: Sequence[TimelineSegment]) -> str:
    lines: list[str] = []
    idx = 0
    for segment in segments:
        text = re.sub(r"\s+", " ", segment.text.strip())
        if not text:
            # words分配で単語が割り当たらなかった断片・words無しフォールバックの
            # 継続行（空文字）は字幕にしない（番号は詰める）
            continue
        idx += 1
        lines.extend(
            [
                str(idx),
                f"{seconds_to_srt_time(segment.start)} --> {seconds_to_srt_time(segment.end)}",
                f"{segment.speaker}: {text}",
                "",
            ]
        )
    return "\n".join(lines)
