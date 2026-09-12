"""作業フォルダとして許可できるパスの検証。

レジストリ（registry.py）は「記録係」であり、フォルダの妥当性判断は
しない。使ってよいかどうかの判断はすべてここに集約する。

拒否するのは2種類:

- **ルート直下**（`/` 自体と `/Applications` 等）: システム領域への誤指定は
  権限エラーや他アプリとの衝突を招くだけで、正当な用途がない
- **クラウド同期フォルダ**: プロジェクトは取込・正規化・書き出しで大きな
  中間 WAV を頻繁に書き換える。同期クライアントが書き込み途中のファイルを
  アップロードしたり、他デバイスの旧版で上書きしたりすると project.json や
  音源が静かに壊れる。壊れてから原因を特定するのは困難なので入口で断る

エラーメッセージはそのまま UI（toast）に出す前提の日本語で書く。
"""

from __future__ import annotations

from pathlib import Path


class WorkdirError(ValueError):
    """作業フォルダとして使えないパス。message はそのままUIに表示できる日本語。"""


def _cloud_roots() -> list[Path]:
    """クラウド同期の実体が置かれるルート群。テストは monkeypatch で差し替える。"""
    home = Path.home()
    return [
        # iCloud Drive の実体
        home / "Library" / "Mobile Documents",
        # macOS File Provider 配下（Dropbox / Google Drive / OneDrive 等の現行配置）
        home / "Library" / "CloudStorage",
        # File Provider 移行前のレガシー配置
        home / "Dropbox",
        home / "Google Drive",
    ]


def validate_workdir(raw: str) -> Path:
    """検証済みの resolve 済み絶対 Path を返す。不可なら WorkdirError。"""
    text = (raw or "").strip()
    if not text:
        raise WorkdirError("作業フォルダが指定されていません")
    expanded = Path(text).expanduser()
    if not expanded.is_absolute():
        # 相対パスはサーバの起動ディレクトリ依存で指す先が定まらない
        raise WorkdirError("作業フォルダは絶対パスで指定してください")
    resolved = expanded.resolve()
    if not resolved.exists():
        raise WorkdirError(
            f"フォルダが見つかりません: {resolved}。"
            "先に Finder でフォルダを作成してください"
        )
    if not resolved.is_dir():
        raise WorkdirError(f"フォルダではありません: {resolved}")
    if resolved == Path("/") or resolved.parent == Path("/"):
        raise WorkdirError(
            "ルート直下は作業フォルダにできません。ホーム以下のフォルダを選んでください"
        )
    for cloud_root in _cloud_roots():
        if resolved == cloud_root or cloud_root in resolved.parents:
            raise WorkdirError(
                "クラウド同期フォルダ（iCloud/Dropbox/Google Drive など）は"
                "作業フォルダにできません。同期がプロジェクトの中間ファイルを"
                "壊す恐れがあります"
            )
    return resolved
