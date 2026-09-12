"""auto-tighten（自動編集エンジン）の純ユニットテスト。

既存 test_timeline.py のスタイル
（純ユニット・fixture 最小）を踏襲。乱数は全て固定シードの ms 粒度
（EPS=1e-6 より十分粗いため、round(,6) スナップにより逐次適用の基準器
（delete_gap / insert_gap 畳み込み）との厳密一致が成立する）。
"""

from __future__ import annotations

import random
import time
from pathlib import Path

import pytest

from podcast_prep import exporter
from podcast_prep.models import Block, Overlap, ProjectState, TranscriptSegment
from podcast_prep.timeline import (
    EPS,
    active_blocks,
    auto_tighten,
    classify_overlaps,
    clone_blocks,
    close_gaps,
    delete_gap,
    detect_silence_gaps,
    insert_gap,
    map_transcript_to_timeline,
    recompute_overlaps,
    resolve_overlaps,
    timeline_end,
)


def _blk(bid, speaker, start, dur, *, src=None, deleted=False, text=""):
    src_start = src if src is not None else start
    return Block(
        id=bid,
        speaker=speaker,
        source_start=src_start,
        source_end=src_start + dur,
        start=start,
        text=text,
        deleted=deleted,
    )


def _key(b):
    return (b.id, b.speaker, b.source_start, b.source_end, b.start, b.text, b.deleted)


def _snapshot(blocks):
    return [_key(b) for b in blocks]


def _random_blocks(rng, n, *, pathological=False):
    """ms 粒度の合成ブロック列。pathological=True で同話者重なり・内包・接触・
    zero-duration・deleted を混ぜる（フロント deleteGapAt 起因の病的データ相当）。
    クリーンモードでは同話者内の重なりは構造的に発生しない。"""
    blocks = []
    cursor_ms = {"A": 0, "B": 0}
    for i in range(n):
        speaker = "A" if rng.random() < 0.5 else "B"
        if pathological and rng.random() < 0.2:
            start_ms = max(0, cursor_ms[speaker] - rng.randint(0, 3000))
        else:
            start_ms = cursor_ms[speaker] + rng.choice([0, 100, 400, 900, 2500, 5000])
        dur_ms = 0 if (pathological and rng.random() < 0.06) else rng.randint(200, 4000)
        src_ms = rng.randint(0, 10_000_000)
        blocks.append(
            Block(
                id=f"r{i:05d}",
                speaker=speaker,
                source_start=src_ms / 1000.0,
                source_end=(src_ms + dur_ms) / 1000.0,
                start=start_ms / 1000.0,
                deleted=bool(pathological and rng.random() < 0.05),
            )
        )
        cursor_ms[speaker] = max(cursor_ms[speaker], start_ms + dur_ms)
    return blocks


def _naive_overlaps(blocks, min_duration=0.3):
    """旧 O(A×B) 総当たり実装（スイープ化の等価性検証の基準器）。"""
    a_blocks = active_blocks(blocks, "A")
    b_blocks = active_blocks(blocks, "B")
    overlaps = []
    for block_a in a_blocks:
        for block_b in b_blocks:
            start = max(block_a.start, block_b.start)
            end = min(block_a.end, block_b.end)
            duration = end - start
            if duration >= min_duration:
                overlaps.append(
                    Overlap(
                        start=round(start, 6),
                        end=round(end, 6),
                        duration=round(duration, 6),
                        block_ids=[block_a.id, block_b.id],
                    )
                )
    return sorted(overlaps, key=lambda item: (item.start, item.end))


# ---------------------------------------------------------------- §7-1 detect_silence_gaps


def test_detect_silence_gaps_finds_leading_and_middle_gaps_not_tail():
    blocks = [
        _blk("a1", "A", 2.0, 2.0),  # [2, 4]
        _blk("b1", "B", 3.0, 3.0),  # [3, 6]
        _blk("a2", "A", 8.0, 1.0),  # [8, 9] → 末尾 9.0 以降はギャップにしない
    ]
    gaps = detect_silence_gaps(blocks)
    assert [(g.start, g.end, g.duration, g.next_block_id) for g in gaps] == [
        (0.0, 2.0, 2.0, "a1"),  # 先頭無音 [0, first_start)
        (6.0, 8.0, 2.0, "a2"),
    ]


def test_detect_silence_gaps_requires_both_speakers_silent():
    blocks = [
        _blk("a1", "A", 0.0, 10.0),  # A が喋りっぱなし
        _blk("b1", "B", 1.0, 1.0),
        _blk("b2", "B", 7.0, 1.0),
    ]
    assert detect_silence_gaps(blocks) == []


def test_detect_silence_gaps_threshold_is_strict():
    blocks = [_blk("a1", "A", 0.0, 1.0), _blk("a2", "A", 2.5, 1.0)]  # gap = 1.5
    assert detect_silence_gaps(blocks, min_gap_s=1.5) == []  # ちょうどは触らない
    assert len(detect_silence_gaps(blocks, min_gap_s=1.4)) == 1


def test_detect_silence_gaps_ignores_deleted_and_zero_duration():
    blocks = [
        _blk("a1", "A", 0.0, 1.0),
        _blk("x1", "A", 1.5, 2.0, deleted=True),  # tombstone は被覆に寄与しない
        _blk("z1", "B", 2.0, 0.0),  # zero-duration も無視
        _blk("a2", "A", 5.0, 1.0),
    ]
    gaps = detect_silence_gaps(blocks)
    assert [(g.start, g.end) for g in gaps] == [(1.0, 5.0)]


