"""テスト全体で環境変数の漏れ込みを断つ共通フィクスチャ。

`PODCAST_PREP_EXPORT_DIR`（Issue #18）は開発者のシェルに設定されていることがあり、
設定の有無で `_resolve_export_target` の許可ベースが変わる。既定では未設定に
揃えて、必要なテストだけが monkeypatch.setenv で明示的に有効化する。
"""

from __future__ import annotations

import pytest

from podcast_prep import registry


@pytest.fixture(autouse=True)
def _clear_export_base_env(monkeypatch):
    monkeypatch.delenv("PODCAST_PREP_EXPORT_DIR", raising=False)


@pytest.fixture(autouse=True)
def _allow_testclient_host(monkeypatch):
    """Starlette TestClient は Host: testserver で送る（base_url の既定値）。

    Origin/Host 検証ミドルウェア（Issue #29）はループバック以外の Host を 403 に
    するため、テストでは「PODCAST_PREP_HOST=testserver でバインドしている」扱いに
    して素通りさせる。本番の許可リストに testserver を焼き込まないための措置。
    ガード自体の検証（不正 Host → 403 等）は tests/test_origin_host_guard.py が
    この値を明示的に上書き・削除して行う。
    """
    monkeypatch.setenv("PODCAST_PREP_HOST", "testserver")


@pytest.fixture(autouse=True)
def _clear_registry_cache():
    """プロジェクトレジストリのインメモリキャッシュをテスト間で持ち越さない。

    キャッシュは data_dir をキーに持つので monkeypatch.setenv だけでも大半は
    分離されるが、同じ tmp_path を再利用するケースや mtime の分解能に依存する
    ケースが残る。二重防御として各テストの前後で捨てる。
    """
    registry.reset_cache()
    yield
    registry.reset_cache()
