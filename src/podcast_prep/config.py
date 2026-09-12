from __future__ import annotations

import os
from pathlib import Path


APP_NAME = "podcast-prep"
DEFAULT_PORT = 4520


def data_dir() -> Path:
    return Path(os.environ.get("PODCAST_PREP_DATA_DIR", ".podcast_prep")).resolve()


def models_dir() -> Path:
    return data_dir() / "models"


def export_base_dir() -> Path | None:
    """追加で書き出しを許可するベースディレクトリ（Issue #18）。

    環境変数 `PODCAST_PREP_EXPORT_DIR` が設定されていれば resolve 済み Path、
    未設定・空文字なら None。None のときは従来どおり
    「プロジェクトの exports 配下」だけが許可ベースになる。

    ここで返すのは**許可の基準点**であって書き込み先そのものではない。
    実際の書き込み先は server._resolve_export_target が「このベース配下に
    収まること」を resolve() 後に検証したうえで決める（パストラバーサル防止）。
    """
    raw = os.environ.get("PODCAST_PREP_EXPORT_DIR", "").strip()
    if not raw:
        return None
    return Path(raw).expanduser().resolve()


def app_host() -> str:
    return os.environ.get("PODCAST_PREP_HOST", "127.0.0.1")


def app_port() -> int:
    return int(os.environ.get("PODCAST_PREP_PORT", str(DEFAULT_PORT)))
