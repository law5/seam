from __future__ import annotations

import array
import csv
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
import wave
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from .models import Block, Overlap, Speaker
from .timeline import active_blocks

SAMPLE_RATE = 48000
SAMPLE_WIDTH = 2
CHANNELS = 1


class AudioProcessingError(RuntimeError):
    pass


def _parse_progress_value(line: str) -> float | None:
    """ffmpeg -progress の1行から経過秒を返す。対象外の行は None。

    out_time_ms / out_time_us はともにマイクロ秒（ffmpeg仕様の既知の癖）、
    out_time は HH:MM:SS.micro 形式。値が N/A 等の場合も None。
    """
    key, sep, value = line.strip().partition("=")
    if not sep:
        return None
    value = value.strip()
    if key in ("out_time_ms", "out_time_us"):
        try:
            return int(value) / 1_000_000
        except ValueError:
            return None
    if key == "out_time":
        match = re.fullmatch(r"(-?)(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)", value)
        if not match:
            return None
        sign = -1.0 if match.group(1) else 1.0
        return sign * (
            int(match.group(2)) * 3600 + int(match.group(3)) * 60 + float(match.group(4))
        )
    return None


def run_ffmpeg(
    args: list[str],
    *,
    timeout: float = 3600.0,
    progress_callback: Callable[[float], None] | None = None,
    total_duration: float | None = None,
) -> subprocess.CompletedProcess[str]:
    """ffmpeg/ffprobe 実行の単一チョークポイント。

    progress_callback を渡すと '-progress pipe:1' を注入し、stdout の
    out_time 系行から 0..1 の進捗を通知する（loudnorm の JSON は stderr に
    出るため progress は必ず stdout 側に出す）。timeout 超過は TimeoutError。
    """
    cmd = list(args)
    if progress_callback is not None:
        extra = ["-progress", "pipe:1"]
        if "-nostats" not in cmd:
            extra.append("-nostats")
        cmd[1:1] = extra
    proc = subprocess.Popen(
        cmd,
        text=True,
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    stdout_parts: list[str] = []
    stderr_parts: list[str] = []

    def _drain_stdout() -> None:
        for line in proc.stdout:  # type: ignore[union-attr]
            stdout_parts.append(line)
            if progress_callback is None:
                continue
            seconds = _parse_progress_value(line)
            if seconds is None or not total_duration or total_duration <= 0:
                continue
            try:
                progress_callback(max(0.0, min(1.0, seconds / total_duration)))
            except Exception:
                pass  # 進捗は装飾。ドレインを止めない

    def _drain_stderr() -> None:
        stderr_parts.append(proc.stderr.read())  # type: ignore[union-attr]

    readers = [
        threading.Thread(target=_drain_stdout, daemon=True),
        threading.Thread(target=_drain_stderr, daemon=True),
    ]
    for reader in readers:
        reader.start()
    try:
        returncode = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        for reader in readers:
            reader.join(timeout=5.0)
        raise TimeoutError(
            f"command timed out after {timeout:g}s: {' '.join(cmd)}"
        ) from None
    for reader in readers:
        reader.join(timeout=5.0)
    completed = subprocess.CompletedProcess(
        cmd, returncode, "".join(stdout_parts), "".join(stderr_parts)
    )
    if returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise AudioProcessingError(f"command failed: {' '.join(cmd)}\n{detail}")
    return completed


def ensure_ffmpeg() -> None:
    run_ffmpeg(["ffmpeg", "-version"])
    run_ffmpeg(["ffprobe", "-version"])


def ffprobe_duration(path: Path) -> float:
    proc = run_ffmpeg(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(path),
        ]
    )
    data = json.loads(proc.stdout)
    return float(data["format"]["duration"])


def _extract_loudnorm_json(stderr: str) -> dict[str, Any]:
    matches = re.findall(r"\{[\s\S]*?\}", stderr)
    if not matches:
        raise AudioProcessingError("ffmpeg loudnorm did not return JSON")
    return json.loads(matches[-1])


