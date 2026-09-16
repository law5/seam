"""旧名 podcast-prep 時代に書き出した README の互換。

`_is_own_readme` が旧マーカーを認識しないと、過去の書き出しフォルダへ
再書き出ししたとき自作 README を「他人のもの」と誤認して退避し続ける
（README_seam-2.txt, -3.txt … と積み上がる）。ユーザー自身のファイルを
守る判定が、そのまま自分のファイルを守りすぎる方向へ転ぶケース。
"""

from __future__ import annotations

from pathlib import Path

from podcast_prep.exporter import README_MARKER, _is_own_readme, _readme_destination

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


# ── 退避先の選定 ──


def test_旧マーカーの退避ファイルを再利用する(tmp_path: Path):
    """旧名で書いた退避ファイルを他人扱いすると、隣に新名で積み上がる。"""
    (tmp_path / "README.txt").write_text("# 他人のREADME\n", encoding="utf-8")
    legacy_spill = tmp_path / "README_seam.txt"
    legacy_spill.write_text(f"{LEGACY_MARKER}\n旧世代\n", encoding="utf-8")
    assert _readme_destination(tmp_path) == legacy_spill


def test_飽和時は他人のファイルを潰さずNoneを返す(tmp_path: Path):
    """候補が全て他人のもので埋まったら README を書かない。

    以前は最後の候補（README_seam-99.txt）を無条件で返し、呼び出し側が
    そのまま write_text で他人のファイルを潰していた（QA指摘）。
    """
    (tmp_path / "README.txt").write_text("# 他人\n", encoding="utf-8")
    (tmp_path / "README_seam.txt").write_text("# 他人\n", encoding="utf-8")
    for n in range(2, 100):
        (tmp_path / f"README_seam-{n}.txt").write_text(f"# 他人 {n}\n", encoding="utf-8")

    assert _readme_destination(tmp_path) is None

    # 全ファイルが手つかずであること
    assert (tmp_path / "README.txt").read_text(encoding="utf-8") == "# 他人\n"
    assert (tmp_path / "README_seam-99.txt").read_text(encoding="utf-8") == "# 他人 99\n"


def test_飽和していても自分のファイルが1つあれば書ける(tmp_path: Path):
    """全部埋まっていても、自作のものが混じっていればそこへ書く。"""
    (tmp_path / "README.txt").write_text("# 他人\n", encoding="utf-8")
    (tmp_path / "README_seam.txt").write_text("# 他人\n", encoding="utf-8")
    for n in range(2, 100):
        body = f"{README_MARKER}\n" if n == 50 else f"# 他人 {n}\n"
        (tmp_path / f"README_seam-{n}.txt").write_text(body, encoding="utf-8")

    assert _readme_destination(tmp_path) == tmp_path / "README_seam-50.txt"