def test_detect_silence_gaps_contained_block_keeps_coverage_cursor():
    blocks = [
        _blk("a1", "A", 0.0, 10.0),
        _blk("b1", "B", 2.0, 1.0),  # 内包: 被覆右端は 10.0 のまま
        _blk("a2", "A", 12.0, 1.0),
    ]
    gaps = detect_silence_gaps(blocks)
    assert [(g.start, g.end) for g in gaps] == [(10.0, 12.0)]


def test_detect_silence_gaps_empty_list_returns_empty():
    assert detect_silence_gaps([]) == []


def test_detect_silence_gaps_negative_start_blocks_never_yield_negative_gaps():
    # 全体が負のブロック: 被覆に寄与しない → 先頭ギャップは [0, 1)
    blocks = [_blk("a0", "A", -5.0, 2.0), _blk("a1", "A", 1.0, 1.0)]
    gaps = detect_silence_gaps(blocks)
    assert [(g.start, g.end) for g in gaps] == [(0.0, 1.0)]
    # t=0 を跨ぐブロック: 被覆は end まで、ギャップ start は end から
    blocks = [_blk("a0", "A", -2.0, 5.0), _blk("a1", "A", 6.0, 1.0)]  # [-2, 3] と [6, 7]
    gaps = detect_silence_gaps(blocks)
    assert [(g.start, g.end) for g in gaps] == [(3.0, 6.0)]
    assert all(g.start >= 0 for g in gaps)


# ---------------------------------------------------------------- §7-2 close_gaps


def test_close_gaps_shrinks_single_gap_to_keep():
    blocks = [_blk("a1", "A", 0.0, 1.0), _blk("a2", "A", 3.0, 1.0)]  # gap [1, 3]
    result, actions = close_gaps(blocks, max_gap_s=1.0, keep_gap_s=0.25)
    assert [b.start for b in result] == [0.0, 1.25]
    assert len(actions) == 1
    act = actions[0]
    assert (act.kind, act.start, act.end, act.amount, act.block_ids, act.reason) == (
        "close_gap", 1.0, 3.0, -1.75, ["a2"], "",
    )


def test_close_gaps_leaves_small_gaps_untouched_and_returns_clones():
    blocks = [_blk("a1", "A", 0.0, 1.0), _blk("a2", "A", 2.0, 1.0)]  # gap = 1.0
    result, actions = close_gaps(blocks, max_gap_s=1.5, keep_gap_s=0.5)
    assert actions == []
    assert [b.start for b in result] == [0.0, 2.0]
    assert all(new is not old for old, new in zip(blocks, result))  # 非破壊クローン


def test_close_gaps_accumulates_multiple_gap_shifts():
    blocks = [
        _blk("a1", "A", 0.0, 1.0),
        _blk("b1", "B", 0.5, 1.0),  # 被覆 [0, 1.5]
        _blk("a2", "A", 4.0, 1.0),  # gap1 [1.5, 4] = 2.5 → cut 2.0
        _blk("b2", "B", 7.0, 1.0),  # gap2 [5, 7]   = 2.0 → cut 1.5
    ]
    result, actions = close_gaps(blocks, max_gap_s=1.0, keep_gap_s=0.5)
    assert [b.start for b in result] == [0.0, 0.5, 2.0, 3.5]
    assert [(a.start, a.end, a.amount, a.block_ids) for a in actions] == [
        (1.5, 4.0, -2.0, ["a2"]),
        (5.0, 7.0, -1.5, ["b2"]),
    ]


def test_close_gaps_matches_delete_gap_fold():
    # 等価性（性質テスト）: 時刻降順に delete_gap(gap_start+keep, gap_end) を
    # 畳み込んだ結果（基準器 = 既存関数）と全フィールド厳密一致
    rng = random.Random(20260731)
    for pathological in (False, True):
        blocks = _random_blocks(rng, 300, pathological=pathological)
        max_gap_s, keep_gap_s = 1.5, 0.5
        result, actions = close_gaps(blocks, max_gap_s=max_gap_s, keep_gap_s=keep_gap_s)
        folded = blocks
        for g in reversed(detect_silence_gaps(blocks, min_gap_s=max_gap_s)):
            if g.duration - keep_gap_s > EPS:
                folded = delete_gap(folded, g.start + keep_gap_s, g.end)
        assert _snapshot(result) == _snapshot(folded)
        assert actions  # 詰め対象が存在するデータであること（テストの空振り防止）


def test_close_gaps_is_non_destructive_and_creates_no_new_overlaps():
    rng = random.Random(42)
    blocks = _random_blocks(rng, 400, pathological=True)
    before_snapshot = _snapshot(blocks)
    before_count = len(recompute_overlaps(blocks))
    result, _ = close_gaps(blocks, max_gap_s=1.5, keep_gap_s=0.5)
    assert _snapshot(blocks) == before_snapshot  # 入力不変
    assert len(recompute_overlaps(result)) == before_count  # 新規被り非生成


def test_close_gaps_rejects_bad_thresholds():
    blocks = [_blk("a1", "A", 0.0, 1.0)]
    with pytest.raises(ValueError):
        close_gaps(blocks, max_gap_s=1.0, keep_gap_s=1.5)  # keep > max
    with pytest.raises(ValueError):
        close_gaps(blocks, max_gap_s=-0.1, keep_gap_s=0.0)
    with pytest.raises(ValueError):
        close_gaps(blocks, max_gap_s=1.0, keep_gap_s=-0.1)


# ---------------------------------------------------------------- §7-3 resolve_overlaps