def loudnorm_measure(
    input_path: Path,
    target_i: float = -16.0,
    true_peak: float = -1.5,
    lra: float = 11.0,
    progress_callback: Callable[[float], None] | None = None,
    total_duration: float | None = None,
) -> dict[str, Any]:
    filter_expr = f"loudnorm=I={target_i}:TP={true_peak}:LRA={lra}:print_format=json"
    proc = run_ffmpeg(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(input_path),
            "-af",
            filter_expr,
            "-f",
            "null",
            "-",
        ],
        progress_callback=progress_callback,
        total_duration=total_duration,
    )
    return _extract_loudnorm_json(proc.stderr)


def should_skip_loudnorm(measured_i: float, target_i: float, tolerance: float) -> bool:
    """計測ラウドネスが 目標±許容量(LU) 以内なら True（loudnorm 適用をスキップ）。

    tolerance <= 0 は「常に正規化する」（従来挙動）。境界値ちょうど
    （|差| == tolerance）はスキップ側に倒す（Issue #37）。
    """
    tolerance = float(tolerance)
    if tolerance <= 0.0:
        return False
    return abs(float(measured_i) - float(target_i)) <= tolerance


def normalize_loudnorm(
    input_path: Path,
    output_path: Path,
    target_i: float = -16.0,
    true_peak: float = -1.5,
    lra: float = 11.0,
    tolerance: float = 0.0,
    progress: Callable[[float], None] | None = None,
) -> dict[str, Any]:
    """loudnorm 3パス（計測→linear適用→検証）。progress は全体を 0..1 で通知。

    重み付けは 計測0.35 / 適用0.45 / 検証0.20。適用パスの loudnorm JSON の
    normalization_type が linear でなければ（TP制約による dynamic への暗黙
    フォールバック）結果 dict に "normalization_fallback": true を含める。

    tolerance > 0 のとき、計測パス（1段目）の input_i が 目標±tolerance 以内なら
    loudnorm 適用をスキップし、convert_to_pcm と同じフィルタなし形式変換で
    output_path を作る（後段パイプラインは speakerX_normalized.wav の存在を
    前提にするため、成果物は必ず作る）。スキップ時は結果 dict に
    "normalization_skipped": true と計測値（"input"）を含める
    （normalization_fallback と同じ記録の流儀。Issue #37）。
    進捗は 計測0.35 / 変換0.65 に読み替えて 0..1 の単調性を保つ。
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    total = None
    if progress is not None:
        try:
            total = ffprobe_duration(input_path)
        except (AudioProcessingError, TimeoutError, KeyError, ValueError):
            total = None

    def _stage(base: float, span: float) -> Callable[[float], None] | None:
        if progress is None:
            return None

        def callback(fraction: float) -> None:
            progress(min(1.0, base + span * max(0.0, min(1.0, fraction))))

        return callback

    measured = loudnorm_measure(
        input_path,
        target_i=target_i,
        true_peak=true_peak,
        lra=lra,
        progress_callback=_stage(0.0, 0.35),
        total_duration=total,
    )
    if progress is not None:
        progress(0.35)
    if should_skip_loudnorm(float(measured["input_i"]), target_i, tolerance):
        # 目標±許容量以内: loudnorm を通さず normalize=False 経路（convert_to_pcm）を
        # 再利用してフィルタなし変換で同じ成果物（48kHz/mono/s16 WAV）だけ作る。
        convert_to_pcm(input_path, output_path, progress=_stage(0.35, 0.65))
        if progress is not None:
            progress(1.0)
        return {
            "target_i": target_i,
            "input": measured,
            "normalized": None,  # 適用・検証パスなし
            "loudness_normalized": True,
            "normalization_skipped": True,
        }
    filter_expr = (
        f"loudnorm=I={target_i}:TP={true_peak}:LRA={lra}:"
        f"measured_I={measured['input_i']}:"
        f"measured_TP={measured['input_tp']}:"
        f"measured_LRA={measured['input_lra']}:"
        f"measured_thresh={measured['input_thresh']}:"
        f"offset={measured['target_offset']}:"
        "linear=true:print_format=json"
    )
    applied_proc = run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-nostats",
            "-i",
            str(input_path),
            "-af",
            filter_expr,
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            str(CHANNELS),
            "-sample_fmt",
            "s16",
            str(output_path),
        ],
        progress_callback=_stage(0.35, 0.45),
        total_duration=total,
    )
    if progress is not None:
        progress(0.80)
    verified = loudnorm_measure(
        output_path,
        target_i=target_i,
        true_peak=true_peak,
        lra=lra,
        progress_callback=_stage(0.80, 0.20),
        total_duration=total,
    )
    if progress is not None:
        progress(1.0)
    result: dict[str, Any] = {
        "target_i": target_i,
        "input": measured,
        "normalized": verified,
        # convert_to_pcm（正規化スキップ）と同じキー構成にして呼び出し側の分岐を減らす。
        "loudness_normalized": True,
    }
    try:
        applied = _extract_loudnorm_json(applied_proc.stderr)
    except AudioProcessingError:
        applied = {}
    normalization_type = str(applied.get("normalization_type", "")).strip().lower()
    if normalization_type and normalization_type != "linear":
        result["normalization_fallback"] = True
    return result


def convert_to_pcm(
    input_path: Path,
    output_path: Path,
    sample_rate: int = SAMPLE_RATE,
    progress: Callable[[float], None] | None = None,
) -> dict[str, Any]:
    """ラウドネス正規化なしの形式変換のみ（48kHz/mono/s16 WAV）。

    返り値は normalize_loudnorm と同じキー構成の dict にする（呼び出し側の
    分岐を減らすため）。計測していないので "input"/"normalized" は None、
    "target_i" も None。正規化済みかどうかは "loudness_normalized": False で
    判別できる（normalize_loudnorm 側は True）。
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    total = None
    if progress is not None:
        try:
            total = ffprobe_duration(input_path)
        except (AudioProcessingError, TimeoutError, KeyError, ValueError):
            total = None

    def _forward(fraction: float) -> None:
        if progress is not None:
            progress(max(0.0, min(1.0, fraction)))

    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-nostats",
            "-i",
            str(input_path),
            "-ar",
            str(int(sample_rate)),
            "-ac",
            str(CHANNELS),
            "-sample_fmt",
            "s16",
            str(output_path),
        ],
        progress_callback=None if progress is None else _forward,
        total_duration=total,
    )
    if progress is not None:
        progress(1.0)
    return {
        "target_i": None,
        "input": None,
        "normalized": None,
        "loudness_normalized": False,
    }


