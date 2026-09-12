#!/usr/bin/env bash
# scripts/fetch_whisper_model.py の薄いラッパ（uv 経由で実行）
set -euo pipefail
cd "$(dirname "$0")/.."
exec uv run python scripts/fetch_whisper_model.py "$@"