def test_resolve_overlaps_tail_lands_later_at_earlier_end_minus_keep():
    blocks = [_blk("a1", "A", 0.0, 2.0), _blk("b1", "B", 1.0, 2.0)]  # 被り [1, 2]
    result, actions = resolve_overlaps(blocks, min_overlap_s=0.3, max_overlap_s=3.0)
    by_id = {b.id: b.start for b in result}
    assert by_id == {"a1": 0.0, "b1": 2.0}  # later.start' == earlier.end - keep(0)
    assert [(a.kind, a.start, a.end, a.amount, a.block_ids) for a in actions] == [
        ("resolve_overlap", 1.0, 2.0, 1.0, ["a1", "b1"]),
    ]
    result2, _ = resolve_overlaps(
        blocks, min_overlap_s=0.3, max_overlap_s=3.0, keep_overlap_s=0.2
    )
    assert {b.id: b.start for b in result2}["b1"] == 1.8  # earlier.end - 0.2


def test_resolve_overlaps_ripples_both_speakers_after_cut_and_keeps_earlier_fixed():
    blocks = [
        _blk("a0", "A", 0.0, 0.5),  # カット前 → 不動
        _blk("a1", "A", 1.0, 2.0),  # earlier [1, 3] → 不動
        _blk("b1", "B", 2.0, 2.0),  # later [2, 4] → 3.0 へ（delta 1.0）
        _blk("a2", "A", 4.5, 1.0),  # カット後 → +1.0（両話者等量シフト）
        _blk("b2", "B", 6.0, 1.0),  # カット後 → +1.0
    ]
    result, _ = resolve_overlaps(blocks, min_overlap_s=0.3, max_overlap_s=3.0)
    assert [b.start for b in result] == [0.0, 1.0, 3.0, 5.5, 7.0]
    # カット以降の相対タイミング保存（a2-b1 / b2-a2 の間隔が不変）
    assert result[3].start - result[2].start == blocks[3].start - blocks[2].start
    assert result[4].start - result[3].start == blocks[4].start - blocks[3].start


def test_resolve_overlaps_skips_contained_too_long_same_start():
    contained = [_blk("a1", "A", 0.0, 5.0), _blk("b1", "B", 1.0, 1.0)]
    result, actions = resolve_overlaps(contained, min_overlap_s=0.3, max_overlap_s=3.0)
    assert _snapshot(result) == _snapshot(contained)  # blocks 不変
    assert [(a.kind, a.reason, a.amount, a.block_ids) for a in actions] == [
        ("skip_overlap", "contained", 0.0, ["a1", "b1"]),
    ]

    too_long = [_blk("a1", "A", 0.0, 5.0), _blk("b1", "B", 1.0, 9.0)]  # 交差 4s > 3s
    result, actions = resolve_overlaps(too_long, min_overlap_s=0.3, max_overlap_s=3.0)
    assert _snapshot(result) == _snapshot(too_long)
    assert [(a.kind, a.reason) for a in actions] == [("skip_overlap", "too_long")]

    same_start = [_blk("a1", "A", 1.0, 2.0), _blk("b1", "B", 1.0, 3.0)]
    result, actions = resolve_overlaps(same_start, min_overlap_s=0.3, max_overlap_s=3.0)
    assert _snapshot(result) == _snapshot(same_start)
    assert [(a.kind, a.reason) for a in actions] == [("skip_overlap", "same_start")]


def test_resolve_overlaps_ignores_below_min_overlap():
    blocks = [_blk("a1", "A", 0.0, 2.0), _blk("b1", "B", 1.8, 2.0)]  # 交差 0.2 < 0.3
    result, actions = resolve_overlaps(blocks, min_overlap_s=0.3, max_overlap_s=3.0)
    assert actions == []  # skip アクションも出さない
    assert _snapshot(result) == _snapshot(blocks)


def test_resolve_overlaps_chain_reevaluates_delta_in_current_coords():
    # 長ブロック1本に被り2件（B側同話者重なり = 病的データ）。
    # 素朴な元座標 prefix-sum なら b2 は delta1+delta2 で過剰シフトするが、
    # 現在座標再評価により2件目は delta <= EPS → アクション無しのサイレント収束。
    blocks = [
        _blk("a1", "A", 0.0, 10.0),
        _blk("b1", "B", 8.0, 3.0),  # [8, 11] → delta 2 で [10, 13]
        _blk("b2", "B", 9.0, 3.8),  # [9, 12.8] → cut(8, 2) で [11, 14.8]、解消済み
    ]
    result, actions = resolve_overlaps(blocks, min_overlap_s=0.3, max_overlap_s=3.0)
    assert {b.id: b.start for b in result} == {"a1": 0.0, "b1": 10.0, "b2": 11.0}
    assert [(a.kind, a.block_ids) for a in actions] == [("resolve_overlap", ["a1", "b1"])]


def test_resolve_overlaps_matches_insert_gap_fold_on_clean_data():
    # 等価性（性質テスト）: 逐次 insert_gap(at=後発の現在start, duration=delta,
    # speakers=None) 適用（基準器 = 既存関数）と全フィールド厳密一致（クリーンデータ）
    rng = random.Random(9)
    blocks = _random_blocks(rng, 300, pathological=False)
    result, actions = resolve_overlaps(blocks, min_overlap_s=0.3, max_overlap_s=3.0)
    folded = clone_blocks(blocks)
    resolved_actions = [a for a in actions if a.kind == "resolve_overlap"]
    for act in resolved_actions:
        later = next(b for b in folded if b.id == act.block_ids[1])
        folded = insert_gap(folded, at_seconds=later.start, duration_seconds=act.amount)
    assert _snapshot(result) == _snapshot(folded)
    assert resolved_actions  # 実被りが解消されるデータであること（空振り防止）


