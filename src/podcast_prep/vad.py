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


def energy_threshold_from_db(energy_floor_db: float) -> float:
    """dBFS → 線形 RMS 閾値（0..1 フルスケール正規化。_rms と同じ座標系）。

    既存フォールバック閾値 0.012 ≒ -38.4dBFS と整合する（10^(-38.4/20) ≈ 0.01202）。
    """
    return 10.0 ** (float(energy_floor_db) / 20.0)


def frame_is_speech(
    frame: bytes, vad, sample_rate: int, energy_threshold: float | None
) -> bool:
    """1フレームの発話判定（Issue #32 のハイブリッド判定）。

    webrtcvad の aggressiveness は音量のつまみではなく「声らしいスペクトルか」の
    統計判定の厳しさで、小声・囁きは音量以前に「声らしくない」と落とされる。
    energy_threshold（vad_energy_floor_db 由来の線形 RMS 値）が指定されたら
    **webrtcvad OR（RMS ≥ 閾値）** で拾う。

    - webrtcvad あり + 閾値なし: 従来どおり webrtcvad のみ（完全後方互換）
    - webrtcvad あり + 閾値あり: OR 判定
    - webrtcvad なし（フォールバック）+ 閾値あり: 既定閾値 0.012 の**代わり**に指定値
    - webrtcvad なし + 閾値なし: 従来の既定閾値 0.012
    """
    if vad is not None:
        if bool(vad.is_speech(frame, sample_rate)):
            return True
        if energy_threshold is None:
            return False
        return _rms(_samples_from_bytes(frame)) >= energy_threshold
    if energy_threshold is not None:
        return _rms(_samples_from_bytes(frame)) >= energy_threshold
    return _frame_is_speech_energy(frame)


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
    pad_start_s: float = 0.05,
    pad_end_s: float = 0.2,
    energy_floor_db: float | None = None,
) -> list[tuple[float, float]]:
    """発話区間の検出。

    pad_start_s / pad_end_s（Issue #26）: 検出区間の頭・末尾に足す余白。
    webrtcvad の終端は「最後に声と判定したフレーム」ぴったりで、息漏れ気味の
    語尾（日本語で顕著）が aggressiveness=2 でも無音扱いされて削られる。
    ブロック外はエクスポートで無音化されるため、余白ゼロは納品物から語尾が
    消える実害になる。パディングは merge_intervals の**前**に適用する —
    パディングで生じた重なり・橋渡しはマージが吸収し、同一トラック内で
    区間が重ならない不変条件を保つ。start は 0、end は音声実尺でクランプする。
    webrtcvad 経路とエネルギーフォールバック経路は同じ後処理を通る。

    energy_floor_db（Issue #32）: 無音とみなす音量の下限（dBFS）。None（既定）は
    従来どおり webrtcvad のみ = 完全後方互換。指定時はフレーム判定が
    webrtcvad OR（RMS ≥ 10^(db/20)）のハイブリッドになる（frame_is_speech 参照）。
    """
    vad = _load_webrtcvad(aggressiveness)
    energy_threshold = (
        None if energy_floor_db is None else energy_threshold_from_db(energy_floor_db)
    )
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
            speech = frame_is_speech(frame, vad, sample_rate, energy_threshold)
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
        # 音声の実尺（クランプ上限）。読み取りヘッダの総フレーム数から得る
        total_s = wf.getnframes() / sample_rate
    # 順序が重要（QA指摘）: min_speech_s の棄却は**パディング前**の実発話長で行う。
    # 先にパッドすると、従来 min_speech_s=0.2 で棄却されていた 30ms 級の孤立ノイズ
    # （クリック・息）が既定パッド計 0.25s で嵩上げされて生き残り、ブロック化して
    # エクスポートに残ってしまう。
    #   1. 従来どおり merge_intervals（merge_gap 併合 + min_speech 棄却）
    #   2. 生き残った区間だけをパッド（クランプ付き）
    #   3. もう一度 merge_intervals へ — ただし min_speech_s=0.0。ここは
    #      パッドで生じた重なり・橋渡しの吸収専用で、嵩上げ後の長さで
    #      落とす/残すの再判定はしない
    intervals = merge_intervals(intervals, merge_gap_s=merge_gap_s, min_speech_s=min_speech_s)
    pad_start_s = max(0.0, float(pad_start_s))
    pad_end_s = max(0.0, float(pad_end_s))
    if pad_start_s > 0.0 or pad_end_s > 0.0:
        padded = [
            (max(0.0, start - pad_start_s), min(total_s, end + pad_end_s))
            for start, end in intervals
        ]
        intervals = merge_intervals(padded, merge_gap_s=merge_gap_s, min_speech_s=0.0)
    return intervals
