"""テスト全体で環境変数の漏れ込みを断つ共通フィクスチャ。

`SEAM_EXPORT_DIR`（Issue #18）は開発者のシェルに設定されていることがあり、
設定の有無で `_resolve_export_target` の許可ベースが変わる。既定では未設定に
揃えて、必要なテストだけが monkeypatch.setenv で明示的に有効化する。

旧名 `PODCAST_PREP_*` も config.env() のフォールバック対象なので、同じように
断つ。新名だけ消しても、旧名を設定したままの開発者——つまり互換の対象者
そのもの——の手元でパストラバーサル防御のテストが偽の失敗を出す（QA指摘）。
"""

from __future__ import annotations

import pytest

from podcast_prep import registry

# config.env() が読む全キー。新旧そろえて隔離しないと漏れ込む。
_ENV_KEYS = (
    "DATA_DIR",
    "EXPORT_DIR",
    "HOST",
    "PORT",
    "WHISPER_LOCAL_ONLY",
    "WHISPER_DEVICE",
    "WHISPER_COMPUTE_TYPE",
)


@pytest.fixture(autouse=True)
def _clear_app_env(monkeypatch):
    """アプリが読む環境変数を新旧まとめて未設定に揃える。

    個々のテストは必要なものだけを monkeypatch.setenv で明示的に立てる。
    """
    for key in _ENV_KEYS:
        monkeypatch.delenv(f"SEAM_{key}", raising=False)
        monkeypatch.delenv(f"PODCAST_PREP_{key}", raising=False)


@pytest.fixture(autouse=True)
def _allow_testclient_host(monkeypatch, _clear_app_env):
    """Starlette TestClient は Host: testserver で送る（base_url の既定値）。

    `_clear_app_env` を要求して順序を固定する（先に消してから立てる）。

    Origin/Host 検証ミドルウェア（Issue #29）はループバック以外の Host を 403 に
    するため、テストでは「SEAM_HOST=testserver でバインドしている」扱いに
    して素通りさせる。本番の許可リストに testserver を焼き込まないための措置。
    ガード自体の検証（不正 Host → 403 等）は tests/test_origin_host_guard.py が
    この値を明示的に上書き・削除して行う。
    """
    monkeypatch.setenv("SEAM_HOST", "testserver")


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