def test_resolve_overlaps_rejects_bad_thresholds():
    blocks = [_blk("a1", "A", 0.0, 1.0)]
    with pytest.raises(ValueError):
        resolve_overlaps(blocks, min_overlap_s=0.3, max_overlap_s=3.0, keep_overlap_s=0.3)
    with pytest.raises(ValueError):
        resolve_overlaps(blocks, min_overlap_s=0.3, max_overlap_s=3.0, keep_overlap_s=-0.1)
    with pytest.raises(ValueError):
        resolve_overlaps(blocks, min_overlap_s=0.3, max_overlap_s=0.2)


# ---------------------------------------------------------------- §7-4 auto_tighten 統合


def _demo_blocks():
    return [
        _blk("a1", "A", 1.0, 2.0),  # 先頭無音 [0, 1)（max_gap 以下 → 触らない）
        _blk("b1", "B", 2.0, 2.0),  # a1 と tail 被り [2, 3]
        _blk("a2", "A", 7.0, 3.0),  # 手前に無音ギャップ
        _blk("b2", "B", 8.0, 1.0),  # a2 に内包（contained skip）
        _blk("a3", "A", 13.0, 1.0),  # 手前に無音ギャップ
    ]


def test_auto_tighten_full_pass_and_summary():
    blocks = _demo_blocks()
    result = auto_tighten(blocks)
    assert {b.id: b.start for b in result.blocks} == {
        "a1": 1.0, "b1": 3.0, "a2": 5.5, "b2": 6.5, "a3": 9.0,
    }
    # 実行後: 全ギャップ <= max_gap_s、tail型かつ max_ov 以下の被りは 0 件
    assert detect_silence_gaps(result.blocks, min_gap_s=1.5) == []
    remaining = recompute_overlaps(result.blocks)
    assert [o.block_ids for o in remaining] == [["a2", "b2"]]  # skip被りは残存
    assert result.summary() == {
        "gaps_closed": 2,
        "overlaps_resolved": 1,
        "overlaps_skipped": 1,
        "skipped_reasons": {"contained": 1, "too_long": 0, "same_start": 0},
        "removed_s": 5.0,
        "inserted_s": 1.0,
        "blocks_moved": 4,
        "duration_before": 14.0,
        "duration_after": 10.0,
        "would_change": True,
    }


def test_auto_tighten_both_off_is_non_destructive_noop():
    blocks = _demo_blocks()
    result = auto_tighten(blocks, tighten_overlaps=False, tighten_gaps=False)
    assert _snapshot(result.blocks) == _snapshot(blocks)
    assert result.blocks is not blocks  # 非破壊契約: 新リスト返却
    assert all(new is not old for old, new in zip(blocks, result.blocks))
    assert result.actions == []
    assert result.summary()["would_change"] is False


def test_auto_tighten_individual_flags_run_only_their_pass():
    blocks = _demo_blocks()
    gaps_only = auto_tighten(blocks, tighten_overlaps=False)
    assert gaps_only.actions and all(a.kind == "close_gap" for a in gaps_only.actions)
    overlaps_only = auto_tighten(blocks, tighten_gaps=False)
    assert overlaps_only.actions and all(
        a.kind in ("resolve_overlap", "skip_overlap") for a in overlaps_only.actions
    )


def test_auto_tighten_order_invariance_on_clean_data():
    # 逆順（詰め → 解消）でも最終 blocks が一致する（round 6 比較）
    rng = random.Random(77)
    blocks = _random_blocks(rng, 250, pathological=False)
    forward = auto_tighten(blocks)
    closed_first, _ = close_gaps(blocks, max_gap_s=1.5, keep_gap_s=0.5)
    reversed_blocks, _ = resolve_overlaps(
        closed_first, min_overlap_s=0.3, max_overlap_s=3.0
    )
    assert [round(b.start, 6) for b in forward.blocks] == [
        round(b.start, 6) for b in reversed_blocks
    ]
    assert forward.summary()["would_change"] is True  # 空振り防止


# ---------------------------------------------------------------- §7-5 冪等性


def test_auto_tighten_is_idempotent_including_same_start_pairs():
    blocks = _demo_blocks() + [
        _blk("a9", "A", 20.0, 2.0),
        _blk("b9", "B", 20.0, 3.0),  # same_start ペア（非冪等縮退の回帰テスト）
    ]
    first = auto_tighten(blocks)
    second = auto_tighten(first.blocks)
    assert _snapshot(second.blocks) == _snapshot(first.blocks)  # blocks 完全一致
    assert [a for a in second.actions if a.kind != "skip_overlap"] == []  # 変異 0 件
    assert second.summary()["would_change"] is False
    reasons = {a.reason for a in second.actions}
    assert "same_start" in reasons  # skip ペアは2回目も同じ分類で残る


# ------------------------------------------------ §7-6 不変条件（プロパティテスト、seeded random）


