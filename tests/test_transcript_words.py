"""words（単語タイムスタンプ）によるブロック跨ぎテキスト分割のテスト。

背景: Whisperの1セグメントがVAD発話ブロックを複数跨ぐと、従来は跨いだ全行に
全文が複製表示されていた。words があれば単語中点の所属断片に分配し、
無ければ先頭断片にのみ全文を出す（複製をやめる）。
"""

import random

from podcast_prep.models import Block, TranscriptSegment
from podcast_prep.timeline import (
    map_transcript_to_timeline,
    searchable_block_text,
    segments_to_srt,
    timeline_transcript_segments,
)


def _blocks_three_span() -> list[Block]:
    """実バグ形: B話者 source 269.68-273.08 のセグメントが3ブロック跨ぎ。"""
    return [
        Block(id="b-00097", speaker="B", source_start=269.0, source_end=270.4, start=269.0),
        Block(id="b-00098", speaker="B", source_start=270.9, source_end=271.8, start=270.9),
        Block(id="b-00099", speaker="B", source_start=272.2, source_end=273.5, start=272.2),
    ]


def _segment_three_span(words: bool = True) -> TranscriptSegment:
    return TranscriptSegment(
        id="b-tr-1",
        speaker="B",
        source_start=269.68,
        source_end=273.08,
        text="はいでで行ってみて",
        words=[
            {"start": 269.68, "end": 270.1, "text": "はい"},
            {"start": 271.0, "end": 271.4, "text": "で"},
            {"start": 271.5, "end": 271.7, "text": "で"},
            {"start": 272.3, "end": 273.08, "text": "行ってみて"},
        ]
        if words
        else [],
    )


def test_words_are_distributed_per_block_without_duplication():
    mapped = map_transcript_to_timeline(_blocks_three_span(), _segment_three_span())

    assert [m.block_id for m in mapped] == ["b-00097", "b-00098", "b-00099"]
    assert [m.text for m in mapped] == ["はい", "でで", "行ってみて"]
    # 複製ゼロ: 全断片の連結が元の単語列そのもの
    assert "".join(m.text for m in mapped) == "はいでで行ってみて"


def test_word_straddling_block_boundary_is_assigned_by_midpoint():
    blocks = [
        Block(id="a1", speaker="A", source_start=0.0, source_end=2.0, start=0.0),
        Block(id="a2", speaker="A", source_start=2.0, source_end=4.0, start=10.0),
    ]
    segment = TranscriptSegment(
        id="t1", speaker="A", source_start=1.0, source_end=3.0, text="left right",
        words=[
            # 1.5..2.25: 境界2.0を跨ぐが中点1.875 < 2.0 → 左断片
            {"start": 1.5, "end": 2.25, "text": " left"},
            # 1.9..2.5: 境界跨ぎで中点2.2 >= 2.0 → 右断片
            {"start": 1.9, "end": 2.5, "text": " right"},
        ],
    )

    mapped = map_transcript_to_timeline(blocks, segment)

    assert [m.text for m in mapped] == ["left", "right"]


def test_word_in_gap_between_blocks_goes_to_nearest_fragment():
    blocks = [
        Block(id="a1", speaker="A", source_start=0.0, source_end=1.0, start=0.0),
        Block(id="a2", speaker="A", source_start=2.0, source_end=3.0, start=2.0),
    ]
    segment = TranscriptSegment(
        id="t1", speaker="A", source_start=0.5, source_end=2.5, text="a b c",
        words=[
            {"start": 0.5, "end": 0.9, "text": " a"},
            # 中点1.2はどの断片にも入らない: 左断片(0.5..1.0)まで0.2 / 右断片(2.0..2.5)まで0.8 → 左
            {"start": 1.1, "end": 1.3, "text": " b"},
            {"start": 2.1, "end": 2.4, "text": " c"},
        ],
    )

    mapped = map_transcript_to_timeline(blocks, segment)

    assert [m.text for m in mapped] == ["a b", "c"]