def wave_info(path: Path) -> dict[str, int | float]:
    with wave.open(str(path), "rb") as wf:
        return {
            "channels": wf.getnchannels(),
            "sample_width": wf.getsampwidth(),
            "sample_rate": wf.getframerate(),
            "frames": wf.getnframes(),
            "duration": wf.getnframes() / wf.getframerate(),
        }


def _samples_from_bytes(data: bytes) -> array.array:
    samples = array.array("h")
    samples.frombytes(data)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def _deesser_filter(strength: float) -> str:
    """スライダー値 s∈[0,1] を deesser の実効レンジへ再マッピングした文字列を返す。

    実測根拠: -16 LUFS 正規化済み素材では i<=0.3 が完全デッドゾーン
    （i はトリガー感度）、m は小さいほど強く 0.5 既定では減衰不足のため、
    i=0.3+0.5*s / m=max(0.1, 0.5-0.4*s) で全域を知覚可能な効きに割り当てる。
    """
    s = max(0.0, min(1.0, float(strength)))
    intensity = 0.3 + 0.5 * s
    max_deessing = max(0.1, 0.5 - 0.4 * s)
    return f"deesser=i={intensity:.3f}:m={max_deessing:.3f}"


def generate_peak_data(path: Path, max_points: int = 6000) -> list[float]:
    with wave.open(str(path), "rb") as wf:
        if wf.getsampwidth() != SAMPLE_WIDTH:
            raise AudioProcessingError("peak generation expects 16-bit PCM WAV")
        total_frames = wf.getnframes()
        if total_frames <= 0:
            return []
        bucket_frames = max(1, math.ceil(total_frames / max_points))
        peaks: list[float] = []
        while True:
            data = wf.readframes(bucket_frames)
            if not data:
                break
            samples = _samples_from_bytes(data)
            if wf.getnchannels() > 1:
                samples = array.array("h", samples[:: wf.getnchannels()])
            peak = max((abs(sample) for sample in samples), default=0) / 32768.0
            peaks.append(round(float(peak), 5))
        return peaks


