"""旧名 podcast-prep からの移行互換（環境変数・データディレクトリ）。

新名 SEAM_* / .seam を正としつつ、旧名の設定が入っている手元環境を
静かに壊さないための互換を検証する。互換を外すときはこのテストごと
外すこと（テストが残っている限り、互換は意図的に維持されている）。
"""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest

import podcast_prep.config as config


@pytest.fixture
def fresh_config(monkeypatch: pytest.MonkeyPatch):
    """環境変数をまっさらにした config モジュールを返す。"""
    for key in list(config.os.environ):
        if key.startswith(("SEAM_", "PODCAST_PREP_")):
            monkeypatch.delenv(key, raising=False)
    return importlib.reload(config)


# ── 環境変数 ──


def test_旧名だけ設定されていれば旧名を読む(fresh_config, monkeypatch):
    monkeypatch.setenv("PODCAST_PREP_HOST", "192.168.1.50")
    monkeypatch.setenv("PODCAST_PREP_PORT", "9999")
    assert fresh_config.app_host() == "192.168.1.50"
    assert fresh_config.app_port() == 9999


def test_新旧そろっていれば新名が勝つ(fresh_config, monkeypatch):
    monkeypatch.setenv("SEAM_HOST", "10.0.0.1")
    monkeypatch.setenv("PODCAST_PREP_HOST", "192.168.1.50")
    assert fresh_config.app_host() == "10.0.0.1"


def test_新名が空文字なら旧名へ落ちる(fresh_config, monkeypatch):
    # 空文字は「未設定」と同じ扱い。空で上書きして旧名を殺さない
    monkeypatch.setenv("SEAM_HOST", "")
    monkeypatch.setenv("PODCAST_PREP_HOST", "192.168.1.50")
    assert fresh_config.app_host() == "192.168.1.50"


def test_どちらも未設定なら既定値(fresh_config):
    assert fresh_config.app_host() == "127.0.0.1"
    assert fresh_config.app_port() == fresh_config.DEFAULT_PORT


def test_旧名が空文字でも既定値へ倒す(fresh_config, monkeypatch):
    """空文字の扱いを新旧でそろえる。

    旧名だけ素通りさせると、`PODCAST_PREP_PORT=""` を持つ人——つまり互換が
    必要な当人——が int("") で起動不能になる（QA指摘）。
    """
    monkeypatch.setenv("PODCAST_PREP_HOST", "")
    monkeypatch.setenv("PODCAST_PREP_PORT", "")
    assert fresh_config.app_host() == "127.0.0.1"
    assert fresh_config.app_port() == fresh_config.DEFAULT_PORT  # ValueError にならないこと


def test_旧名が空白のみでも既定値へ倒す(fresh_config, monkeypatch):
    monkeypatch.setenv("PODCAST_PREP_PORT", "   ")
    assert fresh_config.app_port() == fresh_config.DEFAULT_PORT


@pytest.mark.parametrize(
    "name", ["WHISPER_LOCAL_ONLY", "WHISPER_DEVICE", "WHISPER_COMPUTE_TYPE"]
)
def test_whisper系の旧名も読む(fresh_config, monkeypatch, name):
    """transcribe.py が env() 経由であることを固定する。"""
    monkeypatch.setenv(f"PODCAST_PREP_{name}", "legacy-value")
    assert fresh_config.env(name) == "legacy-value"


def test_export_dir_も同じ互換で解決する(fresh_config, monkeypatch, tmp_path):
    monkeypatch.setenv("PODCAST_PREP_EXPORT_DIR", str(tmp_path))
    assert fresh_config.export_base_dir() == tmp_path.resolve()


# ── データディレクトリ ──


def test_まっさらな場所では_seam_が既定(fresh_config, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    assert fresh_config.data_dir().name == ".seam"


def _with_registry(root: Path) -> Path:
    """projects.json を持つ（= 実際に使われている）データディレクトリを作る。"""
    root.mkdir(parents=True, exist_ok=True)
    (root / "projects.json").write_text('{"p1": "/somewhere"}', encoding="utf-8")
    return root


def test_旧データディレクトリがあれば見失わない(fresh_config, monkeypatch, tmp_path):
    """旧名で運用していた作業フォルダを、新名の既定で上書きしない。"""
    monkeypatch.chdir(tmp_path)
    _with_registry(tmp_path / ".podcast_prep")
    assert fresh_config.data_dir() == (tmp_path / ".podcast_prep").resolve()


def test_空の新ディレクトリは実データを隠さない(fresh_config, monkeypatch, tmp_path):
    """存在だけで判定すると、空の .seam が実データの .podcast_prep を隠す。

    削除はされないがアプリからプロジェクトが消えるため、利用者からは
    データが失われたように見える（QA指摘）。
    """
    monkeypatch.chdir(tmp_path)
    _with_registry(tmp_path / ".podcast_prep")
    (tmp_path / ".seam").mkdir()  # 空
    assert fresh_config.data_dir() == (tmp_path / ".podcast_prep").resolve()


def test_モデルだけでも使用中と見なす(fresh_config, monkeypatch, tmp_path):
    """projects.json が無くても、Whisperモデルがあれば見失ってはいけない。"""
    monkeypatch.chdir(tmp_path)
    model = tmp_path / ".podcast_prep" / "models" / "faster-whisper-medium"
    model.mkdir(parents=True)
    (model / "model.bin").write_text("x", encoding="utf-8")
    (tmp_path / ".seam").mkdir()
    assert fresh_config.data_dir() == (tmp_path / ".podcast_prep").resolve()


def test_ゴミだけの旧ディレクトリは使用中にしない(fresh_config, monkeypatch, tmp_path):
    """`.DS_Store` 1個で「使用中」と誤判定して旧側に居座らない。"""
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".podcast_prep").mkdir()
    (tmp_path / ".podcast_prep" / ".DS_Store").write_text("junk", encoding="utf-8")
    assert fresh_config.data_dir() == (tmp_path / ".seam").resolve()


def test_両方にデータがあれば新しい方を使う(fresh_config, monkeypatch, tmp_path):
    """移行を済ませた利用者を旧側へ引き戻さない。"""
    monkeypatch.chdir(tmp_path)
    _with_registry(tmp_path / ".podcast_prep")
    _with_registry(tmp_path / ".seam")
    assert fresh_config.data_dir() == (tmp_path / ".seam").resolve()


def test_明示指定が最優先(fresh_config, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".podcast_prep").mkdir()
    explicit = tmp_path / "explicit"
    monkeypatch.setenv("SEAM_DATA_DIR", str(explicit))
    assert fresh_config.data_dir() == explicit.resolve()


def test_旧名の明示指定も効く(fresh_config, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    explicit = tmp_path / "legacy-explicit"
    monkeypatch.setenv("PODCAST_PREP_DATA_DIR", str(explicit))
    assert fresh_config.data_dir() == explicit.resolve()


def test_ファイルが同名で存在しても誤検出しない(fresh_config, monkeypatch, tmp_path):
    """`.podcast_prep` がディレクトリでなくファイルなら既定へ倒す。"""
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".podcast_prep").write_text("not a directory")
    assert fresh_config.data_dir().name == ".seam"