def test_property_invariants_on_pathological_random_data():
    rng = random.Random(20260731)
    for _trial in range(5):
        blocks = _random_blocks(rng, 200, pathological=True)
        immutable_before = [
            (b.id, b.speaker, b.source_start, b.source_end, b.text, b.deleted)
            for b in blocks
        ]
        result = auto_tighten(blocks)
        # (a) start 以外（source座標 / id / speaker / text / deleted）は完全不変
        assert [
            (b.id, b.speaker, b.source_start, b.source_end, b.text, b.deleted)
            for b in result.blocks
        ] == immutable_before
        # (b) アクティブブロックの start 順序保存（追い越しなし）
        order_before = [b.id for b in active_blocks(blocks)]
        pos_after = {b.id: b.start for b in result.blocks}
        starts_after = [pos_after[bid] for bid in order_before]
        assert all(s2 >= s1 - EPS for s1, s2 in zip(starts_after, starts_after[1:]))
        # (c) close_gaps 単体は被りを増やさない
        closed, _ = close_gaps(blocks, max_gap_s=1.5, keep_gap_s=0.5)
        assert len(recompute_overlaps(closed)) == len(recompute_overlaps(blocks))
        # (d) 冪等性（同話者重なり・内包・接触・zero-duration・deleted を含む入力）
        second = auto_tighten(result.blocks)
        assert _snapshot(second.blocks) == _snapshot(result.blocks)
        assert second.summary()["would_change"] is False


# ---------------------------------------------------------------- §7-7 文字起こし射影の保存


def test_transcript_projection_preserved_under_auto_tighten():
    blocks = _demo_blocks()  # source は start と同値で構築（_blk のデフォルト）
    transcripts = [
        TranscriptSegment(id="t1", speaker="A", source_start=1.2, source_end=2.4, text="hello"),
        TranscriptSegment(id="t2", speaker="B", source_start=2.1, source_end=3.9, text="world"),
        TranscriptSegment(id="t3", speaker="A", source_start=7.5, source_end=9.5, text="again"),
    ]
    before_by_id = {b.id: b for b in blocks}
    result = auto_tighten(blocks)
    after_by_id = {b.id: b for b in result.blocks}
    assert result.summary()["would_change"] is True
    for seg in transcripts:
        mapped_before = map_transcript_to_timeline(blocks, seg)
        mapped_after = map_transcript_to_timeline(result.blocks, seg)
        assert mapped_before  # 空振り防止
        # block_id 対応が完全一致
        assert [m.block_id for m in mapped_after] == [m.block_id for m in mapped_before]
        # ブロック内相対オフセットと長さが完全一致（SRT はブロックと平行移動するだけ）
        assert [
            round(m.start - after_by_id[m.block_id].start, 6) for m in mapped_after
        ] == [round(m.start - before_by_id[m.block_id].start, 6) for m in mapped_before]
        assert [round(m.end - m.start, 6) for m in mapped_after] == [
            round(m.end - m.start, 6) for m in mapped_before
        ]


# ---------------------------------------------------------------- §7-8 recompute_overlaps スイープ化


def test_recompute_overlaps_sweep_matches_naive_reference():
    rng = random.Random(1234)
    for pathological in (False, True):
        blocks = _random_blocks(rng, 300, pathological=pathological)
        for min_duration in (0.3, 0.05):
            got = recompute_overlaps(blocks, min_duration=min_duration)
            want = _naive_overlaps(blocks, min_duration=min_duration)
            norm = lambda ovs: sorted(
                (o.start, o.end, o.duration, tuple(o.block_ids)) for o in ovs
            )
            assert norm(got) == norm(want)
            assert got  # 空振り防止
            # (start, end) ソートの既存互換
            assert [(o.start, o.end) for o in got] == sorted((o.start, o.end) for o in got)


def test_recompute_overlaps_min_duration_boundary_inclusive():
    blocks = [_blk("a1", "A", 0.0, 1.0), _blk("b1", "B", 0.75, 2.0)]  # 交差 0.25
    assert len(recompute_overlaps(blocks, min_duration=0.25)) == 1  # ちょうどは >= で検出
    assert recompute_overlaps(blocks, min_duration=0.26) == []


def test_recompute_overlaps_block_ids_order_is_a_then_b():
    blocks = [_blk("b1", "B", 0.0, 2.0), _blk("a1", "A", 1.0, 2.0)]  # B が earlier
    overlaps = recompute_overlaps(blocks)
    assert [o.block_ids for o in overlaps] == [["a1", "b1"]]


def test_recompute_overlaps_has_no_resolved_field_or_previous_arg():
    """resolved フィールドと previous 引き継ぎ機構の撤去を固定する（2026-08）。

    resolved は true にする経路がコード上に一切存在せず常に false の定数だったため、
    フィールドごと削除した。引き継ぐ状態が無くなったので previous 引数も撤去。
    """
    blocks = [_blk("a1", "A", 0.0, 2.0), _blk("b1", "B", 1.0, 2.0)]
    overlaps = recompute_overlaps(blocks)
    assert len(overlaps) == 1
    assert not hasattr(overlaps[0], "resolved")
    assert "resolved" not in overlaps[0].to_dict()
    with pytest.raises(TypeError):
        recompute_overlaps(blocks, previous=[])  # type: ignore[call-arg]


def test_overlap_from_dict_ignores_legacy_resolved_key():
    """旧 project.json（"resolved": true/false 付き）が読めること（後方互換）。"""
    state = ProjectState.from_dict(
        {
            "id": "legacy-ov",
            "name": "legacy",
            "overlaps": [
                {"start": 1.0, "end": 2.0, "duration": 1.0, "resolved": True,
                 "block_ids": ["a1", "b1"]},
            ],
        }
    )
    assert len(state.overlaps) == 1
    assert state.overlaps[0].block_ids == ["a1", "b1"]
    assert not hasattr(state.overlaps[0], "resolved")


def test_recompute_overlaps_lists_all_pairs_with_same_speaker_overlap():
    blocks = [
        _blk("a1", "A", 0.0, 10.0),
        _blk("a2", "A", 2.0, 6.0),  # A話者内重なり（病的データ）でも全ペア列挙
        _blk("b1", "B", 3.0, 2.0),
    ]
    overlaps = recompute_overlaps(blocks)
    assert sorted(tuple(o.block_ids) for o in overlaps) == [("a1", "b1"), ("a2", "b1")]


