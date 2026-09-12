from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import BackgroundTasks, Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .audio import (
    AudioProcessingError,
    convert_to_pcm,
    ffprobe_duration,
    generate_peak_bins,
    normalize_loudnorm,
    render_preview_segment,
)
from . import registry
from .config import APP_NAME, app_host, app_port, data_dir, export_base_dir
from .exporter import (
    BUNDLE_MODES,
    DEFAULT_BUNDLE_MODE,
    EXPORT_ARTIFACT_NAMES,
    EXPORT_FORMATS,
    export_project,
)
from .models import Block, ProjectState, SPEAKERS, Speaker, utc_now_iso
from .storage import (
    atomic_write_bytes,
    load_project,
    load_project_dict,
    project_dir,
    projects_root,
    resolve_project_file,
    resolve_sibling_file,
    save_project,
    save_project_dict,
)
from .timeline import (
    EPS,
    auto_tighten,
    blocks_from_vad,
    classify_overlaps,
    detect_silence_gaps,
    recompute_overlaps,
    searchable_block_text,
)
from .transcribe import (
    WHISPER_MODEL_APPROX_BYTES,
    WHISPER_MODEL_NAMES,
    download_whisper_model,
    is_whisper_model_downloaded,
    transcribe_project,
    whisper_model_dir,
    whisper_model_size_bytes,
)
from .vad import detect_speech_intervals
from .workdir import WorkdirError, validate_workdir

STATIC_DIR = Path(__file__).with_name("static")

app = FastAPI(title=APP_NAME)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# 静的ファイルは毎回サーバへ再検証させる（no-cache = 使う前に必ず条件付きGET。304で高速）。
# Cache-Control 無しだとブラウザのヒューリスティックキャッシュが UI 更新後も旧 index/JS/CSS を
# 平気で出し続け、「直したはずが直っていない」誤認を生むため（2026-08 UI改訂時に実際に発生）。
@app.middleware("http")
async def _static_no_cache(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# ---------------------------------------------------------------------------
# Origin/Host 検証（Issue #29 — QA #27 フォローアップ）
#
# CORS 未設定でも multipart POST 等の simple request は preflight されずに届くため、
# 悪意ある Web ページから 127.0.0.1:<port> へ状態変更リクエストを投げられる。
# CORSMiddleware の導入では防げない（あれは応答ヘッダを足すだけで simple request
# の到達自体は止めない）ので、明示的に検査する:
#
#   - Host（全メソッド対象）: ループバック表記（127.0.0.1 / localhost / ::1）と
#     PODCAST_PREP_HOST のバインド先以外は 403。DNS rebinding は応答が**読める**
#     攻撃なので GET も対象に含める。
#   - Origin（状態変更系 = GET/HEAD/OPTIONS 以外のみ）: Origin ヘッダが付いていて
#     このサーバ自身のオリジンでなければ 403。Origin が無いリクエスト
#     （curl / CLI / 同一オリジンの一部ケース）は通す — ブラウザ発のクロス
#     オリジンだけを断ち、API 利用を壊さないため（Issue #29 の方針）。

_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
_LOOPBACK_HOSTNAMES = frozenset({"127.0.0.1", "localhost", "::1"})

_HOST_GUARD_DETAIL = "不正な Host ヘッダのリクエストは受け付けません（DNS rebinding 対策）"
_ORIGIN_GUARD_DETAIL = "別のサイトからのリクエストは受け付けません"


def _guard_hostnames() -> frozenset[str]:
    """許可する Host のホスト名部分（小文字）。

    ループバック表記に加え、PODCAST_PREP_HOST で別バインドが設定されていれば
    それも許可する（config.app_host() と整合）。0.0.0.0 / :: は「全インター
    フェースにバインドせよ」という指定であって、クライアントが Host に載せて
    くる正規の名前ではないため加えない。
    """
    names = set(_LOOPBACK_HOSTNAMES)
    bound = app_host().strip().lower().strip("[]")
    if bound and bound not in ("0.0.0.0", "::"):
        names.add(bound)
    return frozenset(names)


def _split_host_header(value: str) -> tuple[str, str | None] | None:
    """Host ヘッダを (ホスト名小文字, ポート文字列 | None) に分解する。

    不正な形式（空・ブラケット無しの生 IPv6・数字でないポート等）は None。
    """
    value = value.strip().lower()
    if value.startswith("["):  # IPv6 リテラル（例: "[::1]:4520"）
        end = value.find("]")
        if end < 0:
            return None
        host, rest = value[1:end], value[end + 1 :]
    else:
        if value.count(":") > 1:
            return None
        host, sep, port = value.partition(":")
        rest = f":{port}" if sep else ""
    if not host:
        return None
    if not rest:
        return host, None
    if rest.startswith(":") and rest[1:].isdigit():
        return host, rest[1:]
    return None


def _host_header_ok(host_header: str | None) -> bool:
    if host_header is None:
        return False
    parsed = _split_host_header(host_header)
    if parsed is None:
        return False
    host, port = parsed
    if host not in _guard_hostnames():
        return False
    # ポート付きなら実際のバインドポートと一致すること（ポート無しは許容:
    # Starlette TestClient や既定ポートの CLI クライアントが該当）
    return port is None or port == str(app_port())


def _allowed_origins() -> frozenset[str]:
    """状態変更リクエストで許可する Origin（サーバ自身のオリジンのみ）。"""
    port = app_port()
    origins: set[str] = set()
    for name in _guard_hostnames():
        host = f"[{name}]" if ":" in name else name
        origins.add(f"http://{host}:{port}")
        if port == 80:  # 既定ポートではブラウザの Origin がポートを省く
            origins.add(f"http://{host}")
    return frozenset(origins)


@app.middleware("http")
async def _origin_host_guard(request, call_next):
    if not _host_header_ok(request.headers.get("host")):
        return JSONResponse(status_code=403, content={"detail": _HOST_GUARD_DETAIL})
    if request.method.upper() not in _SAFE_METHODS:
        origin = request.headers.get("origin")
        if origin is not None and origin.strip().lower() not in _allowed_origins():
            # "null"（サンドボックス iframe 等）や外部サイトはここで落ちる
            return JSONResponse(
                status_code=403, content={"detail": _ORIGIN_GUARD_DETAIL}
            )
    return await call_next(request)


_jobs: dict[str, dict[str, Any]] = {}
_job_lock = threading.Lock()

# 完了ジョブの間引き（インメモリ dict の無限成長防止）: 完了/失敗から1時間、
# または完了ジョブが直近50件を超えた分を新規ジョブ作成時に削除する。
JOB_RETENTION_S = 3600.0
JOB_KEEP_FINISHED = 50


def _prune_finished_jobs_locked() -> None:
    """_job_lock 保持中に呼ぶ。running のジョブは絶対に消さない。"""
    now = time.time()
    finished = [j for j in _jobs.values() if j["status"] in ("complete", "error")]
    finished.sort(key=lambda j: j.get("finished_at") or 0.0, reverse=True)
    for index, job in enumerate(finished):
        finished_at = job.get("finished_at") or 0.0
        if index >= JOB_KEEP_FINISHED or now - finished_at > JOB_RETENTION_S:
            _jobs.pop(job["id"], None)


def _new_job(kind: str, project_id: str) -> dict[str, Any]:
    job = {
        "id": uuid4().hex,
        "kind": kind,
        "project_id": project_id,
        "status": "running",
        "progress": 0.0,
        "message": "Queued",
        "result": None,
        "error": None,
        "created_at": time.time(),
    }
    with _job_lock:
        _prune_finished_jobs_locked()
        _jobs[job["id"]] = job
    return job


def _update_job(
    job_id: str,
    *,
    progress: float | None = None,
    message: str | None = None,
    status: str | None = None,
    result: Any | None = None,
    error: str | None = None,
) -> None:
    with _job_lock:
        job = _jobs[job_id]
        if progress is not None:
            job["progress"] = max(0.0, min(1.0, float(progress)))
        if message is not None:
            job["message"] = message
        if status is not None:
            job["status"] = status
            if status in ("complete", "error"):
                job["finished_at"] = time.time()
        if result is not None:
            job["result"] = result
        if error is not None:
            job["error"] = error


def _load_project_or_404(project_id: str) -> ProjectState:
    try:
        return load_project(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="project not found") from None


# クライアント文書由来の project id の許容形式（QA指摘: '..' で 500、'.'/'' で
# projects ルート直下に project.json が書かれるレイアウト破壊の防止）
_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _require_valid_project_id(project_id: Any) -> str:
    if not isinstance(project_id, str) or not _PROJECT_ID_RE.fullmatch(project_id):
        raise HTTPException(
            status_code=400,
            detail="invalid project id (allowed: 1-64 chars of A-Za-z0-9_-)",
        )
    return project_id


def _resolve_track_file_or_404(project_id: str, value: str, detail: str) -> Path:
    """トラック相対パスをプロジェクト配下に解決し、不正・不在は 404 に正規化する。

    永続化文書の normalized_wav にトラバーサル値が入っていても 500 にしない
    （_ensure_within の ValueError → 404。拒否自体は storage 側で機能している）。
    """
    try:
        path = resolve_project_file(project_id, value)
    except ValueError:
        raise HTTPException(status_code=404, detail=detail) from None
    if not path.is_file():
        raise HTTPException(status_code=404, detail=detail)
    return path


def _safe_name(value: str, fallback: str) -> str:
    name = Path(value or fallback).name
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name)
    return name or fallback


# 取込を許可する音声拡張子（ffmpeg のデコーダが標準ビルドで扱える一般的な形式）。
# 許可リスト方式にしているのは、original_file が project.json に載ってサーバ側の
# パス組み立て（_prepare_track_audio の pdir / track.original_file）へ流れるため。
# 未知拡張子や拡張子なしは黙って通さず、話者既定名（.wav）へ倒す。
ALLOWED_AUDIO_EXTS = frozenset({".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aiff", ".aif"})

# 拡張子が取れなかった / 許可外だったときの既定名。ffmpeg は拡張子ではなく
# 中身（コンテナのマジック）で判定するので、既定名で保存しても変換は成立する。
DEFAULT_UPLOAD_NAME = {"A": "speakerA.wav", "B": "speakerB.wav"}

# パイプラインが生成する派生物の名前。アップロード名として使われると
# ffmpeg の入力と出力が同一パスになり in-place 編集拒否で詰むため予約する。
RESERVED_UPLOAD_NAMES = frozenset(f"speaker{speaker}_normalized.wav" for speaker in SPEAKERS)

# 取込パイプラインが project_dir **直下に固定名・無条件で**書く派生物の全名。
# 出所: _prepare_track_audio が speaker{X}_normalized.wav（ffmpeg -y で既存を上書き）、
# _write_peaks_sidecar が speaker{X}_peaks.u8。exports/ 等のサブフォルダ配下と
# project.json（専用ガードで復元へ誘導）はここに含めない。
# workdir 指定の新規取込では、選んだフォルダにこれらと同名の既存ファイルが
# あると取込が黙って上書きするため、create_project が事前に 400 で断る。
# RESERVED_UPLOAD_NAMES はこの部分集合（peaks.u8 は拡張子が ALLOWED_AUDIO_EXTS 外
# なので _safe_audio_name の許可リストで既に fallback へ倒れる = 予約不要）。
RESERVED_ARTIFACT_NAMES = RESERVED_UPLOAD_NAMES | frozenset(
    f"speaker{speaker}_peaks.u8" for speaker in SPEAKERS
)


def _safe_audio_name(value: str, fallback: str) -> str:
    """アップロード音声のファイル名を、サニタイズ + 拡張子許可リストで正規化する。

    サニタイズは _safe_name と同一（パス区切り除去 + [A-Za-z0-9._-] 以外を _ に）。
    そのうえで拡張子が ALLOWED_AUDIO_EXTS に無ければ fallback（話者既定名）へ倒す。
    拡張子だけのファイル名（".wav"）は Path.suffix が空になるため fallback 扱い。

    さらにパイプラインが生成する派生物の名前（speakerX_normalized.wav）は予約語として
    fallback へ倒す。これを許すと original_file と ffmpeg の出力先が同一パスになり、
    ffmpeg が in-place 編集を拒否して取込・後がけ正規化とも永久に失敗する。
    """
    name = _safe_name(value, fallback)
    if Path(name).suffix.lower() not in ALLOWED_AUDIO_EXTS:
        return fallback
    if name in RESERVED_UPLOAD_NAMES:
        return fallback
    return name


# アップロード上限（90分×2トラックの音声を想定。1ファイル2GBで十分な余裕）
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024


