from podcast_prep.models import Block, TranscriptSegment
from podcast_prep.timeline import (
    blocks_from_vad,
    delete_block,
    delete_gap,
    insert_gap,
    link_transcripts_to_blocks,
    map_transcript_to_timeline,
    move_block,
    recompute_overlaps,
    seconds_to_srt_time,
    segments_to_srt,
    split_block_at,
    timeline_transcript_segments,
)


def test_vad_intervals_become_offset_blocks_and_short_intervals_are_ignored():
    blocks = blocks_from_vad("A", [(0.0, 0.05), (1.0, 2.25)], offset_seconds=0.2)

    assert len(blocks) == 1
    assert blocks[0].speaker == "A"
    assert blocks[0].source_start == 1.0
    assert blocks[0].source_end == 2.25
    assert blocks[0].start == 1.2
    assert blocks[0].end == 2.45


def test_block_editing_operations_are_reflected_in_timeline():
    blocks = [
        Block(id="a1", speaker="A", source_start=0.0, source_end=1.0, start=0.0),
        Block(id="a2", speaker="A", source_start=2.0, source_end=3.0, start=2.0),
        Block(id="b1", speaker="B", source_start=0.5, source_end=1.5, start=0.5),
    ]

    moved = move_block(blocks, "a2", 2.5)
    assert next(block for block in moved if block.id == "a2").start == 2.5
    assert next(block for block in blocks if block.id == "a2").start == 2.0

    inserted = insert_gap(moved, at_seconds=1.0, duration_seconds=0.75, speakers={"A"})
    assert next(block for block in inserted if block.id == "a2").start == 3.25
    assert next(block for block in inserted if block.id == "b1").start == 0.5

    deleted_gap = delete_gap(inserted, gap_start=1.25, gap_end=2.0, speakers={"A"})
    assert next(block for block in deleted_gap if block.id == "a2").start == 2.5

    deleted = delete_block(deleted_gap, "b1")
    assert next(block for block in deleted if block.id == "b1").deleted is True


def test_split_block_preserves_source_timeline_mapping():
    blocks = [Block(id="a1", speaker="A", source_start=10.0, source_end=14.0, start=30.0)]

    split = split_block_at(blocks, "a1", at_seconds=31.5)

    left = split[0]
    right = split[1]
    assert left.source_start == 10.0
    assert left.source_end == 11.5
    assert left.start == 30.0
    assert right.source_start == 11.5
    assert right.source_end == 14.0
    assert right.start == 31.5


def test_overlap_detection_uses_edited_block_positions():
    blocks = [
        Block(id="a1", speaker="A", source_start=0.0, source_end=2.0, start=10.0),
        Block(id="b1", speaker="B", source_start=0.0, source_end=2.0, start=11.0),
        Block(id="b2", speaker="B", source_start=5.0, source_end=6.0, start=20.0),
    ]

    overlaps = recompute_overlaps(blocks, min_duration=0.3)

    assert len(overlaps) == 1
    assert overlaps[0].start == 11.0
    assert overlaps[0].end == 12.0
    assert overlaps[0].duration == 1.0
    assert overlaps[0].block_ids == ["a1", "b1"]


def test_transcript_segments_map_to_moved_blocks():
    blocks = [Block(id="a1", speaker="A", source_start=5.0, source_end=8.0, start=20.0)]
    transcript = TranscriptSegment(
        id="t1",
        speaker="A",
        source_start=5.5,
        source_end=6.25,
        text="hello world",
    )

    linked = link_transcripts_to_blocks(blocks, [transcript])
    mapped = map_transcript_to_timeline(blocks, linked[0])

    assert linked[0].block_id == "a1"
    assert mapped[0].start == 20.5
    assert mapped[0].end == 21.25
    assert mapped[0].text == "hello world"


def test_transcript_spanning_split_blocks_exports_two_edited_segments():
    blocks = [
        Block(id="a1", speaker="A", source_start=0.0, source_end=1.0, start=0.0),
        Block(id="a1-split", speaker="A", source_start=1.0, source_end=2.0, start=5.0),
    ]
    transcript = TranscriptSegment(
        id="t1",
        speaker="A",
        source_start=0.5,
        source_end=1.5,
        text="split sentence",
    )

    mapped = timeline_transcript_segments(blocks, [transcript])

    assert [(segment.start, segment.end) for segment in mapped] == [(0.5, 1.0), (5.0, 5.5)]


def test_srt_format_uses_edited_timestamps_and_speaker_labels():
    blocks = [Block(id="b1", speaker="B", source_start=0.0, source_end=1.0, start=3661.25)]
    transcript = TranscriptSegment(
        id="t1",
        speaker="B",
        source_start=0.0,
        source_end=1.0,
        text="caption text",
    )
    mapped = timeline_transcript_segments(blocks, [transcript])
    srt = segments_to_srt(mapped)

    assert seconds_to_srt_time(3661.25) == "01:01:01,250"
    assert "01:01:01,250 --> 01:01:02,250" in srt
    assert "B: caption text" in srt