# ---------------------------------------------------------------- §7-9 exporter（ffmpeg 不要部分）


def test_timeline_end_ignores_deleted_and_zero_duration():
    assert timeline_end([]) == 0.0
    blocks = [
        _blk("a1", "A", 0.0, 2.0),
        _blk("a2", "A", 50.0, 1.0, deleted=True),  # tombstone は無視
        _blk("b1", "B", 40.0, 0.0),  # zero-duration は無視
        _blk("b2", "B", 3.0, 4.0),
    ]
    assert timeline_end(blocks) == 7.0


def _project_with_blocks(blocks):
    project = ProjectState.new("proj-test", "proj-test")
    project.status = "ready"
    project.blocks = blocks
    for speaker in ("A", "B"):
        project.tracks[speaker].duration = 3300.0  # 元素材フル尺（55分）
        project.tracks[speaker].normalized_wav = f"speaker{speaker}_normalized.wav"
    project.tracks["A"].offset_seconds = 1.0
    return project


def test_export_project_raises_when_no_active_blocks(tmp_path):
    project = _project_with_blocks([_blk("a1", "A", 0.0, 2.0, deleted=True)])
    with pytest.raises(ValueError, match="no active blocks"):
        exporter.export_project(project, tmp_path / "out")


def test_export_project_uses_timeline_end_not_source_duration(tmp_path, monkeypatch):
    # 詰め後の timeline_duration = max active end（元素材フル尺 3300s ではない）を
    # render_edited_track へ渡す minimum_duration で検証。両話者同一値（等長維持）。
    project = _project_with_blocks(
        [
            _blk("a1", "A", 0.0, 2.0),
            _blk("b1", "B", 50.0, 50.0),  # タイムライン末端 100s
        ]
    )
    captured = []

    def fake_render(*, source_wav, blocks, speaker, output_wav, gain_db, deesser,
                    crossfade_ms, minimum_duration):
        captured.append((speaker, minimum_duration))
        Path(output_wav).write_bytes(b"")

    monkeypatch.setattr(exporter, "render_edited_track", fake_render)
    monkeypatch.setattr(
        exporter, "resolve_project_file", lambda pid, name: Path("/nonexistent") / name
    )
    monkeypatch.setattr(
        exporter, "write_overlaps_csv", lambda overlaps, path: Path(path).write_text("")
    )
    files = exporter.export_project(project, tmp_path / "out")
    assert [c[1] for c in captured] == [100.0, 100.0]
    assert {"speakerA.wav", "speakerB.wav"} <= set(files)


# ---------------------------------------------------------------- レビュー2-C classify_overlaps


def _categories(blocks, *, min_overlap_s=0.3, max_overlap_s=3.0):
    return {
        frozenset(row["block_ids"]): row["category"]
        for row in classify_overlaps(
            blocks, min_overlap_s=min_overlap_s, max_overlap_s=max_overlap_s
        )
    }


def test_classify_overlaps_labels_all_four_categories():
    blocks = [
        _blk("a1", "A", 0.0, 2.0),
        _blk("b1", "B", 1.0, 2.0),    # tail 型 → resolvable
        _blk("a2", "A", 10.0, 5.0),
        _blk("b2", "B", 11.0, 1.0),   # 内包 → contained
        _blk("a3", "A", 20.0, 5.0),
        _blk("b3", "B", 21.0, 9.0),   # 交差 4s > 3s → too_long
        _blk("a4", "A", 40.0, 2.0),
        _blk("b4", "B", 40.0, 3.0),   # 同時発話 → same_start
    ]
    assert _categories(blocks) == {
        frozenset(("a1", "b1")): "resolvable",
        frozenset(("a2", "b2")): "contained",
        frozenset(("a3", "b3")): "too_long",
        frozenset(("a4", "b4")): "same_start",
    }


def test_classify_overlaps_shape_and_sort_and_block_ids_order():
    blocks = [_blk("b1", "B", 0.0, 2.0), _blk("a1", "A", 1.0, 2.0)]  # B が earlier
    rows = classify_overlaps(blocks, min_overlap_s=0.3, max_overlap_s=3.0)
    assert rows == [
        {
            "block_ids": ["a1", "b1"],  # recompute_overlaps と同じ [A, B] 順
            "start": 1.0,
            "end": 2.0,
            "duration": 1.0,
            "category": "resolvable",
        }
    ]
    assert [(r["start"], r["end"]) for r in rows] == sorted(
        (r["start"], r["end"]) for r in rows
    )


def test_classify_overlaps_respects_min_overlap_and_is_non_destructive():
    blocks = [_blk("a1", "A", 0.0, 2.0), _blk("b1", "B", 1.8, 2.0)]  # 交差 0.2
    before = _snapshot(blocks)
    assert classify_overlaps(blocks, min_overlap_s=0.3, max_overlap_s=3.0) == []
    assert len(classify_overlaps(blocks, min_overlap_s=0.1, max_overlap_s=3.0)) == 1
    assert _snapshot(blocks) == before  # 入力不変


def test_classify_overlaps_pairs_match_recompute_overlaps_pairs():
    # 同じ閾値なら列挙されるペア集合は recompute_overlaps と完全一致する
    rng = random.Random(31337)
    for pathological in (False, True):
        blocks = _random_blocks(rng, 300, pathological=pathological)
        classified = {frozenset(r["block_ids"]) for r in classify_overlaps(
            blocks, min_overlap_s=0.3, max_overlap_s=3.0)}
        recomputed = {frozenset(o.block_ids) for o in recompute_overlaps(blocks, min_duration=0.3)}
        assert classified == recomputed
        assert classified  # 空振り防止


