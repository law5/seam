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

    空文字を「未設定」と同じに倒すのは新旧そろって適用する。片方だけ素通り
    させると、`PODCAST_PREP_PORT=""` のような設定を持つ人——つまり互換が
    必要な人——だけが int("") で起動不能になる（QA指摘）。
    """
    value = os.environ.get(_ENV_PREFIX + name, "").strip()
    if value:
        return value
    return os.environ.get(_LEGACY_ENV_PREFIX + name, "").strip() or default


def _holds_data(path: Path) -> bool:
    """データディレクトリとして実際に使われているか（中身で判定する）。

    存在だけを見ると、空の `.seam` が実データの入った `.podcast_prep` を
    隠してしまう（削除はされないが、アプリからプロジェクトが消える）。
    `.DS_Store` 等のゴミ1個で「使用中」と誤判定しないよう、空かどうかでは
    なくアプリが書くものの有無で見る。
    """
    if not path.is_dir():
        return False
    if (path / "projects.json").exists():
        return True
    # models/ と projects/ は「中身があるか」ではなく実体の有無で見る。
    # iterdir 判定だと models/.DS_Store や projects/ 配下の空ディレクトリ1個で
    # 「使用中」と誤判定し、実データ入りの旧側が再び隠れる（QA指摘の残エッジ）。
    if any((path / "models").glob("*/model.bin")):
        return True
    return any((path / "projects").glob("*/project.json"))


def data_dir() -> Path:
    """Whisperモデルとプロジェクト一覧の置き場所。

    明示指定が無い場合の既定は `./.seam`。ただし旧名 `./.podcast_prep` に
    データがあって `./.seam` にはまだ無い場合は、見失わないよう旧側を使う。
    両方にデータがあるときは新側（明示的に移行した結果とみなす）。
    """
    configured = env("DATA_DIR", "").strip()
    if configured:
        return Path(configured).resolve()
    if _holds_data(Path(_LEGACY_DATA_DIR)) and not _holds_data(Path(_DEFAULT_DATA_DIR)):
        return Path(_LEGACY_DATA_DIR).resolve()
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