async def _save_upload(upload: UploadFile, dest: Path) -> Path:
    """アップロードを一時名にステージし、その一時パスを返す（dest には書かない）。

    最終名への配置は呼び出し側が `os.replace(temp, dest)` で行う。dest と
    **同じディレクトリ**にステージするのは、os.replace が同一ファイルシステム内
    でだけ安全（アトミックな rename）だから。作業フォルダがユーザー選択制に
    なった（PR #27）ため、dest がユーザーの既存ファイルと同名になり得る —
    直接 dest へ書くと失敗時に元音源を truncate・削除してしまう。
    失敗（サイズ超過 413 等）時に消すのは自分の一時ファイルだけ。
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = dest.parent / f".upload-{uuid4().hex}.part"
    total = 0
    try:
        with temp.open("wb") as handle:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413, detail="uploaded file exceeds size limit"
                    )
                handle.write(chunk)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    return temp


def _available_upload_name(pdir: Path, name: str, speaker: Speaker, taken: set[str]) -> str:
    """既存ファイルを上書きしない取込先ファイル名を決める。

    作業フォルダに素材が既にある場合（素材フォルダ自体を workdir に選んで
    その中の音声をドラッグした等）、アップロード名がそのまま既存ファイルに
    衝突する。優先順: 元の名前 → speaker{X}{suffix} → speaker{X}-{n}{suffix}。
    従来配置（新規UUIDフォルダ）では衝突が起きないので挙動は変わらない。
    `taken` は同一リクエスト内で先に確定した相方の名前（まだディスクに無い）。
    """
    suffix = Path(name).suffix
    candidates = [name, f"speaker{speaker}{suffix}"]
    for candidate in candidates:
        if candidate not in taken and not (pdir / candidate).exists():
            return candidate
    n = 1
    while True:
        candidate = f"speaker{speaker}-{n}{suffix}"
        if candidate not in taken and not (pdir / candidate).exists():
            return candidate
        n += 1


def _prepare_track_audio(
    project: ProjectState,
    speaker: Speaker,
    job_id: str,
    *,
    normalize: bool,
    progress_base: float,
    progress_span: float,
    message_base: str,
) -> Path:
    """original_file → normalized_wav を作り、track の loudness 状態を更新する。

    normalize=True は loudnorm 3パス、False は convert_to_pcm の形式変換のみ
    （どちらも 48kHz/mono/s16 を出す）。進捗は
    progress_base..progress_base+progress_span の帯へ線形マップする。
    取込（_run_import）と後がけ（_run_normalize）で共有する。
    """
    pdir = project_dir(project.id)
    track = project.tracks[speaker]
    # original_file は永続化文書由来なので、必ず封じ込めを通す。
    # `pdir / track.original_file` の直結だと `PUT /api/projects/{id}/raw` で
    # `"../../../etc/passwd"` のような値を書き込めてしまい、ffmpeg がプロジェクト外の
    # ファイルを読んで WAV に変換し、`GET /audio` から取り出せる（実証済み）。
    # 取込経路は _safe_audio_name でサニタイズ済みだが、raw 更新はそこを通らない。
    try:
        original = resolve_project_file(project.id, track.original_file)
    except ValueError:
        raise AudioProcessingError(
            f"話者 {speaker} の元音源の参照が不正です: {track.original_file!r}"
        ) from None
    normalized = pdir / f"speaker{speaker}_normalized.wav"

    def stage_progress(fraction: float) -> None:
        pct = f"{max(0.0, min(1.0, fraction)):.0%}"
        _update_job(
            job_id,
            progress=progress_base + progress_span * max(0.0, min(1.0, fraction)),
            message=f"{message_base} for speaker {speaker} ({pct})",
        )

    if normalize:
        _update_job(
            job_id,
            progress=progress_base,
            message=f"Analyzing loudness for speaker {speaker}",
        )
        loudness = normalize_loudnorm(
            original,
            normalized,
            target_i=float(project.settings["target_lufs"]),
            true_peak=float(project.settings["true_peak"]),
            lra=float(project.settings["lra"]),
            # 許容量(LU): 目標±以内なら loudnorm をスキップ（Issue #37）。
            # 旧 project.json は from_dict のデフォルトマージで必ず持つが、二重防御で .get
            tolerance=float(project.settings.get("tolerance", 0.5)),
            progress=stage_progress,
        )
    else:
        _update_job(
            job_id,
            progress=progress_base,
            message=f"Converting audio for speaker {speaker}",
        )
        loudness = convert_to_pcm(
            original,
            normalized,
            sample_rate=int(project.settings.get("sample_rate", 48000)),
            progress=stage_progress,
        )
    track.normalized_wav = normalized.name
    track.duration = ffprobe_duration(normalized)
    track.loudness = loudness
    track.loudness_normalized = bool(normalize)
    return normalized


def _write_peaks_sidecar(project: ProjectState, speaker: Speaker, source: Path) -> None:
    # ピークは project.json でなくサイドカー（PPK1 バイナリ）に保存する。
    # track.peaks は常に空のまま（GET /peaks がサイドカーを配信）。
    atomic_write_bytes(
        project_dir(project.id) / f"speaker{speaker}_peaks.u8",
        generate_peak_bins(
            source,
            bins_per_sec=int(project.settings.get("peaks_bins_per_sec", 200)),
        ),
    )


def _run_import(project_id: str, job_id: str, normalize: bool = True) -> None:
    try:
        project = load_project(project_id)
        all_blocks = []
        for index, speaker in enumerate(SPEAKERS):
            track = project.tracks[speaker]
            base = index * 0.45
            normalized = _prepare_track_audio(
                project,
                speaker,
                job_id,
                normalize=normalize,
                # loudnorm 全体(0..1)を話者ごとの進捗帯 base+0.02..base+0.26 に線形マップ
                progress_base=base + 0.02,
                progress_span=0.24,
                message_base="Normalizing loudness" if normalize else "Converting audio",
            )
            _update_job(job_id, progress=base + 0.26, message=f"Running VAD for speaker {speaker}")
            intervals = detect_speech_intervals(
                normalized,
                aggressiveness=int(project.settings.get("vad_aggressiveness", 2)),
            )
            all_blocks.extend(
                blocks_from_vad(
                    speaker,
                    intervals,
                    offset_seconds=track.offset_seconds,
                    id_prefix=speaker.lower(),
                )
            )
            _update_job(job_id, progress=base + 0.36, message=f"Building peaks for speaker {speaker}")
            _write_peaks_sidecar(project, speaker, normalized)

        project.blocks = sorted(all_blocks, key=lambda block: (block.start, block.speaker))
        project.overlaps = recompute_overlaps(
            project.blocks,
            min_duration=float(project.settings.get("min_overlap_s", 0.3)),
        )
        project.status = "ready"
        save_project(project)
        _update_job(
            job_id,
            progress=1.0,
            status="complete",
            message="Import complete",
            result={"project": _project_payload(project)},
        )
    except Exception as exc:  # pragma: no cover - exercised through manual app runs
        try:
            project = load_project(project_id)
            project.status = "error"
            save_project(project)
        except Exception:
            pass
        _update_job(job_id, status="error", error=str(exc), message="Import failed")


def _run_normalize(
    project_id: str,
    job_id: str,
    speakers: list[Speaker],
    normalize: bool,
    overrides: dict[str, float],
) -> None:
    """後がけラウドネス正規化（L）。元音源から normalized_wav を作り直す。

    不変条件: **ブロック（VAD区間）は再計算しない**。loudnorm も convert_to_pcm も
    時間軸を変えない（尺・サンプル位置は保存される）ため、blocks/transcripts/overlaps
    は元のまま保持する。作り直すのは normalized_wav とピークサイドカーだけ。
    normalize=False は「正規化を解除して元に戻す」経路（素の形式変換で作り直す）。
    """
    try:
        project = load_project(project_id)
        for key, value in overrides.items():
            project.settings[key] = value
        span = 1.0 / max(1, len(speakers))
        for index, speaker in enumerate(speakers):
            track = project.tracks[speaker]
            if not track.original_file:
                raise AudioProcessingError(
                    f"話者 {speaker} の元音源がありません。"
                    "ラウドネスをかけ直すには、元の音声ファイルを含めて開き直してください"
                )
            base = index * span
            normalized = _prepare_track_audio(
                project,
                speaker,
                job_id,
                normalize=normalize,
                progress_base=base,
                progress_span=span * 0.85,
                message_base="Normalizing loudness" if normalize else "Converting audio",
            )
            _update_job(
                job_id,
                progress=base + span * 0.85,
                message=f"Building peaks for speaker {speaker}",
            )
            _write_peaks_sidecar(project, speaker, normalized)
        # 保存直前にディスクを読み直し、音声系フィールドだけを最新文書へマージする。
        # ジョブは数分かかるため、開始時スナップショットを全体書き戻しすると
        # その間のユーザー編集（分割・削除・移動の autosave PUT）が消える（lost update）。
        # 時間軸は不変なので blocks/transcripts/overlaps は最新側を正とする。
        try:
            latest = load_project(project_id)
        except FileNotFoundError:
            latest = project
        for speaker in speakers:
            source = project.tracks[speaker]
            target = latest.tracks[speaker]
            target.normalized_wav = source.normalized_wav
            target.duration = source.duration
            target.loudness = source.loudness
            target.loudness_normalized = source.loudness_normalized
        for key, value in overrides.items():
            latest.settings[key] = value
        project = latest
        save_project(project)
        _update_job(
            job_id,
            progress=1.0,
            status="complete",
            message="Normalize complete" if normalize else "Normalization removed",
            result={"project": _project_payload(project)},
        )
    except Exception as exc:
        _update_job(job_id, status="error", error=str(exc), message="Normalize failed")


def _run_transcribe(project_id: str, job_id: str, model: str | None) -> None:
    try:
        project = load_project(project_id)

        def progress(value: float, message: str) -> None:
            _update_job(job_id, progress=value, message=message)

        project = transcribe_project(project, model_name_or_path=model, progress=progress)
        project.overlaps = recompute_overlaps(
            project.blocks,
            min_duration=float(project.settings.get("min_overlap_s", 0.3)),
        )
        save_project(project)
        _update_job(
            job_id,
            progress=1.0,
            status="complete",
            message="Transcription complete",
            result={"project": _project_payload(project)},
        )
    except Exception as exc:  # pragma: no cover - exercised through manual app runs
        _update_job(job_id, status="error", error=str(exc), message="Transcription failed")


def _is_within(base: Path, target: Path) -> bool:
    """target が base 配下（または base 自身）か。両者とも resolve 済みであること。"""
    return target == base or base in target.parents


# ユーザーが OS のフォルダ選択ダイアログで**実際に選んだ**フォルダ。
# POST /api/system/choose_folder が成功したときだけ積まれる（プロセス内メモリのみ・
# 再起動で消える。永続化すると「一度選んだ場所が恒久的に書き込み可能」になってしまう）。
#
# これを許可ベースに加えるのは、ネイティブのフォルダ選択ダイアログが
# **ブラウザ側から偽装できない同意の証跡**だから。悪意あるページが localhost を
# 叩いてダイアログを開かせることはできても、ユーザーが「選択」を押さない限り
# ここには何も積まれない。逆に言えば、ユーザーが自分で選んだ場所へ書けないのでは
# 「finderで出力先指定したい」という要望自体が満たせない。
#
# 無制限に増やさないよう上限を設け、古いものから捨てる。
_chosen_dirs: list[Path] = []
_chosen_dirs_lock = threading.Lock()
CHOSEN_DIR_MAX = 16


def _remember_chosen_dir(path: Path) -> None:
    with _chosen_dirs_lock:
        resolved = path.resolve()
        if resolved in _chosen_dirs:
            _chosen_dirs.remove(resolved)
        _chosen_dirs.append(resolved)
        del _chosen_dirs[:-CHOSEN_DIR_MAX]


def _chosen_dir_bases() -> list[Path]:
    with _chosen_dirs_lock:
        return list(_chosen_dirs)


def _resolve_export_target(project_id: str, output_dir: str | None) -> Path:
    """エクスポート先を**許可されたベース配下**に限定して解決する（Issue #18）。

    許可ベースは3つ:
      1. プロジェクトの `exports/`（常に許可・既定）
      2. `PODCAST_PREP_EXPORT_DIR`（設定されているときだけ）
      3. ユーザーがフォルダ選択ダイアログで**実際に選んだ**フォルダ（`_chosen_dirs`）

    受け付け方:
    - 未指定 → `exports/` 直下（Issue #28 で `latest` サブフォルダを廃止。
      「毎回上書き」の意味論は従来と同じ）
    - **絶対パス** → 許可ベースのいずれかの配下ならそのまま採用。どちらの配下でも
      なければ ValueError（400）。これが Issue #18 で追加した唯一の緩和で、
      「任意の絶対パスを通す」ようにはしていない
    - **相対パス／ラベル** → 従来どおりパス区切りを剥がしたラベルとして
      `exports/<label>` に封じ込める（後方互換。'..' や '/etc' はラベル化されて無害）

    包含判定は必ず resolve() 後に行う。シンボリックリンクも実体まで潰してから
    判定するので、許可ベース内に外部を指すリンクを置いても脱出できない。
    """
    exports_base = (project_dir(project_id) / "exports").resolve()
    configured_base = export_base_dir()
    allowed_bases = [exports_base]
    if configured_base is not None:
        allowed_bases.append(configured_base)
    allowed_bases.extend(_chosen_dir_bases())

    raw = str(output_dir).strip() if output_dir else ""
    if raw and Path(raw).expanduser().is_absolute():
        # 絶対パス指定: 許可ベース配下かを resolve 後に検証する。
        # 未作成のパスでも strict=False の resolve で正規化できる（'..' も潰れる）。
        target = Path(raw).expanduser().resolve()
        if not any(_is_within(base, target) for base in allowed_bases):
            raise ValueError("export target escapes allowed export directories")
        return target

    if not raw:
        target = exports_base
    else:
        label = Path(raw).name  # パス区切りを剥がしてラベル化
        if not label or label in (".", ".."):
            # ラベルに実質が無い入力は未指定と同じ扱い（exports 直下）
            target = exports_base
        else:
            target = exports_base / label
    target = target.resolve()
    if not _is_within(exports_base, target):
        raise ValueError("export target escapes project exports directory")
    if target.exists() and not target.is_dir():
        # 成果物と同名のラベル（例 "speakerA.wav"）を指定すると exports/<label> が
        # 既定エクスポートの残した**ファイル**を指し、mkdir の FileExistsError が
        # ジョブ error に生メッセージで漏れていた（QA指摘）。ここで断れば
        # start_export の事前検証が 400 + この日本語 detail をそのまま返す。
        raise ValueError(
            "出力先名が既存のファイルと重なっています。別の名前を指定してください"
        )
    return target


def _export_targets(project_id: str) -> list[dict[str, Any]]:
    """UI の出力先プルダウン用の選択肢（GET /api/export/targets）。

    未設定時は「プロジェクト内」1件だけを返す。
    """
    targets: list[dict[str, Any]] = [
        {
            "label": "プロジェクト内",
            "path": str((project_dir(project_id) / "exports").resolve()),
            "is_default": True,
        }
    ]
    configured = export_base_dir()
    if configured is not None:
        targets.append(
            {
                # 環境変数名は UI に出さない（Issue #32）
                "label": "設定済みの書き出し先",
                "path": str(configured),
                "is_default": False,
            }
        )
    return targets


def _run_export(
    project_id: str,
    job_id: str,
    output_dir: str | None,
    export_format: str,
    bundle: str = DEFAULT_BUNDLE_MODE,
) -> None:
    try:
        project = load_project(project_id)
        target = _resolve_export_target(project_id, output_dir)
        _update_job(job_id, progress=0.1, message="Rendering edited tracks")

        def render_progress(speaker: Speaker, fraction: float) -> None:
            # render_edited_track のブロック進捗(0..1)を話者ごとの進捗帯へ線形マップ:
            # A=0.10..0.50 / B=0.50..0.90（残り0.1は SRT/CSV/エンコード）
            base = 0.1 if speaker == "A" else 0.5
            _update_job(
                job_id,
                progress=base + 0.4 * max(0.0, min(1.0, fraction)),
                message=f"Rendering speaker {speaker}",
            )

        produced = export_project(
            project,
            target,
            export_format=export_format,
            progress=render_progress,
            bundle=bundle,
        )
        # G: 出力先をユーザーに見せる。output_dir は絶対パス文字列、files は
        # 生成ファイル名のリスト（表示用・安定順）。file_paths は name→絶対パスの
        # 元マップを維持する（既存 export_project 戻り値を捨てない）。
        _update_job(
            job_id,
            progress=1.0,
            status="complete",
            message="Export complete",
            result={
                "output_dir": str(target),
                "files": sorted(produced),
                "file_paths": produced,
            },
        )
    except Exception as exc:
        # ffmpeg の TimeoutError（run_ffmpeg の timeout 超過）もここで捕捉して
        # ジョブ status=error に落とす（スレッドの永久ブロックを防ぐ設計）。
        _update_job(job_id, status="error", error=str(exc), message="Export failed")


# ---------------------------------------------------------------- Whisperモデル管理（Issue #12）

# UI 併記用の速度目安（フロント契約: GET /api/whisper/models の speed_hint）
WHISPER_SPEED_HINTS: dict[str, str] = {
    "tiny": "mediumの約8倍速・精度低",
    "base": "mediumの約5倍速",
    "small": "mediumの2〜3倍速・日本語会話で実用的",
    "medium": "既定・バランス型",
    "large-v3": "最高精度・mediumの約2倍遅",
}

# モデルDLの「チェック→ジョブ作成」を直列化する（同一モデルの多重ダウンロード防止。
# _job_lock は _new_job 内部で取るため、ここは別ロックで包む）
_model_download_guard = threading.Lock()


def _cuda_available() -> bool:
    """CUDA デバイス有無。torch には依存せず ctranslate2 で判定（import失敗は False）。"""
    try:
        import ctranslate2  # type: ignore

        return int(ctranslate2.get_cuda_device_count()) > 0
    except Exception:
        return False


def _compute_type_options(cuda: bool) -> list[dict[str, Any]]:
    return [
        {"value": "auto", "label": "自動", "available": True, "note": None},
        {
            "value": "int8",
            "label": "int8（高速）",
            "available": True,
            "note": "CPUで1.5〜2倍速。精度低下は軽微。macOSで推奨",
        },
        {
            "value": "float16",
            "label": "float16",
            "available": cuda,
            "note": "CUDA環境のみ選択可能",
        },
        {
            "value": "float32",
            "label": "float32（最高精度）",
            "available": True,
            "note": "最も遅い",
        },
    ]


def _find_running_model_download(model: str) -> dict[str, Any] | None:
    with _job_lock:
        for job in _jobs.values():
            if (
                job["kind"] == "model_download"
                and job["status"] == "running"
                and job.get("model") == model
            ):
                return dict(job)
    return None


def _run_model_download(model: str, job_id: str) -> None:
    target = whisper_model_dir(model)
    approx = WHISPER_MODEL_APPROX_BYTES.get(model, 0)
    stop = threading.Event()

    def poll() -> None:
        # snapshot_download は進捗コールバックを持たないため、配置先ディレクトリの
        # サイズを概算サイズと比較して 0..0.95 を報告する（完了検証後に 1.0）。
        # include_inflight=True: 転送中バイトは .cache 配下の .incomplete にあるため、
        # これを数えないと model.bin 転送中ずっと 3% で固まって見える（QA指摘）
        peak = 0.0
        while not stop.wait(1.0):
            try:
                size = whisper_model_size_bytes(model, include_inflight=True)
            except OSError:
                continue
            fraction = min(0.95, size / approx) if approx > 0 else 0.0
            # rename の瞬間に .incomplete が消えて一時的に減るため単調増加に均す
            peak = max(peak, fraction)
            fraction = peak
            _update_job(
                job_id,
                progress=fraction,
                message=f"Downloading model {model} ({fraction:.0%})",
            )

    poller = threading.Thread(target=poll, daemon=True)
    try:
        _update_job(job_id, progress=0.0, message=f"Downloading model {model}")
        poller.start()
        download_whisper_model(model, target)
        stop.set()
        poller.join(timeout=5.0)  # 完了報告(1.0)の後にポーリング値で巻き戻らないよう先に止める
        if not is_whisper_model_downloaded(model):
            raise RuntimeError(
                f"download finished but model.bin is missing in {target} — "
                "再実行すれば途中からレジュームされます"
            )
        _update_job(
            job_id,
            progress=1.0,
            status="complete",
            message=f"Model {model} downloaded",
            result={
                "model": model,
                "path": str(target),
                "size_bytes": whisper_model_size_bytes(model),
            },
        )
    except Exception as exc:
        _update_job(job_id, status="error", error=str(exc), message="Model download failed")
    finally:
        stop.set()


@app.get("/api/whisper/models")
def list_whisper_models() -> dict[str, Any]:
    models = []
    for name in WHISPER_MODEL_NAMES:
        downloaded = is_whisper_model_downloaded(name)
        models.append(
            {
                "name": name,
                "downloaded": downloaded,
                "size_bytes": whisper_model_size_bytes(name) if downloaded else None,
                "speed_hint": WHISPER_SPEED_HINTS[name],
            }
        )
    cuda = _cuda_available()
    return {
        "models": models,
        "environment": {
            "platform": sys.platform,
            "cuda_available": cuda,
            "compute_types": _compute_type_options(cuda),
        },
    }


@app.post("/api/whisper/models/download")
def start_model_download(
    background_tasks: BackgroundTasks,
    payload: dict[str, Any] | None = Body(None),
) -> dict[str, Any]:
    payload = payload or {}
    model = payload.get("model")
    if model not in WHISPER_MODEL_NAMES:
        raise HTTPException(
            status_code=400,
            detail=f"unknown model: {model!r} (allowed: {', '.join(WHISPER_MODEL_NAMES)})",
        )
    with _model_download_guard:
        # 同一モデルの実行中ジョブがあれば新規作成せずそれを返す（多重DL防止）
        existing = _find_running_model_download(model)
        if existing:
            return {"job": existing}
        job = _new_job("model_download", "")
        with _job_lock:
            _jobs[job["id"]]["model"] = model
            job = dict(_jobs[job["id"]])
    if is_whisper_model_downloaded(model):
        # 既に配置済みなら即 complete（DLスレッドを起こさない）
        _update_job(
            job["id"],
            progress=1.0,
            status="complete",
            message=f"Model {model} already downloaded",
            result={
                "model": model,
                "path": str(whisper_model_dir(model)),
                "size_bytes": whisper_model_size_bytes(model),
                "already_downloaded": True,
            },
        )
        with _job_lock:
            job = dict(_jobs[job["id"]])
        return {"job": job}
    background_tasks.add_task(_run_model_download, model, job["id"])
    return {"job": job}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "app": APP_NAME}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    with _job_lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="job not found")
        return dict(job)


# loudnorm の TP 引数の受付範囲（ffmpeg loudnorm 仕様: -9〜0 dBTP）
TRUE_PEAK_MIN = -9.0
TRUE_PEAK_MAX = 0.0


def _coerce_optional_float(value: Any, key: str) -> float | None:
    """settings 由来の値を float に寄せる（None はそのまま）。数値化できない値は
    「壊れた保存値」として 400（_validate_loudnorm_options と同じ経路で拾う）。"""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=400, detail=f"{key} の保存値が数値ではありません"
        ) from None


def _validate_loudnorm_options(
    true_peak: float | None, tolerance: float | None
) -> None:
    """ラウドネス詳細設定の範囲チェック（Issue #37。両経路で共有し 400 に正規化）。

    NaN は比較が False になり弾ける。tolerance は isfinite も見る
    （inf を settings に永続化すると JSON として不正になるため）。
    """
    if true_peak is not None and not (TRUE_PEAK_MIN <= true_peak <= TRUE_PEAK_MAX):
        raise HTTPException(
            status_code=400,
            detail="true_peak は -9〜0 dBTP の範囲で指定してください",
        )
    if tolerance is not None and not (math.isfinite(tolerance) and tolerance >= 0.0):
        raise HTTPException(
            status_code=400, detail="tolerance は 0 以上の数値で指定してください"
        )


def _reject_workdir_inside_data_dir(resolved_root: Path) -> None:
    """作業フォルダとしての data_dir 配下指定を 400 で拒否する（create / precheck 共有）。

    data_dir 配下を許すと従来配置 projects/ やレジストリ自身と混線する。
    overwrite_existing でも解除しない（同意が外すのは「このフォルダの既存
    プロジェクト」に関するガードだけで、アプリ領域の保護は対象外）。
    create_project と precheck_workdir の両方から使い、判定の二重管理を防ぐ
    — precheck が ok と返した指定が取込本体の 400 で落ちる不整合を作らない。
    """
    base = data_dir()
    if resolved_root == base or base in resolved_root.parents:
        raise HTTPException(
            status_code=400, detail="アプリのデータフォルダ内は指定できません"
        )


def _has_running_job_for(project_ids: set[str]) -> bool:
    """対象プロジェクトのいずれかに未終了ジョブがあるか。

    終了状態の正は _prune_finished_jobs_locked と同じ ("complete", "error")。
    それ以外（"running" 等）はすべて実行中扱い — 状態表現が増えたときに
    「勝手に終了扱いして削除に進む」側へ倒れないための否定形判定。
    """
    if not project_ids:
        return False
    with _job_lock:
        return any(
            job["project_id"] in project_ids
            and job["status"] not in ("complete", "error")
            for job in _jobs.values()
        )


@app.post("/api/projects")
async def create_project(
    background_tasks: BackgroundTasks,
    speaker_a: UploadFile = File(...),
    speaker_b: UploadFile = File(...),
    name: str = Form("Podcast prep project"),
    target_lufs: float = Form(-16.0),
    true_peak: float = Form(-1.5),
    tolerance: float = Form(0.5),
    normalize: bool = Form(True),
    workdir: str | None = Form(None),
    overwrite_existing: bool = Form(False),
) -> dict[str, Any]:
    _validate_loudnorm_options(true_peak, tolerance)  # ファイル保存より前に弾く
    project_id = uuid4().hex
    registered = False
    overwrite_root: Path | None = None  # 同意済み上書きの実削除先（ステージング成功後に消す）
    stale_overwrite_ids: list[str] = []  # 同意済み上書きで外す旧エントリ（同上のタイミング）
    if workdir is not None:
        try:
            resolved_root = validate_workdir(workdir)
        except WorkdirError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        _reject_workdir_inside_data_dir(resolved_root)
        # 同じフォルダを複数プロジェクトが共有すると project.json を上書きし合う。
        # ただし登録先に project.json が実在しないエントリは「孤児」（Issue #34:
        # フォルダの中身を手動で消しても登録だけが残り、同フォルダへの新規取込が
        # 永久にロックされる）なので、ブロックせず黙って登録を外して通す。
        # 登録の正は「フォルダに project.json が実在すること」（#34 改善案1）。
        has_project_json = (resolved_root / "project.json").exists()
        same_root_ids = sorted(
            entry["id"]
            for entry in registry.all_entries().values()
            if Path(entry["root"]) == resolved_root
        )
        if same_root_ids and not has_project_json:
            # 孤児の自動無効化（Issue #34 / #53）。対象は**このフォルダを root と
            # するエントリだけ** — 別フォルダを指す他プロジェクトのエントリには
            # 影響させない。下の実行中ジョブチェックの対象外でよい根拠:
            # この経路はファイルを1つも消さない（登録を外すだけ）うえ、
            # project.json 不在ではジョブの書き込み先実体（プロジェクト状態）が
            # なく、実行中ジョブがあっても load_project の FileNotFoundError で
            # 継続できないため、削除と書き込みが衝突する構造にならない。
            for stale_id in same_root_ids:
                try:
                    registry.unregister(stale_id)
                except registry.RegistryCorruptedError as exc:
                    raise HTTPException(status_code=500, detail=str(exc)) from exc
            same_root_ids = []
        if overwrite_existing:
            # UI の「上書きして取り込む」（Issue #53）。取込開始時の
            # /api/system/workdir_precheck → 確認ダイアログで明示同意済み。
            # このフォルダを作業フォルダとするプロジェクトに実行中のジョブが
            # あれば拒否する — 実行中の ffmpeg/whisper は解決済みパスを掴んで
            # おり、削除+新規取込と派生物を上書きし合う（構造的な競合）。
            if _has_running_job_for(set(same_root_ids)):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "このフォルダのプロジェクトで処理が実行中です。"
                        "完了を待ってから上書きしてください"
                    ),
                )
            # 旧エントリの unregister と実削除は**アップロードのステージング
            # 成功後**（下の try ブロック内）まで遅らせる — 413 やディスクフル
            # でアップロードが失敗したとき「旧プロジェクトだけ消えて新規も
            # 作れない」中間状態を作らないため。不変条件: 拒否される取込は
            # 旧プロジェクト（project.json・派生物・レジストリエントリ）を
            # 1バイトも変えない。
            stale_overwrite_ids = same_root_ids
            overwrite_root = resolved_root
        else:
            if same_root_ids:
                raise HTTPException(
                    status_code=400,
                    detail="このフォルダは既に別のプロジェクトの作業フォルダです",
                )
            # 既存プロジェクトのフォルダを新規取込先にすると save_project が
            # その project.json を無確認で上書きしてしまう。UI は取込開始時の
            # precheck でこの状態を検知し「再開 / 上書き / キャンセル」の確認
            # ダイアログを出す（Issue #53）。API 直叩き（overwrite_existing なし）
            # は従来どおり 400 — **既定では破壊できない**ことを維持する。
            if has_project_json:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "このフォルダには既存のプロジェクト（project.json）があります。"
                        "新規取込ではなく復元で開いてください"
                    ),
                )
            # 取込は派生物（正規化WAV・ピーク）を固定名・無条件で書く（一覧と出所は
            # RESERVED_ARTIFACT_NAMES 参照）。同名の既存ファイルは上書きで壊れるため
            # 事前に断る。「フォルダから開く」（open_project）は対象外 — あちらは
            # 既存プロジェクトの派生物を同じプロジェクトとして作り直すのが正。
            conflicts = sorted(
                name for name in RESERVED_ARTIFACT_NAMES if (resolved_root / name).exists()
            )
            if conflicts:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "このフォルダには本アプリの生成ファイルと同名のファイルがあります"
                        f"（{'、'.join(conflicts)}）。"
                        "空のフォルダか、別のフォルダを選んでください"
                    ),
                )
        # project_dir(create=True) より前に登録する。以降の既存処理は
        # project_dir 経由で全てこのフォルダに落ちる（呼び出し側は無変更）。
        try:
            registry.register(project_id, resolved_root, name=name, root_chosen_via="api")
        except registry.RegistryCorruptedError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        registered = True
    staged: list[tuple[Path, Path]] = []  # (一時パス, 最終パス)
    try:
        project = ProjectState.new(project_id, name)
        project.status = "importing"
        project.settings["target_lufs"] = float(target_lufs)
        project.settings["true_peak"] = float(true_peak)
        project.settings["tolerance"] = float(tolerance)
        pdir = project_dir(project_id, create=True)  # 取込 = 書き込み経路
        # 実際にアップロードされた拡張子を尊重する（mp3 だけでなく wav/m4a/flac 等）。
        # 許可外・拡張子なしは話者既定名（speakerX.wav）へ倒す（_safe_audio_name）。
        file_a = _safe_audio_name(speaker_a.filename or "", DEFAULT_UPLOAD_NAME["A"])
        file_b = _safe_audio_name(speaker_b.filename or "", DEFAULT_UPLOAD_NAME["B"])
        if file_a == file_b:
            # 同名衝突（同じファイルを2スロットに入れた・両方が既定名に倒れた）は
            # 上書きになるので、拡張子を保ったまま話者名で分ける。
            file_a = f"speakerA{Path(file_a).suffix}"
            file_b = f"speakerB{Path(file_b).suffix}"
        # 作業フォルダ内の既存ファイルとの衝突は別名へ倒す（上書きしない）
        file_a = _available_upload_name(pdir, file_a, "A", set())
        file_b = _available_upload_name(pdir, file_b, "B", {file_a})
        staged.append((await _save_upload(speaker_a, pdir / file_a), pdir / file_a))
        staged.append((await _save_upload(speaker_b, pdir / file_b), pdir / file_b))
        # ---- ここが「取込成立」の境界（Issue #53）。A/B 両方のステージングが
        # 成功して初めて旧プロジェクトに手を付ける。ここより上で失敗した取込
        # （413・ディスクフル等）は except 節が一時ファイルと新エントリだけを
        # 掃除し、旧プロジェクトは1バイトも変わらずに残る。
        if stale_overwrite_ids:
            # 同意済み上書きの付け替え。実削除より先に外す — ここで失敗
            # （レジストリ破損 500）しても旧 project.json・派生物はまだ無傷
            try:
                for stale_id in stale_overwrite_ids:
                    registry.unregister(stale_id)
            except registry.RegistryCorruptedError as exc:
                raise HTTPException(status_code=500, detail=str(exc)) from exc
        if overwrite_root is not None:
            # 同意済み上書きの実削除（Issue #53）。消すのは**名前で識別できる
            # 自アプリの生成物**だけ: project.json + RESERVED_ARTIFACT_NAMES の
            # 実在ファイル（#28 の _cleanup_stale_export_files と同じ「識別できる
            # ものだけ」の思想）。旧プロジェクトの元音源は任意名でユーザー
            # ファイルと区別できないため触らない。exports/ 等のサブフォルダにも
            # 触らない。symlink はリンク自体を消し、リンク先には触れない。
            # ここで失敗（OSError 等）しても except 節が新エントリを掃除する。
            for artifact_name in ("project.json", *sorted(RESERVED_ARTIFACT_NAMES)):
                target = overwrite_root / artifact_name
                if target.is_symlink() or target.is_file():
                    target.unlink()
        # 両方のステージが成功してから最終名へ置く。片方だけ 413 で失敗した
        # ときに最終名のファイル（既存 or 中途半端な新規）を残さないため
        for temp, dest in staged:
            os.replace(temp, dest)
        staged.clear()
        project.tracks["A"].original_file = file_a
        project.tracks["B"].original_file = file_b
        save_project(project)
    except BaseException:
        # 登録後に失敗（サイズ上限 413 等）したらエントリと一時ファイルを残さない。
        # ダングリングエントリは以後の同フォルダ指定を重複扱いで永久に弾いてしまう
        for temp, _dest in staged:
            temp.unlink(missing_ok=True)
        if registered:
            try:
                registry.unregister(project_id)
            except registry.RegistryCorruptedError:
                pass  # 掃除の失敗で元例外（413等）をマスクしない — そちらが原因
        raise
    job = _new_job("import", project_id)
    # L: normalize=False なら loudnorm 3パス（60分素材で数分）を飛ばして
    # convert_to_pcm の形式変換のみ。後から POST /normalize で掛け直せる。
    background_tasks.add_task(_run_import, project_id, job["id"], bool(normalize))
    return {"project": _project_payload(project), "job": job}


def _missing_audio_detail(name: str) -> str:
    return (
        f"音源ファイルが見つかりません: {name} — "
        "project.json と同じフォルダに置いてください"
    )


def _adopt_track_audio(
    project: ProjectState, source_dir: Path | None, origin_id: str | None = None
) -> None:
    """開いた project.json のトラック音源を解決し、プロジェクト配下に引き込む（Issue #19）。

    解決順（後方互換のため絶対パスを先に見る）:
      1. 値が絶対パスで、**実在する**ならそれを使う（旧エクスポート形式）
      2. project.json と同じフォルダ（source_dir）からの相対解決
      3. 既にプロジェクトディレクトリ配下にあるならそれを使う
         （同じデータディレクトリで開き直した場合。ファイルコピー不要）
    どれにも当たらなければ 400 + 誘導メッセージ。

    コピーの要否（フェーズ4 = 作業フォルダの可変化）:
    - 解決先が **project_dir 配下**なら1バイトもコピーせず、フォルダ内相対の
      参照をそのまま保持する。「フォルダから開く」は registry 登録によって
      project_dir が開いたフォルダ自身を指すため、通常ケースはここに落ちる
      （従来は 60 分素材で 223MB×2 をアプリ内へ複製していた）
    - 解決先が project_dir の **外**（許可ベース配下の絶対参照・ID衝突時の
      元プロジェクト配下など）なら従来どおり固定名でコピーして引き込み、
      フォルダの自己完結性を保つ

    セキュリティ:
    - 相対解決は resolve_sibling_file（= resolve_project_file と同じ `_ensure_within`）を
      通すので、'..' もシンボリックリンクも source_dir の外へは出られない
    - 絶対パスは _absolute_source_allowed の許可ベース配下に封じ込める（#25）
    - 引き込みコピーの宛先は常に `project_dir` 配下の固定名（speakerX_*）で、
      ファイル名は入力値に由来しない（コピー先のトラバーサルは構造的に起こらない）
    """
    # フェーズ1: 全話者・全フィールドを先に解決し切る。1件でも解決不能なら
    # 1バイトも書かずに 400（QA指摘: 途中まで書いてから 400 で返ると
    # 既存プロジェクトの音源が部分的に壊れた状態で残る）
    plan: list[tuple[Speaker, str, Path, Path]] = []
    keep: list[tuple[Speaker, str, str]] = []
    drop: list[tuple[Speaker, str]] = []
    # ディレクトリ作成はフェーズ2まで遅らせる（解決に失敗して400を返したとき、
    # 空のプロジェクトディレクトリが残骸として溜まっていた — 実機で確認）
    pdir = project_dir(project.id)
    pdir_resolved = pdir.resolve()
    for speaker in SPEAKERS:
        track = project.tracks[speaker]
        for field_name in ("original_file", "normalized_wav"):
            value = getattr(track, field_name)
            if not value:
                continue
            resolved = _locate_track_source(project.id, value, source_dir, origin_id)
            if resolved is None:
                # normalized_wav は編集・再生・書き出しの実体なので必須。
                # original_file は「後がけ正規化のやり直し」専用なので、
                # 欠けていても作業は続けられる → 参照を落として開く（QA/実機指摘）。
                if field_name == "original_file":
                    drop.append((speaker, field_name))
                    continue
                raise HTTPException(
                    status_code=400, detail=_missing_audio_detail(Path(value).name)
                )
            resolved_abs = resolved.resolve()
            if _is_within(pdir_resolved, resolved_abs):
                # 既に作業フォルダ配下 → コピー不要。参照はフォルダ内相対で保持する
                # （Issue #19「参照は必ず相対」— 絶対パス指定で開かれてもここで相対化）
                keep.append(
                    (
                        speaker,
                        field_name,
                        resolved_abs.relative_to(pdir_resolved).as_posix(),
                    )
                )
                continue
            suffix = resolved.suffix or ".wav"
            stem = (
                f"speaker{speaker}"
                if field_name == "original_file"
                else f"speaker{speaker}_normalized"
            )
            plan.append((speaker, field_name, resolved_abs, pdir / f"{stem}{suffix}"))

    # フェーズ2: 全件解決できたので書き込みを実行する（ここで初めてディレクトリを作る）
    if plan:
        pdir = project_dir(project.id, create=True)
    for speaker, field_name, resolved, dest in plan:
        shutil.copyfile(resolved, dest)
        setattr(project.tracks[speaker], field_name, dest.name)
    for speaker, field_name, relative_name in keep:
        setattr(project.tracks[speaker], field_name, relative_name)
    for speaker, field_name in drop:
        setattr(project.tracks[speaker], field_name, "")


def _absolute_source_allowed(
    project_id: str, candidate: Path, source_dir: Path | None, origin_id: str | None = None
) -> bool:
    """絶対パス指定の音源が、許可ディレクトリ配下かを resolve 後に判定する。

    許可するのは source_dir 配下（同送された素材フォルダ）と project_dir 配下のみ。
    シンボリックリンクは resolve() で実体まで潰してから判定する。
    """
    target = candidate.resolve()
    bases = []
    if source_dir is not None:
        bases.append(source_dir.resolve())
    for pid in filter(None, (project_id, origin_id)):
        try:
            bases.append(project_dir(pid).resolve())
        except (ValueError, OSError):
            continue
    return any(_is_within(base, target) for base in bases)


def _locate_track_source(
    project_id: str, value: str, source_dir: Path | None, origin_id: str | None = None
) -> Path | None:
    """トラック音源の実ファイルを探す。見つからなければ None。

    セキュリティ（QA Critical 指摘の修正）: 絶対パスを「実在するだけ」で採用すると、
    細工した project.json でホスト上の任意ファイル（鍵・認証情報）を project_dir へ
    引き込み、GET /audio で読み出せてしまう。main には無かった退行だったため、
    **絶対パスも必ず許可ディレクトリ配下（source_dir / project_dir）に封じ込める**。
    旧形式の絶対パスは、素材が同じ場所に残っていれば経路3で解決される。
    """
    candidate = Path(value)
    # 1. 絶対パスは許可ベース配下のときだけ採用（旧形式の後方互換はここまで）
    if candidate.is_absolute():
        if candidate.is_file() and _absolute_source_allowed(
            project_id, candidate, source_dir, origin_id
        ):
            return candidate
        return None
    # 2. project.json と同階層からの相対解決（新形式）
    if source_dir is not None:
        try:
            sibling = resolve_sibling_file(source_dir, value)
        except ValueError:
            sibling = None
        if sibling is not None and sibling.is_file():
            return sibling
    # 3. 既にプロジェクトディレクトリ配下にある（同じデータディレクトリで開き直した）。
    #    ID衝突で新規採番した場合は元プロジェクトの配下も探索先に含める
    #    （採番は上書き回避のためで、素材の引き継ぎは妨げない）
    for pid in filter(None, (project_id, origin_id)):
        try:
            inside = resolve_project_file(pid, value)
        except ValueError:
            continue
        if inside.is_file():
            return inside
    return None


def _resolve_open_source_dir(raw: str | None) -> Path | None:
    """`source_dir` フォームフィールドを検証する。

    未指定・空は None（相対解決を試みない）。存在しないディレクトリは 400。
    ここで受け取るのはローカルの実ディレクトリで、以後の解決は必ず
    resolve_sibling_file の封じ込めを通る。
    """
    if raw is None or not str(raw).strip():
        return None
    path = Path(str(raw).strip()).expanduser()
    if not path.is_absolute():
        raise HTTPException(status_code=400, detail="source_dir must be an absolute path")
    resolved = path.resolve()
    if not resolved.is_dir():
        raise HTTPException(status_code=400, detail="source_dir is not a directory")
    return resolved


@app.post("/api/projects/open")
async def open_project(
    project_json: UploadFile | None = File(None),
    source_dir: str | None = Form(None),
    audio: list[UploadFile] | None = File(None),
) -> dict[str, Any]:
    """project.json からプロジェクトを復元する。

    音源の持ち込み方は3通り（Issue #19）:
    - `source_dir` のみ: そのフォルダの project.json と音源をサーバ側で直接読む。
      **60分素材だと音源は 223MB×2 になるため、アップロードを回避できるこの経路が既定**
      （実機フィードバック: UIから project.json だけ選ぶと音源が渡らず 400 になっていた）。
      フェーズ4以降、このフォルダは**そのまま作業フォルダ**になる（レジストリ登録。
      音源のアプリ内コピーは行わない）。従来配置のフォルダ自身を指定した場合だけは
      レガシー再オープンとして登録せずに開く
    - `audio`: 同階層の音源をブラウザから一緒にアップロードする（file input は
      ディレクトリパスを渡せないため、ファイル選択から開く場合はこちら）
    - どちらも無し: 既にプロジェクト配下にある場合のみ成立（後方互換）
    """
    resolved_source_dir = _resolve_open_source_dir(source_dir)
    raw = bytearray()
    if project_json is not None:
        while True:
            chunk = await project_json.read(1024 * 1024)
            if not chunk:
                break
            raw.extend(chunk)
            if len(raw) > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="uploaded file exceeds size limit")
    # source_dir だけ渡された（またはダミーが来た）場合はフォルダの project.json を読む
    if resolved_source_dir is not None and len(raw) < 3:
        doc_path = resolved_source_dir / "project.json"
        if not doc_path.is_file():
            raise HTTPException(
                status_code=400,
                detail=f"指定フォルダに project.json がありません: {resolved_source_dir}",
            )
        raw = bytearray(doc_path.read_bytes())
    if not raw:
        raise HTTPException(
            status_code=400, detail="project.json またはフォルダのパスを指定してください"
        )
    try:
        data = json.loads(bytes(raw).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(status_code=400, detail="project file is not valid JSON") from None
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="project file must be a JSON object")
    try:
        project = ProjectState.from_dict(data)
    except (KeyError, ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(status_code=400, detail=f"invalid project file: {exc}") from None
    _require_valid_project_id(project.id)

    # ---- source_dir の分類（フェーズ4 = 作業フォルダの可変化）----
    # 「フォルダから開く」は、開いたフォルダを**そのまま作業フォルダ**として使う
    # （従来はアプリ内 project_dir へ音源を丸ごとコピーしていた: 60分素材で 223MB×2）。
    # 例外は従来配置 projects_root()/{id} 自身を指定されたときで、これはレガシー
    # プロジェクトの再オープンとして従来配置のまま開く（レジストリにも載せない）。
    workdir_mode = False
    legacy_reopen = False
    matched_entry: dict[str, Any] | None = None
    if resolved_source_dir is not None:
        if resolved_source_dir == (projects_root() / project.id).resolve():
            if registry.entry_for(project.id) is not None:
                # 同 id が別の作業フォルダとして登録済み = 対応が壊れている。
                # 黙ってどちらかを正とせず、ユーザーに見せて止める
                raise HTTPException(
                    status_code=409,
                    detail="レジストリと project.json の対応が壊れています",
                )
            legacy_reopen = True
        elif resolved_source_dir == data_dir() or data_dir() in resolved_source_dir.parents:
            # 従来配置 projects/ やレジストリ自身と混線する（create と同じ判断）
            raise HTTPException(
                status_code=400, detail="アプリのデータフォルダ内は指定できません"
            )
        else:
            # 以後このフォルダに中間 WAV を書き続けるので、作業フォルダとしての
            # 妥当性検証（ルート直下・クラウド同期フォルダ拒否）を入口で掛ける
            try:
                resolved_source_dir = validate_workdir(str(resolved_source_dir))
            except WorkdirError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            workdir_mode = True
            # レジストリ逆引き: 既にこのフォルダを作業フォルダとするエントリが
            # あれば再入場。既存 ID を再利用する（再採番しない）
            for entry in registry.all_entries().values():
                if Path(entry["root"]) == resolved_source_dir:
                    matched_entry = entry
                    break
            if matched_entry is not None and matched_entry["id"] != project.id:
                raise HTTPException(
                    status_code=409,
                    detail="レジストリと project.json の対応が壊れています",
                )

    # 同送された音源は一時ディレクトリへ受けてから相対解決の探索先にする。
    # ファイル名は _safe_audio_name でサニタイズするので、アップロード名由来の
    # パス区切り・'..' は一時ディレクトリの外へ出ない。
    with tempfile.TemporaryDirectory(prefix="podcast-prep-open-") as tmpdir:
        if audio:
            staged = Path(tmpdir)
            for index, upload in enumerate(audio):
                name = _safe_name(upload.filename or "", f"audio{index}.wav")
                # 一時ディレクトリ内なので衝突は無く、即時に最終名へ置いてよい
                os.replace(await _save_upload(upload, staged / name), staged / name)
            if resolved_source_dir is None:
                resolved_source_dir = staged.resolve()
        project.status = "ready"
        # ID衝突の回避（QA Critical 指摘）: project.json は id を保持したまま
        # 書き出されるため、同じプロジェクトを2回書き出して片方を開き直すだけで
        # 既存の収録音源が固定名で無警告に上書きされていた（録り直せないデータの破壊）。
        # 既存プロジェクトがあるときは**別プロジェクトとして採番**して取り込む。
        # 同一データディレクトリでの単純な開き直し（音源も blocks も同じ）は
        # 引き込み先が同一ファイルになりコピーが起きないため、この分岐に入っても無害。
        # 素材同梱なし（bundle="none"）で書き出したフォルダを「開く」に渡すと、
        # normalized_wav が空のまま status=ready のプロジェクトが出来上がっていた。
        # 開けたように見えて再生も波形も 404、書き出しは Errno 21 が生で漏れる
        # 「幽霊プロジェクト」になる（QA指摘）。ここで明示的に断る。
        #
        # 判定は**実体ベース**にする。書き出し側のマーク（exported_bundle_mode）だけを
        # 見ると、マークを持たない既存の書き出し（この機能より前に作ったフォルダ）が
        # 素通しして幽霊になる（この機能より前に作られた書き出しフォルダが実際に該当する）。
        #
        # 条件は「編集済み（blocks あり）なのに、再生用も復旧用も音源が1つも無い」。
        # - blocks を見るのは、音源未設定の**新規**プロジェクトを開く正当な経路
        #   （blocks も空）を巻き込まないため
        # - original_file も見るのは、`normalized_wav` だけが空でも取込元が残っていれば
        #   `POST /normalize` で完全に復旧できるため。取込中にサーバが落ちた・
        #   normalize=false で取り込んだ・元音源と project.json だけを別マシンへ
        #   持ち出した、はいずれも正当な状態で、拒否すると UI の「このトラックを
        #   正規化」ボタンに永久に到達できなくなる（QA指摘）
        # 書き出し由来の文書は exporter が original_file を必ず空にする（exporter.py）
        # ので、幽霊は従来どおり捕まる。
        #
        # 位置が重要: ID採番・_adopt_track_audio より**前**に置く。後ろに置くと、
        # 拒否したのに音源コピーだけがプロジェクトディレクトリに残る（60分素材なら
        # 450MB が project.json 無しで不可視のまま堆積し、リトライごとに増える）。
        # 「失敗した open は1バイトも書かない」は fbb0890 で確立した不変条件（QA指摘）。
        # 判定材料は文書由来の値だけなので、ここでも同じ結論が出る。
        if project.blocks and not any(
            project.tracks[s].normalized_wav or project.tracks[s].original_file
            for s in SPEAKERS
        ):
            raise HTTPException(
                status_code=400,
                detail=(
                    "このプロジェクトには編集用の音源が設定されていないため開けません。"
                    "素材を同梱せずに書き出したフォルダの場合は、書き出し時に"
                    "「再編集用の素材も入れる」を選び直してください。"
                ),
            )
        adopted_as_new = False
        original_id: str | None = None
        registered = False
        if workdir_mode:
            if matched_entry is None:
                # 未登録フォルダの初回オープン。文書の id が既存プロジェクト
                # （従来配置 or レジストリ）と衝突するときだけ従来どおり採番し直す。
                # 新 id は save_project がこのフォルダの project.json へ書き戻す
                # （書き戻さないと次回オープンで再び衝突する）
                if project_dir(project.id).is_dir() or registry.entry_for(project.id):
                    original_id = project.id
                    project.id = uuid4().hex
                    adopted_as_new = True
                # 登録は _adopt_track_audio より前: 以降の project_dir(project.id) が
                # このフォルダを指すことで「配下の音源はコピーしない」判定が成立する
                try:
                    registry.register(
                        project.id,
                        resolved_source_dir,
                        name=project.name,
                        root_chosen_via="open",
                    )
                except registry.RegistryCorruptedError as exc:
                    raise HTTPException(status_code=500, detail=str(exc)) from exc
                registered = True
            # matched_entry あり = 再入場。既存 ID・既存エントリをそのまま使う
        elif not legacy_reopen and project_dir(project.id).is_dir():
            # 従来経路（アップロード等）の ID 衝突回避。レガシー再オープンは
            # 「自分自身との衝突」なので採番しない（同じプロジェクトとして開く）
            original_id = project.id
            project.id = uuid4().hex
            adopted_as_new = True
        try:
            _adopt_track_audio(project, resolved_source_dir, original_id)
            save_project(project)
        except BaseException:
            # 登録後に失敗（音源解決 400 等）したらエントリを残さない
            # （create_project と同じ判断: ダングリングは同フォルダの再試行を
            # 逆引き・重複判定で誤らせる）
            if registered:
                try:
                    registry.unregister(project.id)
                except registry.RegistryCorruptedError:
                    pass  # 掃除の失敗で元例外をマスクしない — そちらが原因
            raise
    if matched_entry is not None:
        # last_opened_at の更新は project_dir では行えない（純関数に保つ既定方針）
        # ため、再入場が成立したここで明示的に記録する
        try:
            registry.update(project.id, last_opened_at=utc_now_iso())
        except registry.RegistryCorruptedError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
    payload = _project_payload(project)
    if adopted_as_new:
        payload["adopted_as_new_project"] = True
        payload["source_project_id"] = original_id
    return {"project": payload}


def _project_payload(project: ProjectState) -> dict[str, Any]:
    """project.to_dict() に導出フィールドを載せた API 応答（保存形式は変えない）。

    overlaps 各要素に `category`（"resolvable"|"contained"|"too_long"|"same_start"）を
    追加する。models.Overlap のスキーマは増やさず**応答生成時に導出**する方式:
    - 分類は blocks の座標と閾値のみに依存するので、保存すると閾値変更・ブロック移動の
      たびに陳腐化する（保存値と真値がズレる危険がある）。
    - 実測コスト: 2065ブロック / 被り967件で classify_overlaps は約3ms
      （recompute_overlaps 約2.9ms と同水準）。PUT のたびの再計算に耐える。
    分類が無い被り（min_overlap_s 未満など classify に載らないペア）は
    category を付けずに素通しする（フロントは未定義を「不明」として扱えばよい）。
    """
    data = project.to_dict()
    # 導出フィールド: 作業フォルダの実パス（保存はしない。from_dict は未知キーを無視する）。
    # レジストリ未登録でも従来配置の実パスを返す = UIは常に表示できる。
    data["workdir"] = str(project_dir(project.id))
    try:
        rows = classify_overlaps(
            project.blocks,
            min_overlap_s=float(project.settings.get("min_overlap_s", 0.3)),
            max_overlap_s=float(project.settings.get("auto_edit_max_overlap_s", 3.0)),
        )
    except (TypeError, ValueError):
        return data          # 壊れた settings で一覧表示ごと落とさない（分類は諦める）
    by_pair = {frozenset(row["block_ids"]): row["category"] for row in rows}
    for overlap in data.get("overlaps", []):
        category = by_pair.get(frozenset(overlap.get("block_ids", [])))
        if category is not None:
            overlap["category"] = category
    return data


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> dict[str, Any]:
    return _project_payload(_load_project_or_404(project_id))


@app.put("/api/projects/{project_id}")
def update_project(project_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    if payload.get("id") != project_id:
        raise HTTPException(status_code=400, detail="project id mismatch")
    project = ProjectState.from_dict(payload)
    project.blocks = searchable_block_text(project.blocks, project.transcripts)
    project.overlaps = recompute_overlaps(
        project.blocks,
        min_duration=float(project.settings.get("min_overlap_s", 0.3)),
    )
    save_project(project)
    return {"project": _project_payload(project)}


def _blocks_digest(blocks: Sequence[Block]) -> str:
    """auto_edit の楽観ロック用ダイジェスト（id / start / deleted のみが対象）。"""
    payload = json.dumps(
        sorted((b.id, round(b.start, 6), b.deleted) for b in blocks),
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _parse_target_pairs(raw: Any) -> set[frozenset[str]] | None:
    """payload.target_pairs → resolve_overlaps 用のペア集合。

    None / 未指定 は None（= 全件対象、現行動作）を返す。空リストは空集合
    （= 解消0件）で、None とは意味が違う点に注意。
    要素は2要素の [a_id, b_id]（順不同）。形式不正は 400。
    """
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail="target_pairs must be a list")
    pairs: set[frozenset[str]] = set()
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise HTTPException(
                status_code=400, detail="each target_pairs entry must be a pair of block ids"
            )
        if not all(isinstance(v, str) and v for v in item):
            raise HTTPException(
                status_code=400, detail="target_pairs block ids must be non-empty strings"
            )
        pairs.add(frozenset(item))
    return pairs


@app.post("/api/projects/{project_id}/auto_edit")
def auto_edit_project(
    project_id: str, payload: dict[str, Any] | None = Body(None)
) -> dict[str, Any]:
    """自動編集（auto-tighten）。同期・座標計算のみでジョブ不要。

    dry_run 既定 true（素のPOSTはプレビュー）。閾値の優先順は payload > settings >
    default。settings は書き換えない（永続化はフロントの既存 PUT 経路に一本化）。
    応答には契約§Aの preview（ハッチ描画用の範囲配列、現在=適用前座標）を
    dry_run / apply の両方で含める。

    payload.target_pairs（任意）: [["a-001","b-002"], ...]。指定すると
    **そのペアの被りだけ**を解消対象にする（チェックボックス選択適用）。
    省略/null は全件（現行動作）。空リストは「解消0件」= 被りパスの no-op。
    無音詰めは選択の対象外（tighten_gaps が独立して効く）。
    """
    p = payload or {}
    project = _load_project_or_404(project_id)
    s = project.settings

    def _opt(key: str, skey: str, default: float) -> float:
        try:
            return float(p.get(key, s.get(skey, default)))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"invalid value for {key}") from None

    max_gap = _opt("max_gap_s", "auto_edit_max_gap_s", 1.5)
    keep_gap = _opt("keep_gap_s", "auto_edit_keep_gap_s", 0.5)
    max_ov = _opt("max_overlap_s", "auto_edit_max_overlap_s", 3.0)
    keep_ov = _opt("keep_overlap_s", "auto_edit_keep_overlap_s", 0.0)
    min_ov = float(s.get("min_overlap_s", 0.3))
    if keep_gap < 0 or max_gap < keep_gap or max_ov < min_ov or not (0 <= keep_ov < min_ov):
        raise HTTPException(status_code=400, detail="invalid auto edit thresholds")
    digest = _blocks_digest(project.blocks)
    if p.get("if_blocks_digest") and p["if_blocks_digest"] != digest:
        raise HTTPException(status_code=409, detail="project changed since preview")
    tighten_overlaps = bool(p.get("tighten_overlaps", True))
    tighten_gaps = bool(p.get("tighten_gaps", True))
    target_pairs = _parse_target_pairs(p.get("target_pairs"))
    try:
        result = auto_tighten(
            project.blocks,
            tighten_overlaps=tighten_overlaps,
            tighten_gaps=tighten_gaps,
            max_gap_s=max_gap,
            keep_gap_s=keep_gap,
            min_overlap_s=min_ov,
            max_overlap_s=max_ov,
            keep_overlap_s=keep_ov,
            target_pairs=target_pairs,
        )
    except ValueError as exc:  # 純関数側の検証も 400 に変換（二重防御）
        raise HTTPException(status_code=400, detail=str(exc)) from None
    summary = result.summary()
    # preview（契約§A）: overlaps は resolve パスの resolve_overlap アクションの
    # (start, end) そのまま（元座標で記録される）。gaps は元blocks に対する
    # detect_silence_gaps(min_gap_s=max_gap) のうち実際に詰まるもの
    # （duration - keep_gap > EPS）。OFF側は空配列。
    preview_overlaps = [
        {"start": action.start, "end": action.end}
        for action in result.actions
        if action.kind == "resolve_overlap"
    ]
    preview_gaps = (
        [
            {"start": gap.start, "end": gap.end}
            for gap in detect_silence_gaps(project.blocks, min_gap_s=max_gap)
            if gap.duration - keep_gap > EPS
        ]
        if tighten_gaps
        else []
    )
    body: dict[str, Any] = {
        "dry_run": bool(p.get("dry_run", True)),
        "applied": False,
        "blocks_digest": digest,
        "summary": summary,
        "actions": [action.to_dict() for action in result.actions],
        "preview": {"gaps": preview_gaps, "overlaps": preview_overlaps},
    }
    if body["dry_run"]:
        return body  # 保存しない・MB級 project も返さない
    if summary["would_change"]:
        project.blocks = result.blocks
        project.overlaps = recompute_overlaps(project.blocks, min_duration=min_ov)
        save_project(project)
        body["applied"] = True
    # 無変化 apply は保存スキップして現状を返す。GET と同じく category 付き
    body["project"] = _project_payload(project)
    return body


@app.get("/api/projects/{project_id}/audio/{speaker}")
def get_audio(project_id: str, speaker: Speaker) -> FileResponse:
    # 契約§D: FileResponse のまま維持すること（starlette の Range 対応が
    # フロント再生エンジンの PCM バイト範囲取得の生命線）。
    # StreamingResponse 等への置換は禁止。
    project = _load_project_or_404(project_id)
    track = project.tracks[speaker]
    if not track.normalized_wav:
        raise HTTPException(status_code=404, detail="audio not found")
    path = _resolve_track_file_or_404(project_id, track.normalized_wav, "audio not found")
    return FileResponse(path, media_type="audio/wav", filename=path.name)


# PPK1 サイドカーヘッダ: magic "PPK1"(4B) + uint32LE bins_per_sec + uint32LE bin_count
# + uint32LE reserved(0)。ボディは uint8×bin_count（audio.generate_peak_bins と同期）
PPK1_HEADER_LEN = 16


def _valid_peaks_sidecar(path: Path) -> bool:
    """配信前のサイドカー検証: PPK1 マジック + ヘッダ長 + 宣言 bin_count とサイズの一致。

    途中失敗の部分ファイル（マジックは有効でもボディが欠ける）を検出する
    （QA指摘: 破損サイドカーが is_file() だけで恒久配信されていた）。
    """
    try:
        data = path.read_bytes()
    except OSError:
        return False
    if len(data) < PPK1_HEADER_LEN or data[:4] != b"PPK1":
        return False
    bin_count = struct.unpack_from("<I", data, 8)[0]
    return len(data) == PPK1_HEADER_LEN + bin_count


@app.get("/api/projects/{project_id}/peaks/{speaker}")
def get_peaks(project_id: str, speaker: Speaker) -> FileResponse:
    """ピークサイドカー（PPK1 バイナリ）を配信する。

    サイドカー不在（旧プロジェクト）は normalized_wav からその場で生成して保存する
    遅延マイグレーション。normalized_wav も無ければ 404。破損サイドカーは削除して
    再生成し、書き込みは tmp+os.replace でアトミックに行う（部分ファイルの固定化防止）。
    """
    project = _load_project_or_404(project_id)
    sidecar = project_dir(project_id) / f"speaker{speaker}_peaks.u8"
    if sidecar.is_file() and not _valid_peaks_sidecar(sidecar):
        sidecar.unlink(missing_ok=True)
    if not sidecar.is_file():
        track = project.tracks[speaker]
        if not track.normalized_wav:
            raise HTTPException(status_code=404, detail="peaks not available")
        source = _resolve_track_file_or_404(
            project_id, track.normalized_wav, "peaks not available"
        )
        atomic_write_bytes(
            sidecar,
            generate_peak_bins(
                source,
                bins_per_sec=int(project.settings.get("peaks_bins_per_sec", 200)),
            ),
        )
    return FileResponse(sidecar, media_type="application/octet-stream", filename=sidecar.name)


# プレビューの上限秒数（全編レンダリング要求の防止）と一時ファイル掃除のポリシー
MAX_PREVIEW_DURATION_S = 30.0
PREVIEW_MAX_AGE_S = 20 * 60.0
PREVIEW_KEEP_LATEST = 10


def _prune_previews(preview_dir: Path) -> None:
    """previews/ の古い一時WAVを削除する（20分超 or 新しい方から10件を超えた分）。"""
    try:
        entries = sorted(
            (path for path in preview_dir.iterdir() if path.is_file()),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return
    now = time.time()
    for index, path in enumerate(entries):
        try:
            if index >= PREVIEW_KEEP_LATEST or now - path.stat().st_mtime > PREVIEW_MAX_AGE_S:
                path.unlink(missing_ok=True)
        except OSError:
            continue  # 掃除は装飾。プレビュー生成を止めない


@app.get("/api/projects/{project_id}/preview/{speaker}")
def get_preview(
    project_id: str,
    speaker: Speaker,
    start: float = 0.0,
    duration: float = 8.0,
    gain_db: float | None = None,
    deesser: float | None = None,
) -> FileResponse:
    if not 0.0 < duration <= MAX_PREVIEW_DURATION_S:
        raise HTTPException(
            status_code=400,
            detail=f"duration must be within (0, {MAX_PREVIEW_DURATION_S:g}] seconds",
        )
    project = _load_project_or_404(project_id)
    track = project.tracks[speaker]
    if not track.normalized_wav:
        raise HTTPException(status_code=404, detail="audio not found")
    source = _resolve_track_file_or_404(project_id, track.normalized_wav, "audio not found")
    preview_dir = project_dir(project_id) / "previews"
    preview_dir.mkdir(parents=True, exist_ok=True)
    _prune_previews(preview_dir)
    handle = tempfile.NamedTemporaryFile(
        prefix=f"{speaker}_",
        suffix=".wav",
        dir=preview_dir,
        delete=False,
    )
    handle.close()
    output = Path(handle.name)
    render_preview_segment(
        source,
        output,
        start=start,
        duration=duration,
        gain_db=track.gain_db if gain_db is None else gain_db,
        deesser=track.deesser if deesser is None else deesser,
    )
    return FileResponse(output, media_type="audio/wav", filename=output.name)


@app.post("/api/projects/{project_id}/transcribe")
def start_transcription(
    project_id: str,
    background_tasks: BackgroundTasks,
    payload: dict[str, Any] | None = Body(None),
) -> dict[str, Any]:
    _load_project_or_404(project_id)
    payload = payload or {}
    model = payload.get("model")
    job = _new_job("transcribe", project_id)
    background_tasks.add_task(_run_transcribe, project_id, job["id"], model)
    return {"job": job}


@app.post("/api/projects/{project_id}/normalize")
def start_normalize(
    project_id: str,
    background_tasks: BackgroundTasks,
    payload: dict[str, Any] | None = Body(None),
) -> dict[str, Any]:
    """後がけラウドネス正規化（L）。取込時にスキップした素材へ後から掛ける。

    payload: {speakers?: ["A","B"], normalize?: true, target_lufs?, true_peak?, lra?, tolerance?}
    - speakers 省略時は両話者。未知の話者名は 400。
    - normalize=false は「正規化を解除」（元音源から素の形式変換で作り直す）。
    - target_lufs/true_peak/lra/tolerance を渡すと settings を更新した上で適用する。
      true_peak は -9〜0 dBTP、tolerance は 0 以上（範囲外は 400。Issue #37）。
    ブロック（VAD区間）は時間軸不変なので保持する（再VADしない）。
    """
    project = _load_project_or_404(project_id)
    payload = payload or {}
    raw_speakers = payload.get("speakers")
    if raw_speakers is None:
        speakers: list[Speaker] = list(SPEAKERS)
    else:
        if not isinstance(raw_speakers, list):
            raise HTTPException(status_code=400, detail="speakers must be a list")
        speakers = []
        for value in raw_speakers:
            if value not in SPEAKERS:
                raise HTTPException(status_code=400, detail=f"unknown speaker: {value!r}")
            if value not in speakers:  # 重複指定で二度処理しない
                speakers.append(value)
        if not speakers:
            raise HTTPException(status_code=400, detail="speakers must not be empty")
    for speaker in speakers:
        if not project.tracks[speaker].original_file:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"話者 {speaker} の元音源がありません。ラウドネスをかけ直すには、"
                    "元の音声ファイル（speakerX_original.*）も含めて開き直してください"
                ),
            )
    overrides: dict[str, float] = {}
    for key in ("target_lufs", "true_peak", "lra", "tolerance"):
        if key in payload and payload[key] is not None:
            try:
                overrides[key] = float(payload[key])
            except (TypeError, ValueError):
                raise HTTPException(
                    status_code=400, detail=f"invalid value for {key}"
                ) from None
    # 検証は overrides ではなく**実効値**（settings まで遡る）に掛ける（QA #43 指摘）:
    # PUT /api/projects 経由で保存された settings は範囲検証を通っていないため、
    # overrides の無い実行が壊れた保存値（tolerance=inf → 全計測をサイレントスキップ等）
    # をそのまま使うのを起票前に断つ。壊れた保存値はリセットへの導線を detail に含める。
    settings = project.settings or {}
    try:
        _validate_loudnorm_options(
            _coerce_optional_float(
                overrides.get("true_peak", settings.get("true_peak")), "true_peak"
            ),
            _coerce_optional_float(
                overrides.get("tolerance", settings.get("tolerance")), "tolerance"
            ),
        )
    except HTTPException as exc:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{exc.detail}（保存された設定が壊れている場合は、"
                "ラウドネス欄の「リセット」で既定値に戻せます）"
            ),
        ) from None
    normalize = bool(payload.get("normalize", True))
    job = _new_job("normalize", project_id)
    background_tasks.add_task(
        _run_normalize, project_id, job["id"], speakers, normalize, overrides
    )
    return {"job": job}


@app.post("/api/projects/{project_id}/export")
def start_export(
    project_id: str,
    background_tasks: BackgroundTasks,
    payload: dict[str, Any] | None = Body(None),
) -> dict[str, Any]:
    _load_project_or_404(project_id)
    payload = payload or {}
    export_format = str(payload.get("format") or "wav").lower()
    # 未知の形式はジョブを作る前に 400（bundle と同じ規律。ジョブ error に倒すと
    # UI 上は「開始→失敗」となり拒否理由が伝わりにくい）。値の正は exporter.EXPORT_FORMATS。
    if export_format not in EXPORT_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=f"format must be one of {', '.join(EXPORT_FORMATS)}",
        )
    output_dir = payload.get("output_dir")
    if output_dir is not None and not isinstance(output_dir, str):
        raise HTTPException(status_code=400, detail="output_dir must be a string")
    # 同梱モード（既定 "none" = 納品物のみ）。未知の値はジョブを作る前に 400。
    bundle_raw = payload.get("bundle")
    if bundle_raw is None:
        bundle = DEFAULT_BUNDLE_MODE
    elif not isinstance(bundle_raw, str):
        raise HTTPException(status_code=400, detail="bundle must be a string")
    else:
        bundle = bundle_raw.lower()
        if bundle not in BUNDLE_MODES:
            raise HTTPException(
                status_code=400,
                detail=f"bundle must be one of {', '.join(BUNDLE_MODES)}",
            )
    # 許可ベース外の絶対パスはジョブを作る前に 400 で弾く（Issue #18）。
    # ジョブ error に倒すと UI 上は「開始→失敗」となり、拒否理由が伝わりにくい。
    try:
        _resolve_export_target(project_id, output_dir)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    job = _new_job("export", project_id)
    background_tasks.add_task(
        _run_export, project_id, job["id"], output_dir, export_format, bundle
    )
    return {"job": job}


@app.post("/api/projects/{project_id}/export/precheck")
def precheck_export(
    project_id: str, payload: dict[str, Any] | None = Body(None)
) -> dict[str, Any]:
    """エクスポート前の上書き事前チェック（Issue #32）。

    出力先に**前回のエクスポート成果物（と同名のファイル）が実在するか**だけを返す。
    UI はエクスポート押下 → ここで exists=true のときだけ上書き確認ダイアログを出し、
    「はい」で /export を起票する。空フォルダ・初回（exists=false）は従来どおり
    無確認で走る（#28 の「毎回上書きが既定」の意味論は変えない）。

    出力先の解決は start_export と同じ _resolve_export_target を通す
    （許可ベース検証を迂回しない。ベース外の絶対パスはここでも 400）。
    このエンドポイント自体は何も読み書きしない。
    """
    _load_project_or_404(project_id)
    payload = payload or {}
    output_dir = payload.get("output_dir")
    if output_dir is not None and not isinstance(output_dir, str):
        raise HTTPException(status_code=400, detail="output_dir must be a string")
    try:
        target = _resolve_export_target(project_id, output_dir)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    # 判定対象は成果物名のみ（EXPORT_ARTIFACT_NAMES）。無関係なユーザーファイルが
    # あるだけでは確認を出さない（エクスポートはそれらに触らないため）。
    existing = (
        [name for name in EXPORT_ARTIFACT_NAMES if (target / name).is_file()]
        if target.is_dir()
        else []
    )
    return {"output_dir": str(target), "exists": bool(existing), "files": existing}


@app.get("/api/export/targets")
def get_export_targets(project_id: str | None = None) -> dict[str, Any]:
    """書き出し先の選択肢（Issue #18）。

    project_id 省略時は「プロジェクト内」の実パスが決められないため、
    設定済みベースだけを返す（UI 初期化用）。
    """
    if project_id is None:
        configured = export_base_dir()
        targets: list[dict[str, Any]] = []
        if configured is not None:
            targets.append(
                {
                    # 環境変数名は UI に出さない（Issue #32）
                    "label": "設定済みの書き出し先",
                    "path": str(configured),
                    "is_default": False,
                }
            )
        return {"targets": targets, "configured": configured is not None}
    _require_valid_project_id(project_id)
    return {"targets": _export_targets(project_id), "configured": export_base_dir() is not None}


# ---------------------------------------------------------------- システムの既定パス


@app.get("/api/system/paths")
def system_paths() -> dict[str, Any]:
    """フロントの表示用に既定パスを返す（読み取りのみ）。

    取込オーバーレイの「作業フォルダ」未選択時に、抽象的な「既定（アプリ内）」
    ではなく実際に置かれる場所を見せるためのもの。
    """
    return {"default_projects_root": str(projects_root())}


@app.post("/api/system/workdir_precheck")
def precheck_workdir(payload: dict[str, Any] | None = Body(None)) -> dict[str, Any]:
    """取込前の作業フォルダ事前チェック（Issue #53）。

    UI は取込開始押下時にここを呼び、status で分岐する:

    - "existing_project": project.json が実在 = 本物の既存プロジェクト。
      UI が「再開 / 上書き / キャンセル」の確認ダイアログを出す
    - "ok": それ以外。孤児レジストリエントリ（登録だけ残って project.json 無し、
      Issue #34）は create_project 側が透過的に付け替えるため、ここでは
      existing_project にしない = ダイアログを出さずに従来どおり即取込

    precheck_export（Issue #32）と同じ規律: パスの解決は取込本体と同じ
    validate_workdir を通し（ベース検証を迂回しない。拒否パスはここでも 400）、
    このエンドポイント自体は何も読み書きしない。これは UX 用の事前分岐であって
    ガードではない — 最終ガードは create_project 本体が同意フラグ込みで行う。
    """
    payload = payload or {}
    raw = payload.get("workdir")
    if not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="workdir must be a string")
    try:
        resolved = validate_workdir(raw)
    except WorkdirError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # data_dir 配下は create_project の最終ガードで必ず 400 になる指定。
    # precheck が ok を返すとダイアログ無しで取込に進んでから 400 で落ちる
    # UX 不整合になるため、同じ判定（共有ヘルパ）をここでも掛ける。
    _reject_workdir_inside_data_dir(resolved)
    # 判定は create_project の project.json ガードと同じ exists()。派生物名
    # （RESERVED_ARTIFACT_NAMES）だけがある場合は従来どおり create 本体の 400 に
    # 任せる（それは「別のプロジェクト」ではなく同名ファイルの保護なので、
    # 再開/上書きダイアログの対象外）。
    status = "existing_project" if (resolved / "project.json").exists() else "ok"
    return {"status": status, "workdir": str(resolved)}


# ---------------------------------------------------------------- OSのフォルダ選択ダイアログ
#
# 実機フィードバック「finderで出力先指定したい」。ブラウザからはネイティブの
# フォルダ選択ダイアログを開けない（file input はディレクトリの**パス**を返さない）ため、
# サーバ側で OS のダイアログを開いて選ばれた絶対パスだけを返す。
#
# セキュリティは reveal と同じ設計を踏襲する:
#   (1) コマンドは OS ごとに固定の実行ファイル1つ（未対応 OS は 501）
#   (2) shell=False の引数配列
#   (3) **ユーザー入力はコマンドに影響しない** — prompt は AppleScript / zenity の
#       文字列リテラルへ入るため、後述の _sanitize_prompt で引用符・改行・バックスラッシュを
#       除去してからでないと渡さない（スクリプトインジェクション防止）
#   (4) タイムアウト付き（ユーザーが閉じるまで待つので長め）
# 返すのは「選ばれた絶対パス」だけで、このエンドポイント自体は何も読み書きしない。
# 選ばれたパスを実際に使う経路（open の source_dir / export の output_dir）は、
# 従来どおりそれぞれの許可ベース検証を通る。
CHOOSE_FOLDER_TIMEOUT_S = 120.0

# prompt に許さない文字。AppleScript / zenity / PowerShell いずれもスクリプト文字列
# として解釈しうるため、引用符・エスケープ・改行を落としてから埋め込む。
# `$` とバッククォートは PowerShell の二重引用符リテラル内で変数展開・部分式
# （$(...)）・エスケープとして効くため落とす（Issue #36）。
# Unicode スマートクォート（U+2018〜U+201F: 左右シングル/ダブル・低い „ ‟ 等）も
# 落とす。PowerShell のトークナイザはこれらを通常のクォートと同一視するため、
# ASCII クォートだけ除去してもスマートクォート版の U+201C〜U+201E でリテラルを
# 閉じられてインジェクションが成立する（Issue #36 QA指摘）。
_PROMPT_FORBIDDEN = re.compile(r'["\'\\\r\n\x00$`\u2018-\u201f]')
MAX_PROMPT_CHARS = 120

_DEFAULT_PROMPTS = {
    "open": "プロジェクトのフォルダを選んでください",
    "export": "書き出し先のフォルダを選んでください",
    "workdir": "プロジェクトの作業フォルダを選んでください",
}


def _sanitize_prompt(raw: Any, default: str) -> str:
    """ダイアログの見出し文字列を安全な形に正規化する。

    引用符・バックスラッシュ・改行・PowerShell メタ文字（$ とバッククォート）を
    除去してから長さを切り詰める。空になったら既定文へ倒す（ダイアログが無題で
    出るのを防ぐ）。
    """
    if raw is None:
        return default
    if not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="prompt must be a string")
    cleaned = _PROMPT_FORBIDDEN.sub("", raw).strip()[:MAX_PROMPT_CHARS]
    return cleaned or default


def _choose_folder_command(prompt: str) -> list[str]:
    """OS ごとのフォルダ選択ダイアログ起動コマンド（引数配列）。

    未対応 OS・必要なバイナリが無い環境は 501。prompt は _sanitize_prompt 済みで
    引用符・改行を含まないことが前提（ここでリテラルへ埋め込む）。
    """
    if sys.platform.startswith("darwin"):
        return [
            "osascript",
            "-e",
            f'POSIX path of (choose folder with prompt "{prompt}")',
        ]
    if sys.platform.startswith("linux"):
        if shutil.which("zenity") is None:
            raise HTTPException(
                status_code=501,
                detail="フォルダ選択ダイアログを開けません（zenity が見つかりません）",
            )
        return ["zenity", "--file-selection", "--directory", f"--title={prompt}"]
    if sys.platform.startswith("win32"):
        powershell = shutil.which("powershell") or shutil.which("pwsh")
        if powershell is None:
            raise HTTPException(
                status_code=501,
                detail="フォルダ選択ダイアログを開けません（PowerShell が見つかりません）",
            )
        script = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
            f'$d.Description = "{prompt}";'
            "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK)"
            "{ [Console]::Out.Write($d.SelectedPath) }"
        )
        return [powershell, "-NoProfile", "-NonInteractive", "-Command", script]
    raise HTTPException(
        status_code=501, detail=f"folder chooser is not supported on {sys.platform}"
    )


def _run_chooser(command: list[str], what: str) -> str:
    """ダイアログ用サブプロセスを実行し、選択結果（stdout を strip した文字列）を返す。

    空文字はキャンセル。判定は **stdout のみ** で行う。macOS の osascript は
    GUI セッションの状態次第で stderr に大量の警告を吐くが、選択自体は成功して
    いることがある（実機で確認）。stderr の有無を失敗と見なすと、正常に選んだのに
    エラーになる。
    """
    try:
        completed = subprocess.run(  # noqa: S603 — 実行ファイルは固定、引数はサニタイズ済み
            command,
            shell=False,
            check=False,
            timeout=CHOOSE_FOLDER_TIMEOUT_S,
            capture_output=True,
            text=True,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=504, detail=f"{what}がタイムアウトしました"
        ) from None
    except (OSError, subprocess.SubprocessError) as exc:
        raise HTTPException(
            status_code=501, detail=f"{what}ダイアログを開けません: {exc}"
        ) from None
    return (completed.stdout or "").strip()


@app.post("/api/system/choose_folder")
def choose_folder(payload: dict[str, Any] | None = Body(None)) -> dict[str, Any]:
    """OS のフォルダ選択ダイアログを開き、選ばれた絶対パスを返す。

    - `purpose`: "open" | "export" | "workdir"（既定のダイアログ見出しの出し分けだけに使う）
    - `prompt`: 見出しの上書き（任意）。サニタイズしてから埋め込む

    応答:
    - 選択  → 200 `{"path": "/abs/path", "cancelled": false}`
    - キャンセル → 200 `{"path": null, "cancelled": true}`（**エラーにしない**。
      ユーザーが「やっぱりやめた」を選ぶのは正常系で、UI に赤いトーストを出す筋合いはない）
    - 未対応 OS / ダイアログを開けない → 501
    """
    payload = payload or {}
    purpose = str(payload.get("purpose") or "open").lower()
    if purpose not in _DEFAULT_PROMPTS:
        raise HTTPException(
            status_code=400, detail="purpose must be 'open', 'export' or 'workdir'"
        )
    prompt = _sanitize_prompt(payload.get("prompt"), _DEFAULT_PROMPTS[purpose])
    command = _choose_folder_command(prompt)  # 未対応 OS はここで 501
    selected = _run_chooser(command, "フォルダ選択")
    if not selected:
        # キャンセル（osascript は -128 / zenity は exit 1 / PowerShell は空出力）。
        # 異常終了と区別がつかないが、どちらでもユーザーに返す答えは同じ「選ばれなかった」。
        return {"path": None, "cancelled": True}
    path = Path(selected).expanduser()
    if not path.is_absolute() or not path.is_dir():
        # ダイアログが返す値は常に実在ディレクトリの絶対パスのはず。想定外は通さない。
        raise HTTPException(status_code=500, detail="選択されたパスが不正です")
    resolved = path.resolve()
    if purpose == "export":
        # 書き出し先として選ばれたフォルダだけを許可ベースに積む。
        # "open" は読み取り経路（source_dir）で、そちらは別の検証を通るため積まない。
        # "workdir" も積まない: 作業フォルダの許可判断は registry + validate_workdir の責務。
        _remember_chosen_dir(resolved)
    return {"path": str(resolved), "cancelled": False}


# ファイル選択ダイアログ（choose_folder と同じ規律）。今の用途は取込オーバーレイの
# 「project.json から復元」だけなので purpose も project_json のみ受け付ける。
_CHOOSE_FILE_PROMPTS = {
    "project_json": "project.json を選んでください",
}


def _choose_file_command(prompt: str) -> list[str]:
    """OS ごとのファイル選択ダイアログ起動コマンド（引数配列）。

    _choose_folder_command と同じ規律。フィルタは可能な範囲で JSON に絞る
    （絞れない OS はサーバ側 /api/projects/open の検証に委ねる）。
    """
    if sys.platform.startswith("darwin"):
        return [
            "osascript",
            "-e",
            f'POSIX path of (choose file with prompt "{prompt}" of type {{"public.json"}})',
        ]
    if sys.platform.startswith("linux"):
        if shutil.which("zenity") is None:
            raise HTTPException(
                status_code=501,
                detail="ファイル選択ダイアログを開けません（zenity が見つかりません）",
            )
        return ["zenity", "--file-selection", f"--title={prompt}", "--file-filter=*.json"]
    if sys.platform.startswith("win32"):
        powershell = shutil.which("powershell") or shutil.which("pwsh")
        if powershell is None:
            raise HTTPException(
                status_code=501,
                detail="ファイル選択ダイアログを開けません（PowerShell が見つかりません）",
            )
        script = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "$d = New-Object System.Windows.Forms.OpenFileDialog;"
            f'$d.Title = "{prompt}";'
            '$d.Filter = "JSON (*.json)|*.json";'
            "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK)"
            "{ [Console]::Out.Write($d.FileName) }"
        )
        return [powershell, "-NoProfile", "-NonInteractive", "-Command", script]
    raise HTTPException(
        status_code=501, detail=f"file chooser is not supported on {sys.platform}"
    )


@app.post("/api/system/choose_file")
def choose_file(payload: dict[str, Any] | None = Body(None)) -> dict[str, Any]:
    """OS のファイル選択ダイアログを開き、選ばれた絶対パスを返す。

    応答契約は choose_folder と同じ（キャンセルは 200 + cancelled=true の正常系）。
    選ばれたパスは許可ベース（_chosen_dirs）に**積まない** — このエンドポイントは
    何も読み書きせず、開く経路の検証は /api/projects/open 側の責務。
    """
    payload = payload or {}
    purpose = str(payload.get("purpose") or "").lower()
    if purpose not in _CHOOSE_FILE_PROMPTS:
        raise HTTPException(status_code=400, detail="purpose must be 'project_json'")
    prompt = _sanitize_prompt(payload.get("prompt"), _CHOOSE_FILE_PROMPTS[purpose])
    command = _choose_file_command(prompt)  # 未対応 OS はここで 501
    selected = _run_chooser(command, "ファイル選択")
    if not selected:
        return {"path": None, "cancelled": True}
    path = Path(selected).expanduser()
    if not path.is_absolute() or not path.is_file():
        # ダイアログが返す値は常に実在ファイルの絶対パスのはず。想定外は通さない。
        raise HTTPException(status_code=500, detail="選択されたパスが不正です")
    return {"path": str(path.resolve()), "cancelled": False}


# G: 「Finderで開く」。ローカルバインド前提のツールだが、この機能はサーバ上で
# GUI アプリを起動しうるため、(1) 開けるのは許可ベース配下だけ（exports 等 +
# 作業フォルダそのもの。_resolve_reveal_target 参照）
# (2) コマンドは OS ごとに固定の実行ファイル1つ (3) shell=False の引数配列
# (4) タイムアウト付き、の4点を厳格に守る。任意パス・任意コマンドは通さない。
REVEAL_TIMEOUT_S = 10.0
_REVEAL_COMMANDS: dict[str, str] = {
    "darwin": "open",
    "linux": "xdg-open",
    "win32": "explorer",
}


def _reveal_command_for_platform() -> str:
    for prefix, command in _REVEAL_COMMANDS.items():
        if sys.platform.startswith(prefix):
            return command
    raise HTTPException(status_code=501, detail=f"reveal is not supported on {sys.platform}")


def _resolve_reveal_target(project_id: str, raw_path: Any) -> Path:
    """開く対象を**許可されたベース配下**に限定して解決する。

    許可ベース 1〜3 は _resolve_export_target と同一（Issue #18 で PODCAST_PREP_EXPORT_DIR が
    加わったため、書き出せる場所は必ず開けるようにここも揃える。揃っていないと
    EXPORT_DIR へ書き出した直後に「Finderで開く」が 400 になる — 実機で発生）:
      1. プロジェクトの `exports/`（常に許可・既定）
      2. `PODCAST_PREP_EXPORT_DIR`（設定されているときだけ）
      3. フォルダ選択ダイアログで選ばれたフォルダ（`_chosen_dirs`）
      4. 作業フォルダ**そのもの**（`project_dir(pid)` ちょうど。設定パネルの
         「Finderで開く」用。配下の個別ファイルまでは開放しない = exports 限定は維持）

    未指定時は exports 自身（Issue #28 で既定の書き出し先が exports 直下になった
    ことに追随。それ以前は「最も新しいサブディレクトリ」を探していた）。
    許可ベース外を指す値・シンボリックリンク越しの脱出は 400、不在は 404。
    """
    workdir_root = project_dir(project_id).resolve()
    exports_base = (workdir_root / "exports").resolve()
    configured_base = export_base_dir()
    allowed_bases = [exports_base]
    if configured_base is not None:
        allowed_bases.append(configured_base)
    # 書き出せる場所は必ず開けるようにする（ダイアログで選んだ先も同様。揃っていないと
    # 選んだフォルダへ書き出した直後に「Finderで開く」が 400 になる）
    allowed_bases.extend(_chosen_dir_bases())

    if raw_path is None or raw_path == "":
        if not exports_base.is_dir():
            raise HTTPException(status_code=404, detail="no exports directory yet")
        # 既定の書き出し先がそのまま exports 直下なので、exports 自身を開けばよい
        # （ラベル書き出しのサブフォルダも exports を開けば見える）
        return exports_base
    if not isinstance(raw_path, str):
        raise HTTPException(status_code=400, detail="path must be a string")
    # resolve() でシンボリックリンクを潰してから包含判定する（リンク経由の脱出防止）
    candidate = Path(raw_path).expanduser()
    is_absolute_input = candidate.is_absolute()
    if not is_absolute_input:
        candidate = exports_base / candidate
    target = candidate.resolve()
    # 作業フォルダ root は**絶対パス指定**のときだけ許す（UI は payload.workdir の
    # 絶対パスを送る）。相対 ".." で exports から root へ抜ける経路は従来どおり 400
    # （トラバーサル拒否の既存契約を変えない）。
    allow_workdir_root = is_absolute_input and target == workdir_root
    if not allow_workdir_root and not any(
        _is_within(base, target) for base in allowed_bases
    ):
        raise HTTPException(
            status_code=400, detail="path escapes allowed export directories"
        )
    if not target.exists():
        raise HTTPException(status_code=404, detail="path not found")
    return target


@app.post("/api/projects/{project_id}/reveal")
def reveal_path(project_id: str, payload: dict[str, Any] | None = Body(None)) -> dict[str, Any]:
    """エクスポート先を OS のファイルマネージャで開く（G: Finderで開く）。"""
    _load_project_or_404(project_id)
    command = _reveal_command_for_platform()  # 未対応 OS は 501（パス検証より先に弾く）
    target = _resolve_reveal_target(project_id, (payload or {}).get("path"))
    try:
        subprocess.run(  # noqa: S603 — command は固定、引数は exports 配下に検証済み
            [command, str(target)],
            shell=False,
            check=False,
            timeout=REVEAL_TIMEOUT_S,
            capture_output=True,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise HTTPException(status_code=500, detail=f"failed to reveal path: {exc}") from None
    return {"revealed": str(target)}


@app.get("/api/projects/{project_id}/raw")
def get_project_raw(project_id: str) -> dict[str, Any]:
    try:
        return load_project_dict(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="project not found") from None


@app.put("/api/projects/{project_id}/raw")
def put_project_raw(project_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    if payload.get("id") != project_id:
        raise HTTPException(status_code=400, detail="project id mismatch")
    _require_valid_project_id(project_id)
    try:
        # ラウンドトリップ検証: 保存物が ProjectState として再ロード可能であることを保証
        # （壊れたJSONを書いてプロジェクトが開けなくなる事故の防止）
        ProjectState.from_dict(payload)
    except (KeyError, ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(status_code=400, detail=f"invalid project document: {exc}") from None
    save_project_dict(payload)
    return {"project": payload}