def test_classify_overlaps_rejects_bad_thresholds():
    with pytest.raises(ValueError):
        classify_overlaps([_blk("a1", "A", 0.0, 1.0)], min_overlap_s=0.3, max_overlap_s=0.2)


def test_classify_matches_resolve_overlaps_actual_behaviour_on_clean_data():
    """性質テスト: クリーンデータでは classify の分類が resolve_overlaps の
    実挙動とちょうど一致する（resolvable ⇔ resolve_overlap アクション、
    それ以外 ⇔ 同じ reason の skip_overlap アクション）。"""
    rng = random.Random(20260802)
    for _trial in range(5):
        blocks = _random_blocks(rng, 250, pathological=False)
        categories = _categories(blocks)
        _, actions = resolve_overlaps(blocks, min_overlap_s=0.3, max_overlap_s=3.0)
        acted = {
            frozenset(a.block_ids): ("resolvable" if a.kind == "resolve_overlap" else a.reason)
            for a in actions
        }
        assert acted == categories
        assert categories  # 空振り防止


def test_classify_never_over_promises_on_pathological_data():
    """病的データ（同話者重なり）では classify（元座標）と resolve（現在座標）が
    ズレうる。ズレの向きは **必ず「解消される側」** であることを固定する:

    - classify=resolvable → 実行時 resolve / サイレント収束（先行カットで解消済み）
    - classify=contained  → 実行時 contained / resolve（先行カットで tail 化）
                            / サイレント収束
    - classify=too_long / same_start → 実行時も同じ（分類が座標シフトで変わらない）

    禁止されるのは逆向き（classify が「自動解消可」と言ったのに実行時 skip される）で、
    これは UI のチップが嘘をつくケース。1件でも出たら失敗する。
    """
    allowed = {
        "resolvable": {"resolvable", "<none>"},
        "contained": {"contained", "resolvable", "<none>"},
        "too_long": {"too_long"},
        "same_start": {"same_start"},
    }
    rng = random.Random(4242)
    seen: set[tuple[str, str]] = set()
    for _trial in range(6):
        blocks = _random_blocks(rng, 250, pathological=True)
        categories = _categories(blocks)
        _, actions = resolve_overlaps(blocks, min_overlap_s=0.3, max_overlap_s=3.0)
        acted: dict[frozenset[str], str] = {}
        for a in actions:
            acted[frozenset(a.block_ids)] = (
                "resolvable" if a.kind == "resolve_overlap" else a.reason
            )
        for pair, category in categories.items():
            actual = acted.get(pair, "<none>")
            assert actual in allowed[category], f"{category} -> {actual}"
            seen.add((category, actual))
        # classify に無いペアが実行されることはない（列挙は同一）
        assert set(acted) <= set(categories)
    assert ("resolvable", "resolvable") in seen  # 空振り防止
    assert ("resolvable", "<none>") in seen      # 既知のサイレント収束が実在する
    assert ("contained", "contained") in seen


# ---------------------------------------------------------------- レビュー2-D target_pairs


def _multi_overlap_blocks():
    """独立した tail 被り3件（相互に干渉しない距離）。"""
    return [
        _blk("a1", "A", 0.0, 2.0),
        _blk("b1", "B", 1.0, 2.0),    # 被り1 [1, 2]
        _blk("a2", "A", 20.0, 2.0),
        _blk("b2", "B", 21.0, 2.0),   # 被り2 [21, 22]
        _blk("a3", "A", 40.0, 2.0),
        _blk("b3", "B", 41.0, 2.0),   # 被り3 [41, 42]
    ]


def test_target_pairs_resolves_only_the_selected_pair():
    blocks = _multi_overlap_blocks()
    result, actions = resolve_overlaps(
        blocks, min_overlap_s=0.3, max_overlap_s=3.0,
        target_pairs={frozenset(("a2", "b2"))},
    )
    assert [(a.kind, a.block_ids) for a in actions] == [("resolve_overlap", ["a2", "b2"])]
    starts = {b.id: b.start for b in result}
    # b2 のみ着地。a1/b1 は不動、a3/b3 はカット点以降なので等量右シフト（+1.0）
    assert starts == {"a1": 0.0, "b1": 1.0, "a2": 20.0, "b2": 22.0, "a3": 41.0, "b3": 42.0}


def test_target_pairs_ignores_unselected_regardless_of_category():
    # 選択外は skip アクションすら出さない（一覧に出さない）
    blocks = _multi_overlap_blocks() + [
        _blk("a9", "A", 60.0, 2.0),
        _blk("b9", "B", 60.0, 3.0),   # same_start（選択外）
    ]
    _, actions = resolve_overlaps(
        blocks, min_overlap_s=0.3, max_overlap_s=3.0,
        target_pairs={frozenset(("a1", "b1"))},
    )
    assert [(a.kind, a.block_ids) for a in actions] == [("resolve_overlap", ["a1", "b1"])]


def test_target_pairs_pair_order_does_not_matter():
    blocks = _multi_overlap_blocks()
    forward, _ = resolve_overlaps(
        blocks, min_overlap_s=0.3, max_overlap_s=3.0,
        target_pairs={frozenset(("a2", "b2"))},
    )
    backward, _ = resolve_overlaps(
        blocks, min_overlap_s=0.3, max_overlap_s=3.0,
        target_pairs={frozenset(("b2", "a2"))},
    )
    assert _snapshot(forward) == _snapshot(backward)