def generate_peak_bins(path: Path, bins_per_sec: int = 200) -> bytes:
    """波形ピークを PPK1 バイナリで返す（サイドカー speaker{A,B}_peaks.u8 用）。

    形式: magic "PPK1"(4B) + uint32LE bins_per_sec + uint32LE bin_count +
    uint32LE reserved(0) + uint8×bin_count。各ビンはバケット
    （sample_rate/bins_per_sec フレーム、48kHz/200bins で240）内の
    max(abs(sample))/32768*255 の丸め。マルチチャンネルは ch0 のみ。
    """
    if bins_per_sec <= 0:
        raise ValueError("bins_per_sec must be > 0")
    bins = bytearray()
    with wave.open(str(path), "rb") as wf:
        if wf.getsampwidth() != SAMPLE_WIDTH:
            raise AudioProcessingError("peak generation expects 16-bit PCM WAV")
        channels = wf.getnchannels()
        bucket_frames = max(1, round(wf.getframerate() / bins_per_sec))
        carry = np.empty(0, dtype=np.int32)
        while True:
            data = wf.readframes(bucket_frames * 1024)
            if not data:
                break
            samples = np.frombuffer(data, dtype="<i2")
            if channels > 1:
                samples = samples[::channels]
            magnitudes = np.abs(samples.astype(np.int32))
            if carry.size:
                magnitudes = np.concatenate([carry, magnitudes])
            full = (magnitudes.size // bucket_frames) * bucket_frames
            if full:
                maxima = magnitudes[:full].reshape(-1, bucket_frames).max(axis=1)
                values = ((maxima * 255 + 16384) // 32768).clip(max=255)
                bins.extend(values.astype(np.uint8).tobytes())
            carry = magnitudes[full:]
        if carry.size:
            bins.append(min(255, (int(carry.max()) * 255 + 16384) // 32768))
    header = b"PPK1" + struct.pack("<III", bins_per_sec, len(bins), 0)
    return bytes(header) + bytes(bins)


def apply_track_filters(
    input_wav: Path,
    output_wav: Path,
    gain_db: float = 0.0,
    deesser: float = 0.0,
) -> None:
    output_wav.parent.mkdir(parents=True, exist_ok=True)
    info = wave_info(input_wav)
    needs_transcode = (
        info["sample_rate"] != SAMPLE_RATE
        or info["channels"] != CHANNELS
        or info["sample_width"] != SAMPLE_WIDTH
    )
    filters: list[str] = []
    strength = max(0.0, min(1.0, float(deesser)))
    if strength > 0.0001:
        filters.append(_deesser_filter(strength))
    if abs(float(gain_db)) > 0.0001:
        filters.append(f"volume={float(gain_db):.3f}dB")
    if not filters and not needs_transcode:
        shutil.copyfile(input_wav, output_wav)
        return
    if not filters:
        filters.append("anull")
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-nostats",
            "-i",
            str(input_wav),
            "-af",
            ",".join(filters),
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            str(CHANNELS),
            "-sample_fmt",
            "s16",
            str(output_wav),
        ]
    )


def render_preview_segment(
    input_wav: Path,
    output_wav: Path,
    start: float,
    duration: float,
    gain_db: float = 0.0,
    deesser: float = 0.0,
) -> None:
    filters: list[str] = []
    strength = max(0.0, min(1.0, float(deesser)))
    if strength > 0.0001:
        filters.append(_deesser_filter(strength))
    if abs(float(gain_db)) > 0.0001:
        filters.append(f"volume={float(gain_db):.3f}dB")
    if not filters:
        filters.append("anull")
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-nostats",
            "-ss",
            f"{max(0.0, start):.3f}",
            "-t",
            f"{max(0.05, duration):.3f}",
            "-i",
            str(input_wav),
            "-af",
            ",".join(filters),
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            str(CHANNELS),
            "-sample_fmt",
            "s16",
            str(output_wav),
        ]
    )


