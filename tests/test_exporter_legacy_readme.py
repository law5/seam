"""旧名 podcast-prep 時代に書き出した README の互換。

`_is_own_readme` が旧マーカーを認識しないと、過去の書き出しフォルダへ
再書き出ししたとき自作 README を「他人のもの」と誤認して退避し続ける
（README_seam-2.txt, -3.txt … と積み上がる）。ユーザー自身のファイルを
守る判定が、そのまま自分のファイルを守りすぎる方向へ転ぶケース。
"""

from __future__ import annotations

from pathlib import Path

from podcast_prep.exporter import README_MARKER, _is_own_readme

LEGACY_MARKER = "# podcast-prep がこのファイルを自動生成しました"


def test_新マーカーのREADMEは自分のものと判定する(tmp_path: Path):
    p = tmp_path / "README.txt"
    p.write_text(f"{README_MARKER}\n本文\n", encoding="utf-8")
    assert _is_own_readme(p)


def test_旧マーカーのREADMEも自分のものと判定する(tmp_path: Path):
    """これが False になると退避が積み上がる。"""
    p = tmp_path / "README.txt"
    p.write_text(f"{LEGACY_MARKER}\n本文\n", encoding="utf-8")
    assert _is_own_readme(p), "旧名時代の README を他人のものと誤認している"


def test_旧マーカーでもBOM付きなら剥がして判定する(tmp_path: Path):
    p = tmp_path / "README.txt"
    p.write_text(f"﻿{LEGACY_MARKER}\n本文\n", encoding="utf-8")
    assert _is_own_readme(p)


def test_ユーザー自身のREADMEは他人のものと判定する(tmp_path: Path):
    """互換を足したせいで判定が緩みすぎていないこと。"""
    p = tmp_path / "README.txt"
    p.write_text("# 納品物について\n\nクライアント向けの説明\n", encoding="utf-8")
    assert not _is_own_readme(p)


def test_マーカーに似た別文字列は自分のものにしない(tmp_path: Path):
    p = tmp_path / "README.txt"
    p.write_text("# podcast-prep について書いたメモ\n", encoding="utf-8")
    assert not _is_own_readme(p)
