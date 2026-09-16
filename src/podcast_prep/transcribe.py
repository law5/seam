from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import uuid4

from .config import env, models_dir
from .models import ProjectState, SPEAKERS, TranscriptSegment
from .storage import resolve_project_file
from .timeline import link_transcripts_to_blocks, searchable_block_text

Progress = Callable[[float, str], None]

# セグメント進捗のemit間引き幅（全体進捗0..1スケール）
_PROGRESS_MIN_STEP = 0.005

# UI から選択できる Whisper モデルの許可リスト（Issue #12）。
# scripts/fetch_whisper_model.py の CLI は従来どおり任意名（large-v2 等）を受けるが、
# API 経由のダウンロードはこのリストに限定する。
WHISPER_MODEL_NAMES: tuple[str, ...] = ("tiny", "base", "small", "medium", "large-v3")

# ダウンロード進捗の概算に使う既知サイズ（bytes）。snapshot_download はコールバックを
# 持たないため、配置先ディレクトリの実サイズ / この概算値で 0..0.95 を報告する。
WHISPER_MODEL_APPROX_BYTES: dict[str, int] = {
    "tiny": 75 * 1024**2,
    "base": 145 * 1024**2,
    "small": 484 * 1024**2,
    "medium": int(1.5 * 1024**3),
    "large-v3": int(3.1 * 1024**3),
}


def whisper_model_dir(name: str) -> Path:
    """モデル名 → 配置先ディレクトリ（models_dir()/faster-whisper-{name}）。"""
    return models_dir() / f"faster-whisper-{name}"


def is_whisper_model_downloaded(name: str) -> bool:
    """配置済み判定: ディレクトリ存在 + model.bin 実在（部分DLを『済み』と誤認しない）。"""
    target = whisper_model_dir(name)
    return target.is_dir() and (target / "model.bin").is_file()


def dir_size_bytes(root: Path, *, include_inflight: bool = False) -> int:
    """ディレクトリ合計サイズ。huggingface_hub が作る .cache 配下は除外する。

    include_inflight=True のときだけ `.cache/huggingface/download/**/*.incomplete`
    （転送中の実体）を合算する。huggingface_hub は DL 中のバイトを配置先ではなく
    .cache 配下の .incomplete に書き、完了時に rename するため、これを数えないと
    転送量の大半を占める model.bin の進捗が最後まで 0 のままになる（QA指摘）。
    完了サイズの報告（GET /api/whisper/models の size_bytes）は従来どおり除外する。
    """
    total = 0
    if not root.is_dir():
        return 0
    for path in root.rglob("*"):
        if ".cache" in path.parts:
            if not (include_inflight and path.suffix == ".incomplete"):
                continue
        if path.is_file():
            total += path.stat().st_size
    return total


def whisper_model_size_bytes(name: str, *, include_inflight: bool = False) -> int:
    return dir_size_bytes(whisper_model_dir(name), include_inflight=include_inflight)


def download_whisper_model(model: str, target: Path | None = None) -> Path:
    """Systran/faster-whisper-{model} を target へ snapshot_download する。

    scripts/fetch_whisper_model.py と POST /api/whisper/models/download の共有実装。
    音声が外部送信されることはない。ダウンロードされるのはモデル重みのみ。
    中断後の再実行はレジュームされる（snapshot_download の既定挙動）。
    """
    from huggingface_hub import snapshot_download  # 遅延import（オフライン経路を汚さない）

    if target is None:
        target = whisper_model_dir(model)
    target.mkdir(parents=True, exist_ok=True)
    snapshot_download(repo_id=f"Systran/faster-whisper-{model}", local_dir=str(target))
    return target


def resolve_whisper_runtime(settings: dict[str, Any]) -> dict[str, str]:
    """WhisperModel 生成に使う device / compute_type を解決する。

    優先順位（device / compute_type それぞれ独立に適用）:
    1. settings の whisper_device / whisper_compute_type（"auto" 以外が明示設定されていれば最優先）
    2. 環境変数 SEAM_WHISPER_DEVICE / SEAM_WHISPER_COMPUTE_TYPE（旧 PODCAST_PREP_* も可）
    3. "auto"
    """

    def pick(settings_key: str, env_name: str) -> str:
        value = str(settings.get(settings_key) or "auto").strip() or "auto"
        if value != "auto":
            return value
        return env(env_name, "").strip() or "auto"

    return {
        "device": pick("whisper_device", "WHISPER_DEVICE"),
        "compute_type": pick("whisper_compute_type", "WHISPER_COMPUTE_TYPE"),
    }


