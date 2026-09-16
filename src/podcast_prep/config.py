from __future__ import annotations

import os
from pathlib import Path


APP_NAME = "seam"
DEFAULT_PORT = 4520

# 旧名 podcast-prep 時代の環境変数・データディレクトリ名。
# 新名（SEAM_* / .seam）を正とし、未設定のときだけ旧名へフォールバックする。
# 既存の手元環境を静かに壊さないための互換であって、新しく書くものではない。
_LEGACY_ENV_PREFIX = "PODCAST_PREP_"
_ENV_PREFIX = "SEAM_"
_LEGACY_DATA_DIR = ".podcast_prep"
_DEFAULT_DATA_DIR = ".seam"


def env(name: str, default: str = "") -> str:
    """`SEAM_<name>` を読み、未設定なら旧名 `PODCAST_PREP_<name>` を読む。

    どちらも未設定・空文字なら default。name はプレフィックスを除いた部分
    （例: "HOST", "WHISPER_LOCAL_ONLY"）。
    """
    value = os.environ.get(_ENV_PREFIX + name, "").strip()
    if value:
        return value
    return os.environ.get(_LEGACY_ENV_PREFIX + name, default)


def data_dir() -> Path:
    """Whisperモデルとプロジェクト一覧の置き場所。

    明示指定が無い場合、既定は `./.seam`。ただし旧名 `./.podcast_prep` が
    既に存在してそちらにデータがある場合は、見失わないようそちらを使う。
    """
    configured = env("DATA_DIR", "").strip()
    if configured:
        return Path(configured).resolve()
    legacy = Path(_LEGACY_DATA_DIR)
    if legacy.is_dir() and not Path(_DEFAULT_DATA_DIR).exists():
        return legacy.resolve()
    return Path(_DEFAULT_DATA_DIR).resolve()


def models_dir() -> Path:
    return data_dir() / "models"


def export_base_dir() -> Path | None:
    """追加で書き出しを許可するベースディレクトリ（Issue #18）。

    環境変数 `SEAM_EXPORT_DIR`（旧 `PODCAST_PREP_EXPORT_DIR`）が設定されて
    いれば resolve 済み Path、未設定・空文字なら None。None のときは従来
    どおり「プロジェクトの exports 配下」だけが許可ベースになる。

    ここで返すのは**許可の基準点**であって書き込み先そのものではない。
    実際の書き込み先は server._resolve_export_target が「このベース配下に
    収まること」を resolve() 後に検証したうえで決める（パストラバーサル防止）。
    """
    raw = env("EXPORT_DIR", "").strip()
    if not raw:
        return None
    return Path(raw).expanduser().resolve()


def app_host() -> str:
    return env("HOST", "127.0.0.1")


def app_port() -> int:
    return int(env("PORT", str(DEFAULT_PORT)))
