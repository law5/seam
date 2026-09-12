#!/usr/bin/env python3
"""faster-whisper 用 CTranslate2 モデルを事前ダウンロードする（R4 / Issue #8）。

音声が外部送信されることはない。ダウンロードされるのはモデル重みのみ。
中断しても再実行すれば途中からレジュームされる。

使い方:
  uv run python scripts/fetch_whisper_model.py [--model medium] [--data-dir PATH]
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def _transcribe_module():
    """podcast_prep.transcribe を import する（DL実装・サイズ計算の共有元）。"""
    try:
        from podcast_prep import transcribe
    except ImportError:
        # uv 環境外から素の python3 で実行された場合のフォールバック
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
        from podcast_prep import transcribe
    return transcribe


def _format_size(num_bytes: int) -> str:
    if num_bytes >= 1024**3:
        return f"{num_bytes / 1024**3:.2f} GB"
    return f"{num_bytes / 1024**2:.1f} MB"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="faster-whisper (CTranslate2) モデルを事前ダウンロードする",
    )
    parser.add_argument(
        "--model",
        default="medium",
        help="モデル名（tiny / base / small / medium / large-v2 / large-v3 など。既定: medium）",
    )
    parser.add_argument(
        "--data-dir",
        default=None,
        help="データディレクトリの上書き（既定: PODCAST_PREP_DATA_DIR または ./.podcast_prep）",
    )
    args = parser.parse_args()

    if args.data_dir:
        os.environ["PODCAST_PREP_DATA_DIR"] = args.data_dir

    transcribe = _transcribe_module()

    try:
        import huggingface_hub  # noqa: F401
    except ImportError:
        print(
            "huggingface_hub が見つかりません。`uv sync` を実行してから再試行してください。",
            file=sys.stderr,
        )
        return 1

    repo_id = f"Systran/faster-whisper-{args.model}"
    target = transcribe.whisper_model_dir(args.model)
    target.mkdir(parents=True, exist_ok=True)

    print(f"ダウンロード: {repo_id}")
    print(f"配置先: {target}")
    print("注記: 音声が外部送信されることはありません。ダウンロードされるのはモデル重みのみです。")

    try:
        # API 側（POST /api/whisper/models/download）と同じ共有実装を使う
        transcribe.download_whisper_model(args.model, target)
    except KeyboardInterrupt:
        print("\n中断しました。再実行すれば途中からレジュームされます。", file=sys.stderr)
        return 130
    except Exception as exc:  # ネットワーク・リポジトリ名エラーなど
        print(f"ダウンロードに失敗しました: {exc}", file=sys.stderr)
        print(
            "モデル名を確認してください（例: tiny / base / small / medium / large-v2 / large-v3）。",
            file=sys.stderr,
        )
        print("再実行すれば途中からレジュームされます。", file=sys.stderr)
        return 1

    print(f"完了: {_format_size(transcribe.dir_size_bytes(target))} を {target} に配置しました。")
    print(f"アプリの whisper model 設定が '{args.model}' のままなら自動でこのモデルが使われます。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