def friendly_model_init_error(exc: Exception, device: str, compute_type: str) -> str | None:
    """WhisperModel 生成失敗を設定エラーとして説明できるなら日本語メッセージを返す。

    ctranslate2 は非対応 compute_type で ValueError（"... compute type ..."）を投げる。
    該当しない失敗（モデル破損等）は None を返し、呼び出し元が元エラーをそのまま流す。
    """
    text = str(exc)
    if "compute type" not in text and "compute_type" not in text:
        return None
    if compute_type == "float16":
        hint = "float16はCUDA環境専用です。"
    else:
        hint = f"計算精度 '{compute_type}' はこの環境（device={device}）では利用できません。"
    return f"設定エラー: {hint}文字起こし設定で変更してください。（詳細: {text}）"


def resolve_whisper_model(model_ref: str | None, settings: dict[str, Any]) -> str:
    """Whisperモデル参照をローカルパスへ解決する。

    実在するパスならそのまま、モデル名なら models_dir()/faster-whisper-{name} を探す。
    未配置なら scripts/fetch_whisper_model.py によるセットアップ手順へ誘導する。
    """
    ref = str(model_ref or settings.get("whisper_model", "medium"))
    if Path(ref).exists():
        return ref
    candidate = models_dir() / f"faster-whisper-{ref}"
    if candidate.exists():
        return str(candidate)
    if env("WHISPER_LOCAL_ONLY", "1") == "0":
        # オンライン利用を明示した場合のみ、モデル名を faster-whisper にそのまま委ねる
        return ref
    raise RuntimeError(
        f"Whisper model '{ref}' is not set up yet (expected at {candidate}).\n"
        "文字起こし設定パネルのモデル選択から、この場でダウンロードできます。\n"
        "Or download it once from a terminal:\n"
        f"  uv run python scripts/fetch_whisper_model.py --model {ref}\n"
        f"  (or: bash scripts/fetch_whisper_model.sh --model {ref})\n"
        "Only the model weights are downloaded; audio never leaves this machine.\n"
        "See the Whisper model setup section in README.md."
    )


def transcribe_project(
    project: ProjectState,
    model_name_or_path: str | None = None,
    progress: Progress | None = None,
) -> ProjectState:
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "faster-whisper is not installed. Run `uv sync` before transcribing."
        ) from exc

    def emit(value: float, message: str) -> None:
        if progress:
            progress(value, message)

    model_ref = resolve_whisper_model(model_name_or_path, project.settings)
    local_only = env("WHISPER_LOCAL_ONLY", "1") != "0"
    # device / compute_type の優先順位: settings（"auto"以外の明示設定が最優先）
    # → 環境変数 → "auto"（resolve_whisper_runtime の docstring 参照）
    runtime = resolve_whisper_runtime(project.settings)
    try:
        model = WhisperModel(model_ref, local_files_only=local_only, **runtime)
    except ValueError as exc:
        # 非対応 compute_type（CPUでfloat16等）は分かりやすい設定エラーへ変換して
        # ジョブ error に流す。それ以外の ValueError はそのまま
        friendly = friendly_model_init_error(exc, runtime["device"], runtime["compute_type"])
        if friendly:
            raise RuntimeError(friendly) from exc
        raise

    transcript_segments: list[TranscriptSegment] = []
    for speaker_idx, speaker in enumerate(SPEAKERS):
        track = project.tracks[speaker]
        wav_path = resolve_project_file(project.id, track.normalized_wav)
        # 話者ごとの進捗帯: A=0.05..0.50, B=0.50..0.95
        base = 0.05 + speaker_idx * 0.45
        emit(base, f"Transcribing speaker {speaker}")
        segments, _info = model.transcribe(
            str(wav_path),
            vad_filter=False,
            beam_size=5,
            # 単語タイムスタンプは必須: セグメントが VAD ブロック境界を跨いだとき、
            # timeline.map_transcript_to_timeline が単語中点でテキストを分割するのに使う
            word_timestamps=True,
        )
        last_emitted = base
        for idx, segment in enumerate(segments, start=1):
            if track.duration > 0:
                fraction = min(1.0, float(segment.end) / track.duration)
                value = base + fraction * 0.45
                if value - last_emitted >= _PROGRESS_MIN_STEP:
                    last_emitted = value
                    emit(value, f"Transcribing speaker {speaker} ({fraction:.0%})")
            text = " ".join(str(segment.text).split())
            if not text:
                continue
            words = [
                # word.word は生のまま保存（言語によっては先頭空白を含む。
                # 分配側が join 後に空白正規化する）
                {"start": float(word.start), "end": float(word.end), "text": str(word.word)}
                for word in (segment.words or [])
            ]
            transcript_segments.append(
                TranscriptSegment(
                    id=f"{speaker.lower()}-tr-{idx:05d}-{uuid4().hex[:8]}",
                    speaker=speaker,
                    source_start=float(segment.start),
                    source_end=float(segment.end),
                    text=text,
                    words=words,
                )
            )
    linked = link_transcripts_to_blocks(project.blocks, transcript_segments)
    project.transcripts = linked
    project.blocks = searchable_block_text(project.blocks, linked)
    project.status = "ready"
    emit(1.0, "Transcription complete")
    return project