def test_target_pairs_unknown_pair_is_ignored():
    blocks = _multi_overlap_blocks()
    result, actions = resolve_overlaps(
        blocks, min_overlap_s=0.3, max_overlap_s=3.0,
        target_pairs={frozenset(("nope-a", "nope-b"))},
    )
    assert actions == []
    assert _snapshot(result) == _snapshot(blocks)
    assert all(new is not old for old, new in zip(blocks, result))  # 非破壊クローン


def test_target_pairs_empty_set_is_total_noop():
    blocks = _multi_overlap_blocks()
    result, actions = resolve_overlaps(
        blocks, min_overlap_s=0.3, max_overlap_s=3.0, target_pairs=set()
    )
    assert actions == []
    assert _snapshot(result) == _snapshot(blocks)


def test_target_pairs_none_matches_current_full_behaviour():
    blocks = _multi_overlap_blocks()
    full, full_actions = resolve_overlaps(blocks, min_overlap_s=0.3, max_overlap_s=3.0)
    explicit, explicit_actions = resolve_overlaps(
        blocks, min_overlap_s=0.3, max_overlap_s=3.0, target_pairs=None
    )
    assert _snapshot(full) == _snapshot(explicit)
    assert len(full_actions) == len(explicit_actions) == 3


def test_target_pairs_union_of_all_pairs_equals_full_run():
    rng = random.Random(606)
    blocks = _random_blocks(rng, 250, pathological=False)
    every = {frozenset(r["block_ids"]) for r in classify_overlaps(
        blocks, min_overlap_s=0.3, max_overlap_s=3.0)}
    full, full_actions = resolve_overlaps(blocks, min_overlap_s=0.3, max_overlap_s=3.0)
    selected, selected_actions = resolve_overlaps(
        blocks, min_overlap_s=0.3, max_overlap_s=3.0, target_pairs=every
    )
    assert _snapshot(full) == _snapshot(selected)
    assert [a.to_dict() for a in full_actions] == [a.to_dict() for a in selected_actions]
    assert full_actions  # 空振り防止


def test_target_pairs_is_idempotent():
    blocks = _multi_overlap_blocks()
    pairs = {frozenset(("a1", "b1")), frozenset(("a3", "b3"))}
    first = auto_tighten(blocks, target_pairs=pairs)
    second = auto_tighten(first.blocks, target_pairs=pairs)
    assert _snapshot(second.blocks) == _snapshot(first.blocks)
    assert second.summary()["would_change"] is False


def test_target_pairs_idempotent_on_random_data_with_gaps():
    rng = random.Random(818)
    blocks = _random_blocks(rng, 250, pathological=True)
    rows = classify_overlaps(blocks, min_overlap_s=0.3, max_overlap_s=3.0)
    # 半分だけ選択（一覧のチェックボックスを間引いた状態）
    pairs = {frozenset(r["block_ids"]) for i, r in enumerate(rows) if i % 2 == 0}
    first = auto_tighten(blocks, target_pairs=pairs)
    second = auto_tighten(first.blocks, target_pairs=pairs)
    assert _snapshot(second.blocks) == _snapshot(first.blocks)
    assert second.summary()["would_change"] is False
    assert first.summary()["would_change"] is True  # 空振り防止


def test_auto_tighten_target_pairs_does_not_affect_gap_pass():
    # 被り選択は無音詰めに影響しない（ギャップは常に全件対象）
    blocks = _multi_overlap_blocks()
    empty_sel = auto_tighten(blocks, target_pairs=set())
    gaps_only = auto_tighten(blocks, tighten_overlaps=False)
    assert _snapshot(empty_sel.blocks) == _snapshot(gaps_only.blocks)
    assert [a.kind for a in empty_sel.actions] == [a.kind for a in gaps_only.actions]
    assert any(a.kind == "close_gap" for a in empty_sel.actions)  # 空振り防止


def test_target_pairs_preserves_source_coordinates_and_ordering():
    rng = random.Random(2929)
    blocks = _random_blocks(rng, 200, pathological=True)
    rows = classify_overlaps(blocks, min_overlap_s=0.3, max_overlap_s=3.0)
    pairs = {frozenset(r["block_ids"]) for r in rows if r["category"] == "resolvable"}
    immutable_before = [
        (b.id, b.speaker, b.source_start, b.source_end, b.text, b.deleted) for b in blocks
    ]
    result = auto_tighten(blocks, target_pairs=pairs)
    assert [
        (b.id, b.speaker, b.source_start, b.source_end, b.text, b.deleted)
        for b in result.blocks
    ] == immutable_before
    order_before = [b.id for b in active_blocks(blocks)]
    pos_after = {b.id: b.start for b in result.blocks}
    starts_after = [pos_after[bid] for bid in order_before]
    assert all(s2 >= s1 - EPS for s1, s2 in zip(starts_after, starts_after[1:]))


# ---------------------------------------------------------------- §7-11 性能スモーク


def test_performance_smoke_4000_blocks_under_half_second():
    # 実機2065ブロックの約2倍。旧 O(A×B) 実装はこの規模で確実に 0.5s を超える
    rng = random.Random(5)
    blocks = _random_blocks(rng, 4000, pathological=False)
    started = time.perf_counter()
    result = auto_tighten(blocks)
    recompute_overlaps(result.blocks)
    elapsed = time.perf_counter() - started
    assert elapsed < 0.5, f"auto_tighten + recompute_overlaps took {elapsed:.3f}s"
