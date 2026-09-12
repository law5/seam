from __future__ import annotations

import array
import math
import sys
import wave
from pathlib import Path

from .audio import SAMPLE_RATE, SAMPLE_WIDTH


def _samples_from_bytes(data: bytes) -> array.array:
    samples = array.array("h")
    samples.frombytes(data)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def _rms(samples: array.array) -> float:
    if not samples:
        return 0.0
    total = sum(sample * sample for sample in samples)
    return math.sqrt(total / len(samples)) / 32768.0


def _frame_is_speech_energy(frame: bytes, threshold: float = 0.012) -> bool:
    return _rms(_samples_from_bytes(frame)) >= threshold


def _load_webrtcvad(aggressiveness: int):
    try:
        import webrtcvad  # type: ignore
    except ImportError:
        return None
    return webrtcvad.Vad(max(0, min(3, int(aggressiveness))))


def merge_intervals(
    intervals: list[tuple[float, float]],
    merge_gap_s: float = 0.25,
    min_speech_s: float = 0.2,
) -> list[tuple[float, float]]:
    if not intervals:
        return []
    intervals = sorted(intervals)
    merged: list[list[float]] = [[intervals[0][0], intervals[0][1]]]
    for start, end in intervals[1:]:
        current = merged[-1]
        if start - current[1] <= merge_gap_s:
            current[1] = max(current[1], end)
        else:
            merged.append([start, end])
    return [
        (round(start, 3), round(end, 3))
        for start, end in merged
        if end - start >= min_speech_s
    ]


def detect_speech_intervals(
    wav_path: Path,
    aggressiveness: int = 2,
    frame_ms: int = 30,
    min_speech_s: float = 0.2,
    merge_gap_s: float = 0.25,
    hangover_s: float = 0.18,
) -> list[tuple[float, float]]:
    vad = _load_webrtcvad(aggressiveness)
    intervals: list[tuple[float, float]] = []
    with wave.open(str(wav_path), "rb") as wf:
        if wf.getnchannels() != 1 or wf.getsampwidth() != SAMPLE_WIDTH:
            raise ValueError("VAD expects 16-bit mono WAV")
        sample_rate = wf.getframerate()
        if sample_rate not in (8000, 16000, 32000, 48000):
            raise ValueError("VAD expects 8/16/32/48 kHz WAV")
        frame_frames = int(sample_rate * frame_ms / 1000)
        frame_bytes = frame_frames * SAMPLE_WIDTH
        active_start: float | None = None
        last_speech_end = 0.0
        cursor = 0
        while True:
            frame = wf.readframes(frame_frames)
            if len(frame) < frame_bytes:
                break
            timestamp = cursor / sample_rate
            if vad is not None:
                speech = bool(vad.is_speech(frame, sample_rate))
            else:
                speech = _frame_is_speech_energy(frame)
            if speech:
                if active_start is None:
                    active_start = timestamp
                last_speech_end = timestamp + frame_ms / 1000
            elif active_start is not None and timestamp - last_speech_end >= hangover_s:
                intervals.append((active_start, last_speech_end))
                active_start = None
            cursor += frame_frames
        if active_start is not None:
            intervals.append((active_start, last_speech_end))
    return merge_intervals(intervals, merge_gap_s=merge_gap_s, min_speech_s=min_speech_s)
