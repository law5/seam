"""tests/js 用ゴールデンフィクスチャ生成。

現行 timeline.py（recompute_overlaps / map_transcript_to_timeline /
timeline_transcript_segments）を正として出力をJSON化し、JS実装
（static/js/timelineModel.js）の完全一致テストに使う。

実行: PYTHONPATH=src python3 tools/gen_js_fixtures.py
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from podcast_prep.models import Block, TranscriptSegment  # noqa: E402
from podcast_prep.timeline import (  # noqa: E402
    map_transcript_to_timeline,
    recompute_overlaps,
    timeline_transcript_segments,
)

FIXTURES_DIR = ROOT / "tests" / "js" / "fixtures"


def _seg_row(item: Any) -> dict[str, Any]:
    """TimelineSegment -> JS側 TimelineSegment 形（block_id -> blockId）。"""
    return {
        "id": item.id,
        "speaker": item.speaker,
        "start": item.start,
        "end": item.end,
        "text": item.text,
        "blockId": item.block_id,
    }


def _dump(name: str, payload: dict[str, Any]) -> None:
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    path = FIXTURES_DIR / name
    path.write_text(json.dumps(payload, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(ROOT)}")


def _overlaps_fixture(
    name: str, description: str, blocks: list[Block], min_overlap_s: float
) -> None:
    _dump(
        name,
        {
            "description": description,
            "min_overlap_s": min_overlap_s,
            "blocks": [b.to_dict() for b in blocks],
            "expected_overlaps": [o.to_dict() for o in recompute_overlaps(blocks, min_overlap_s)],
        },
    )


def _transcripts_fixture(
    name: str,
    description: str,
    blocks: list[Block],
    transcripts: list[TranscriptSegment],
) -> None:
    _dump(
        name,
        {
            "description": description,
            "blocks": [b.to_dict() for b in blocks],
            "transcripts": [t.to_dict() for t in transcripts],
            "expected_segments": [
                _seg_row(s) for s in timeline_transcript_segments(blocks, transcripts)
            ],
        },
    )


def gen_overlaps_basic() -> None:
    blocks = [
        Block(id="a-001", speaker="A", source_start=0.0, source_end=1.0, start=0.0),
        Block(id="a-002", speaker="A", source_start=10.0, source_end=11.5, start=2.0),
        Block(id="a-003", speaker="A", source_start=20.0, source_end=21.0, start=5.0, deleted=True),
        Block(id="a-004", speaker="A", source_start=30.0, source_end=30.0, start=6.0),  # zero-dur
        Block(id="a-005", speaker="A", source_start=40.0, source_end=41.0, start=8.0),
        Block(id="a-006", speaker="A", source_start=45.0, source_end=47.0, start=50.0),
        # 境界: 1.0 - 0.7 = 0.30000000000000004 >= 0.3 → 検出される側
        Block(id="b-001", speaker="B", source_start=0.0, source_end=1.5, start=0.7),
        # 0.75..1.0 = 0.25 → 閾値未満で除外
        Block(id="b-002", speaker="B", source_start=5.0, source_end=5.29, start=0.75),
        Block(id="b-003", speaker="B", source_start=6.0, source_end=9.0, start=2.5),
        Block(id="b-004", speaker="B", source_start=12.0, source_end=14.0, start=4.9, deleted=True),
        Block(id="b-005", speaker="B", source_start=15.0, source_end=16.0, start=8.2),
        Block(id="b-006", speaker="B", source_start=17.0, source_end=17.4, start=8.3),
        # (start, end) タイ順序の固定: a-006 と同時開始する2本（endで整列）
        Block(id="b-007", speaker="B", source_start=18.0, source_end=21.0, start=50.0),
        Block(id="b-008", speaker="B", source_start=22.0, source_end=23.0, start=50.0),
    ]
    _overlaps_fixture(
        "overlaps_basic.json",
        "deleted/zero-dur除外・0.3境界（fp両側）・(start,end)タイ順序・block_ids [A,B]順",
        blocks,
        0.3,
    )


def gen_overlaps_boundary() -> None:
    # 100.8 - 100.5 = 0.29999999999999716 < 0.3 → 「見かけ0.3ちょうど」でも除外される側
    blocks = [
        Block(id="a-001", speaker="A", source_start=0.0, source_end=0.8, start=100.0),
        Block(id="b-001", speaker="B", source_start=10.0, source_end=11.0, start=100.5),
        # 0.7 → 1.0: duration 0.30000000000000004 >= 0.3 → 検出
        Block(id="a-002", speaker="A", source_start=1.0, source_end=2.0, start=0.0),
        Block(id="b-002", speaker="B", source_start=12.0, source_end=13.0, start=0.7),
        # 完全一致区間: duration 2.0
        Block(id="a-003", speaker="A", source_start=3.0, source_end=5.0, start=200.0),
        Block(id="b-003", speaker="B", source_start=14.0, source_end=16.0, start=200.0),
    ]
    _overlaps_fixture(
        "overlaps_boundary.json",
        "min_overlap_s=0.3 境界の浮動小数点実挙動（PythonとJSで同一のIEEE754演算）",
        blocks,
        0.3,
    )


def _random_blocks(rng: random.Random) -> list[Block]:
    """話者ごとにソース範囲が互いに素な200ブロック（一部deleted/zero-dur）。"""
    blocks: list[Block] = []
    for speaker, prefix in (("A", "a"), ("B", "b")):
        src = 0.0
        for i in range(100):
            src += rng.uniform(0.05, 2.5)
            dur = rng.uniform(0.15, 6.0)
            source_start = round(src, 3)
            source_end = round(src + dur, 3)
            start = round(max(0.0, source_start + rng.uniform(-4.0, 4.0)), 3)
            deleted = rng.random() < 0.08
            if i % 37 == 5:
                source_end = source_start  # zero-duration → active除外
            blocks.append(
                Block(
                    id=f"{prefix}-{i:05d}",
                    speaker=speaker,
                    source_start=source_start,
                    source_end=source_end,
                    start=start,
                    deleted=deleted,
                )
            )
            src += dur
    return blocks


def _random_transcripts(rng: random.Random, blocks: list[Block]) -> list[TranscriptSegment]:
    transcripts: list[TranscriptSegment] = []
    for speaker, prefix in (("A", "a"), ("B", "b")):
        ends = [b.source_end for b in blocks if b.speaker == speaker]
        limit = max(ends) if ends else 0.0
        pos = 0.0
        i = 0
        while pos < limit:
            seg_len = rng.uniform(0.4, 5.0)
            s = round(pos + rng.uniform(0.0, 0.4), 3)
            e = round(s + seg_len, 3)
            transcripts.append(
                TranscriptSegment(
                    id=f"{prefix}-tr-{i:05d}",
                    speaker=speaker,
                    source_start=s,
                    source_end=e,
                    text=f"seg {prefix}{i}",
                )
            )
            pos = s + seg_len * rng.uniform(0.6, 1.1)  # 時々セグメント同士が重なる
            i += 1
    return transcripts


def _attach_random_words(rng: random.Random, transcripts: list[TranscriptSegment]) -> None:
    """2/3のセグメントに連続分割の単語列を付与（1/3はwords無しフォールバック経路を維持）。

    blocks/transcripts の乱数列に影響しないよう専用 rng を渡すこと。
    単語はセグメント範囲の連続分割なので、ブロック境界跨ぎ・ギャップ内中点（最近傍
    割当）・断片0単語のケースが自然に混ざる。
    """
    for i, seg in enumerate(transcripts):
        if i % 3 == 2:
            continue
        n = rng.randint(1, 6)
        bounds = sorted(
            round(rng.uniform(seg.source_start, seg.source_end), 3) for _ in range(n - 1)
        )
        edges = [seg.source_start, *bounds, seg.source_end]
        seg.words = [
            {"start": edges[k], "end": edges[k + 1], "text": f" w{k}"}
            for k in range(n)
        ]


def gen_random200() -> None:
    rng = random.Random(20260731)
    blocks = _random_blocks(rng)
    transcripts = _random_transcripts(rng, blocks)
    _attach_random_words(random.Random(20260801), transcripts)
    _dump(
        "random200.json",
        {
            "description": "ランダム200ブロック+文字起こし: overlaps/射影の網羅ゴールデン（seed 20260731）",
            "min_overlap_s": 0.3,
            "blocks": [b.to_dict() for b in blocks],
            "transcripts": [t.to_dict() for t in transcripts],
            "expected_overlaps": [o.to_dict() for o in recompute_overlaps(blocks, 0.3)],
            "expected_segments": [
                _seg_row(s) for s in timeline_transcript_segments(blocks, transcripts)
            ],
        },
    )


def gen_transcripts_moved() -> None:
    blocks = [
        Block(id="a-001", speaker="A", source_start=0.0, source_end=2.0, start=5.0),
        Block(id="a-002", speaker="A", source_start=3.0, source_end=4.5, start=0.5),  # 前後逆転移動
        Block(id="b-001", speaker="B", source_start=1.0, source_end=2.5, start=0.25),
    ]
    transcripts = [
        TranscriptSegment(id="a-tr-1", speaker="A", source_start=0.5, source_end=1.2, text="hello"),
        TranscriptSegment(id="a-tr-2", speaker="A", source_start=1.8, source_end=3.4, text="crosses blocks"),
        TranscriptSegment(id="a-tr-3", speaker="A", source_start=2.2, source_end=2.9, text="in no block"),
        TranscriptSegment(id="b-tr-1", speaker="B", source_start=0.9, source_end=2.6, text="b partial"),
    ]
    # a-tr-2 は移動後の2ブロックに割れ、タイムライン上で順序が逆転する
    assert len(map_transcript_to_timeline(blocks, transcripts[1])) == 2
    # a-tr-3 はどのブロックにも交差しない → 行なし
    assert map_transcript_to_timeline(blocks, transcripts[2]) == []
    _transcripts_fixture(
        "transcripts_moved.json",
        "移動後射影: ブロック順逆転・部分クリップ・ブロック外セグメント除外",
        blocks,
        transcripts,
    )


def gen_transcripts_split() -> None:
    blocks = [
        Block(id="a-001", speaker="A", source_start=10.0, source_end=12.3, start=100.0),
        Block(id="a-001-split-x", speaker="A", source_start=12.3, source_end=15.0, start=103.5),
        Block(id="b-001", speaker="B", source_start=0.0, source_end=1.0, start=101.0),
    ]
    transcripts = [
        TranscriptSegment(id="a-tr-1", speaker="A", source_start=11.5, source_end=13.2, text="spans the split"),
        TranscriptSegment(id="a-tr-2", speaker="A", source_start=10.2, source_end=10.9, text="left only"),
        TranscriptSegment(id="b-tr-1", speaker="B", source_start=0.2, source_end=0.8, text="b"),
    ]
    # 分割跨ぎセグメントは2行に割れる
    assert len(map_transcript_to_timeline(blocks, transcripts[0])) == 2
    _transcripts_fixture(
        "transcripts_split.json",
        "分割跨ぎ: 1セグメントが分割ブロック2つに割れる（行キー=segment.id+blockId）",
        blocks,
        transcripts,
    )


def gen_transcripts_deleted() -> None:
    blocks = [
        Block(id="a-001", speaker="A", source_start=0.0, source_end=2.0, start=0.0),
        Block(id="a-002", speaker="A", source_start=2.0, source_end=4.0, start=2.0, deleted=True),
        Block(id="a-003", speaker="A", source_start=4.0, source_end=6.0, start=4.0),
    ]
    transcripts = [
        TranscriptSegment(id="a-tr-1", speaker="A", source_start=1.0, source_end=3.0, text="partly deleted"),
        TranscriptSegment(id="a-tr-2", speaker="A", source_start=2.2, source_end=3.8, text="fully on deleted"),
        TranscriptSegment(id="a-tr-3", speaker="A", source_start=3.5, source_end=4.5, text="tail"),
    ]
    # deletedブロック上のテキストは行ごと消える
    assert map_transcript_to_timeline(blocks, transcripts[1]) == []
    _transcripts_fixture(
        "transcripts_deleted.json",
        "deleted除外: 削除ブロック上の行は消える・部分交差は残る",
        blocks,
        transcripts,
    )


def gen_transcripts_words() -> None:
    """words分配のゴールデン: 実バグ再現形（1セグメントが3ブロック跨ぎ）。

    - b-tr-1: 3ブロック跨ぎ+境界外中点の単語（最近傍断片へ）→ 各行に自分の単語のみ
    - b-tr-2: words無しの跨ぎ → 先頭断片にのみ全文（全行複製をやめたフォールバック）
    - a-tr-1: 単一ブロック内でwords有り → segment.text をそのまま使う
    - a-tr-2: 先頭空白つき英語words → join後の空白正規化
    """
    blocks = [
        Block(id="b-00097", speaker="B", source_start=269.0, source_end=270.4, start=269.0),
        Block(id="b-00098", speaker="B", source_start=270.9, source_end=271.8, start=270.9),
        Block(id="b-00099", speaker="B", source_start=272.2, source_end=273.5, start=272.2),
        Block(id="a-00001", speaker="A", source_start=0.0, source_end=2.0, start=10.0),
        Block(id="a-00002", speaker="A", source_start=5.0, source_end=6.0, start=20.0),
        Block(id="a-00003", speaker="A", source_start=6.0, source_end=7.0, start=40.0),
    ]
    transcripts = [
        TranscriptSegment(
            id="b-tr-1", speaker="B", source_start=269.68, source_end=273.08,
            text="はいでで行ってみて",
            words=[
                {"start": 269.68, "end": 270.1, "text": "はい"},
                # 中点270.6はギャップ内 → 最近傍のb-00097断片（dist 0.2 < 0.3）
                {"start": 270.3, "end": 270.9, "text": "で"},
                {"start": 271.0, "end": 271.4, "text": "で"},
                {"start": 272.3, "end": 273.08, "text": "行ってみて"},
            ],
        ),
        TranscriptSegment(
            id="b-tr-2", speaker="B", source_start=270.0, source_end=272.5,
            text="words無しの旧データ跨ぎ",
        ),
        TranscriptSegment(
            id="a-tr-1", speaker="A", source_start=0.2, source_end=1.8, text="single block",
            words=[
                {"start": 0.2, "end": 0.9, "text": " single"},
                {"start": 0.9, "end": 1.8, "text": " block"},
            ],
        ),
        TranscriptSegment(
            id="a-tr-2", speaker="A", source_start=5.5, source_end=6.6, text="hello world",
            words=[
                {"start": 5.5, "end": 5.9, "text": " hello"},
                {"start": 6.1, "end": 6.6, "text": " world"},
            ],
        ),
    ]
    rows = timeline_transcript_segments(blocks, transcripts)
    by_id: dict[str, list[str]] = {}
    for r in rows:
        by_id.setdefault(r.id, []).append(r.text)
    assert by_id["b-tr-1"] == ["はいで", "で", "行ってみて"]      # 複製ゼロ・全単語1回ずつ
    assert by_id["b-tr-2"] == ["words無しの旧データ跨ぎ", "", ""]  # フォールバック
    assert by_id["a-tr-1"] == ["single block"]                    # 単一断片は全文
    assert by_id["a-tr-2"] == ["hello", "world"]                  # 空白正規化
    _transcripts_fixture(
        "transcripts_words.json",
        "words分配: 3ブロック跨ぎ・境界外中点は最近傍・words無しは先頭断片のみ全文・空白正規化",
        blocks,
        transcripts,
    )


def main() -> None:
    gen_overlaps_basic()
    gen_overlaps_boundary()
    gen_random200()
    gen_transcripts_moved()
    gen_transcripts_split()
    gen_transcripts_deleted()
    gen_transcripts_words()


if __name__ == "__main__":
    main()