def test_every_word_is_assigned_exactly_once_randomized():
    """性質: 断片が1つでもあれば、全単語がちょうど1回どこかの断片に載る
    （単語時刻が単調なら順序も保存 → 連結一致で取りこぼし・二重割当ゼロを検証）。"""
    rng = random.Random(20260801)
    for _ in range(50):
        # 互いに素なランダムブロック列
        blocks: list[Block] = []
        src = 0.0
        for i in range(rng.randint(1, 6)):
            src += rng.uniform(0.0, 1.5)
            end = src + rng.uniform(0.2, 3.0)
            blocks.append(
                Block(
                    id=f"a{i}", speaker="A",
                    source_start=round(src, 3), source_end=round(end, 3),
                    start=round(src, 3),
                )
            )
            src = end
        # ブロック被覆の内外にまたがるセグメント + 連続分割の単語列
        seg_start = round(rng.uniform(0.0, 1.0), 3)
        seg_end = round(seg_start + rng.uniform(1.0, src + 1.0), 3)
        n_words = rng.randint(1, 10)
        bounds = sorted(round(rng.uniform(seg_start, seg_end), 3) for _ in range(n_words - 1))
        edges = [seg_start, *bounds, seg_end]
        words = [
            {"start": edges[k], "end": edges[k + 1], "text": f" w{k}"}
            for k in range(n_words)
        ]
        segment = TranscriptSegment(
            id="t1", speaker="A", source_start=seg_start, source_end=seg_end,
            text=" ".join(f"w{k}" for k in range(n_words)), words=words,
        )

        mapped = map_transcript_to_timeline(blocks, segment)
        if not mapped:
            continue  # どのブロックとも交差しないセグメントは行なし（従来仕様）
        joined = " ".join(t for t in (m.text for m in mapped) if t)
        assert joined == segment.text, f"word loss/dup: {joined!r} != {segment.text!r}"


def test_wordless_segment_puts_full_text_only_on_first_fragment():
    mapped = map_transcript_to_timeline(_blocks_three_span(), _segment_three_span(words=False))

    assert [m.text for m in mapped] == ["はいでで行ってみて", "", ""]
    # 時刻断片は従来どおり3行とも出る（タイムライン被覆は不変）
    assert [m.block_id for m in mapped] == ["b-00097", "b-00098", "b-00099"]


def test_single_fragment_uses_segment_text_even_with_words():
    blocks = [Block(id="a1", speaker="A", source_start=0.0, source_end=5.0, start=0.0)]
    segment = TranscriptSegment(
        id="t1", speaker="A", source_start=1.0, source_end=2.0, text="full text",
        words=[{"start": 1.0, "end": 2.0, "text": " full  text"}],
    )

    mapped = map_transcript_to_timeline(blocks, segment)

    assert [m.text for m in mapped] == ["full text"]


def test_srt_reflects_word_split_and_skips_empty_fragments():
    blocks = _blocks_three_span()
    with_words = _segment_three_span()
    srt = segments_to_srt(timeline_transcript_segments(blocks, [with_words]))

    assert "B: はい\n" in srt
    assert "B: でで\n" in srt
    assert "B: 行ってみて\n" in srt
    assert srt.count("はい") == 1  # 全行複製が直っている

    # words無しフォールバック: 空テキスト断片は字幕にならず、番号は詰まる
    wordless = _segment_three_span(words=False)
    srt2 = segments_to_srt(timeline_transcript_segments(blocks, [wordless]))
    assert srt2.count("-->") == 1
    assert srt2.startswith("1\n")
    assert "はいでで行ってみて" in srt2


def test_searchable_block_text_uses_distributed_words():
    blocks = _blocks_three_span()
    segment = _segment_three_span()

    updated = searchable_block_text(blocks, [segment])

    assert [b.text for b in updated] == ["はい", "でで", "行ってみて"]


def test_searchable_block_text_wordless_keeps_linked_block_behavior():
    blocks = _blocks_three_span()
    segment = _segment_three_span(words=False)
    segment.block_id = "b-00099"  # link_transcripts_to_blocks 相当（最大交差）

    updated = searchable_block_text(blocks, [segment])

    assert [b.text for b in updated] == ["", "", "はいでで行ってみて"]


def test_transcript_segment_words_roundtrip_and_backward_compat():
    segment = TranscriptSegment(
        id="t1", speaker="A", source_start=0.0, source_end=1.0, text="hi",
        words=[{"start": 0.0, "end": 0.5, "text": " hi"}],
    )
    data = segment.to_dict()
    assert data["words"] == [{"start": 0.0, "end": 0.5, "text": " hi"}]
    assert TranscriptSegment.from_dict(data).words == segment.words

    # 旧データ: words欠損 → []
    legacy = {"id": "t2", "speaker": "B", "source_start": 1.0, "source_end": 2.0, "text": "x"}
    assert TranscriptSegment.from_dict(legacy).words == []

    # end欠損の単語は start に落とす（中点 = start）
    partial = dict(legacy, words=[{"start": 3.0, "text": " y"}, "broken", None])
    assert TranscriptSegment.from_dict(partial).words == [
        {"start": 3.0, "end": 3.0, "text": " y"}
    ]