def _write_silent_wav(path: Path, frames: int, sample_rate: int = SAMPLE_RATE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    silence = b"\x00\x00" * min(sample_rate, max(1, frames))
    remaining = frames
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(sample_rate)
        while remaining > 0:
            chunk_frames = min(remaining, len(silence) // SAMPLE_WIDTH)
            wf.writeframesraw(silence[: chunk_frames * SAMPLE_WIDTH])
            remaining -= chunk_frames


def _find_wav_data_offset(path: Path) -> int:
    with path.open("rb") as handle:
        if handle.read(4) != b"RIFF":
            raise AudioProcessingError("not a RIFF file")
        handle.seek(8)
        if handle.read(4) != b"WAVE":
            raise AudioProcessingError("not a WAVE file")
        while True:
            chunk_id = handle.read(4)
            if len(chunk_id) < 4:
                break
            chunk_size_bytes = handle.read(4)
            if len(chunk_size_bytes) < 4:
                break
            chunk_size = int.from_bytes(chunk_size_bytes, "little")
            if chunk_id == b"data":
                return handle.tell()
            handle.seek(chunk_size + (chunk_size % 2), os.SEEK_CUR)
    raise AudioProcessingError("WAV data chunk not found")


def _mix_samples(existing: bytes, incoming: np.ndarray) -> bytes:
    """既存 i16 バイト列に incoming(int16 ndarray) を加算合成して返す（i16クランプ）。"""
    current = np.frombuffer(existing, dtype="<i2").astype(np.int32)
    if current.size < incoming.size:
        current = np.concatenate(
            [current, np.zeros(incoming.size - current.size, dtype=np.int32)]
        )
    mixed = current[: incoming.size] + incoming.astype(np.int32)
    np.clip(mixed, -32768, 32767, out=mixed)
    return mixed.astype("<i2").tobytes()


def _apply_edge_fade(
    samples: np.ndarray,
    chunk_start_in_segment: int,
    segment_frames: int,
    fade_frames: int,
) -> np.ndarray:
    """セグメント両端 fade_frames 区間だけ線形フェード（int16 ndarray）。

    フェード区間に触れないチャンクは無走査で入力をそのまま返す
    （旧ピュアPython実装と数値完全一致、丸めは round-half-even）。
    """
    if fade_frames <= 0 or samples.size == 0:
        return samples
    n = int(samples.size)
    start = int(chunk_start_in_segment)
    head_end = min(max(fade_frames - start, 0), n)
    tail_start = min(max(segment_frames - fade_frames - start, 0), n)
    if head_end <= 0 and tail_start >= n:
        return samples
    spans: list[tuple[int, int]] = []
    if head_end > 0:
        spans.append((0, head_end))
    if tail_start < n:
        if spans and tail_start < head_end:
            spans = [(0, n)]
        else:
            spans.append((tail_start, n))
    out = samples.astype(np.int16, copy=True)
    for lo, hi in spans:
        positions = np.arange(start + lo, start + hi, dtype=np.float64)
        factor = np.minimum(positions / fade_frames, 1.0)
        remaining = segment_frames - positions - 1.0
        factor = np.minimum(factor, np.clip(remaining / fade_frames, 0.0, 1.0))
        scaled = np.rint(out[lo:hi].astype(np.float64) * factor)
        out[lo:hi] = np.clip(scaled, -32768.0, 32767.0).astype(np.int16)
    return out


def _block_dest_end_frame(block: Block, sample_rate: int) -> int:
    """書き込み側と同一の丸め式（round ベース）で dest 終端フレームを返す。

    確保サイズをこの式に統一し、ceil/round の丸め差で data チャンクを
    超えて書き込む不整合を防ぐ。
    """
    source_start = int(round(block.source_start * sample_rate))
    source_end = int(round(block.source_end * sample_rate))
    dest_start = int(round(block.start * sample_rate))
    return dest_start + max(0, source_end - source_start)


def render_edited_track(
    source_wav: Path,
    blocks: list[Block],
    speaker: Speaker,
    output_wav: Path,
    gain_db: float = 0.0,
    deesser: float = 0.0,
    crossfade_ms: float = 10.0,
    minimum_duration: float = 0.0,
    progress: Callable[[float], None] | None = None,
) -> None:
    relevant = active_blocks(blocks, speaker)
    sample_rate = SAMPLE_RATE
    output_frames = max(
        [math.ceil(max(0.0, minimum_duration) * sample_rate), 1]
        + [_block_dest_end_frame(block, sample_rate) for block in relevant]
    )
    _write_silent_wav(output_wav, output_frames, sample_rate=sample_rate)
    if not relevant:
        if progress is not None:
            progress(1.0)
        return

    with tempfile.TemporaryDirectory(prefix="podcast-prep-render-") as tmpdir:
        filtered = Path(tmpdir) / f"{speaker}_filtered.wav"
        apply_track_filters(source_wav, filtered, gain_db=gain_db, deesser=deesser)
        info = wave_info(filtered)
        if (
            info["sample_rate"] != sample_rate
            or info["channels"] != CHANNELS
            or info["sample_width"] != SAMPLE_WIDTH
        ):
            raise AudioProcessingError("filtered source is not 48kHz/16-bit/mono WAV")
        data_offset = _find_wav_data_offset(output_wav)
        fade_frames = int(sample_rate * max(0.0, crossfade_ms) / 1000)
        with wave.open(str(filtered), "rb") as src, output_wav.open("r+b") as dst:
            for index, block in enumerate(relevant):
                source_start = int(round(block.source_start * sample_rate))
                source_end = int(round(block.source_end * sample_rate))
                dest_start = int(round(block.start * sample_rate))
                segment_frames = max(0, source_end - source_start)
                if segment_frames <= 0:
                    if progress is not None:
                        progress((index + 1) / len(relevant))
                    continue
                if dest_start < 0:
                    trim = -dest_start
                    source_start += trim
                    segment_frames -= trim
                    dest_start = 0
                source_start = max(0, source_start)
                if source_start >= src.getnframes() or segment_frames <= 0:
                    if progress is not None:
                        progress((index + 1) / len(relevant))
                    continue
                segment_frames = min(segment_frames, src.getnframes() - source_start)
                src.setpos(source_start)
                remaining = segment_frames
                written = 0
                while remaining > 0:
                    chunk_frames = min(32768, remaining)
                    raw = src.readframes(chunk_frames)
                    if not raw:
                        break
                    samples = np.frombuffer(raw, dtype="<i2")
                    actual_frames = int(samples.size)
                    samples = _apply_edge_fade(
                        samples,
                        chunk_start_in_segment=written,
                        segment_frames=segment_frames,
                        fade_frames=fade_frames,
                    )
                    dest_frame = dest_start + written
                    dst.seek(data_offset + dest_frame * SAMPLE_WIDTH)
                    existing = dst.read(actual_frames * SAMPLE_WIDTH)
                    if len(existing) < actual_frames * SAMPLE_WIDTH:
                        existing += b"\x00" * (actual_frames * SAMPLE_WIDTH - len(existing))
                    dst.seek(data_offset + dest_frame * SAMPLE_WIDTH)
                    dst.write(_mix_samples(existing, samples))
                    remaining -= actual_frames
                    written += actual_frames
                if progress is not None:
                    progress((index + 1) / len(relevant))


def encode_mp3(input_wav: Path, output_mp3: Path, *, bitrate_kbps: int = 320) -> None:
    """WAV → MP3（libmp3lame・CBR）。

    Issue #32 でビットレートを引数化（従来は 320k 固定の encode_mp3_320）。
    既定値 320 は従来挙動と同一。
    """
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-nostats",
            "-i",
            str(input_wav),
            "-codec:a",
            "libmp3lame",
            "-b:a",
            f"{int(bitrate_kbps)}k",
            str(output_mp3),
        ]
    )


def write_overlaps_csv(overlaps: list[Overlap], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        # 旧 4列目 `resolved` は削除（2026-08）。true にする経路が無く常に "false" の
        # 定数列だったため、外部（Premiere 等）にとって情報量ゼロだった。
        writer.writerow(["start", "end", "duration"])
        for overlap in overlaps:
            writer.writerow(
                [
                    f"{overlap.start:.3f}",
                    f"{overlap.end:.3f}",
                    f"{overlap.duration:.3f}",
                ]
            )
