import shutil
import struct
import wave
from array import array as pyarray

import numpy as np
import pytest

from podcast_prep.audio import (
    _apply_edge_fade,
    _block_dest_end_frame,
    _deesser_filter,
    _find_wav_data_offset,
    _mix_samples,
    _parse_progress_value,
    convert_to_pcm,
    generate_peak_bins,
    normalize_loudnorm,
    render_edited_track,
    run_ffmpeg,
    should_skip_loudnorm,
    wave_info,
)
from podcast_prep.models import Block

requires_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg not installed"
)


def _write_wav(path, samples, sample_rate=48000, channels=1):
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(np.asarray(samples, dtype="<i2").tobytes())


def _read_wav_samples(path):
    with wave.open(str(path), "rb") as wf:
        frames = wf.getnframes()
        data = wf.readframes(frames)
    return np.frombuffer(data, dtype="<i2"), frames


# ── 旧ピュアPython実装（基準器） ──────────────────────────────


def _clamp_i16_ref(value):
    return max(-32768, min(32767, int(round(value))))


def _apply_edge_fade_ref(samples, chunk_start_in_segment, segment_frames, fade_frames):
    if fade_frames <= 0 or not samples:
        return list(samples)
    faded = []
    for idx, sample in enumerate(samples):
        absolute = chunk_start_in_segment + idx
        factor = 1.0
        if absolute < fade_frames:
            factor = min(factor, absolute / fade_frames)
        remaining = segment_frames - absolute - 1
        if remaining < fade_frames:
            factor = min(factor, max(0.0, remaining / fade_frames))
        faded.append(_clamp_i16_ref(sample * factor))
    return faded


def _mix_samples_ref(existing, incoming):
    current = pyarray("h")
    current.frombytes(existing)
    if len(current) < len(incoming):
        current.extend([0] * (len(incoming) - len(current)))
    mixed = pyarray("h")
    for old, new in zip(current, incoming):
        mixed.append(_clamp_i16_ref(int(old) + int(new)))  # 旧実装同様Python int加算
    return mixed.tobytes()


# ── _deesser_filter ──────────────────────────────────────────


def test_deesser_filter_boundary_mapping():
    assert _deesser_filter(0.0) == "deesser=i=0.300:m=0.500"
    assert _deesser_filter(0.5) == "deesser=i=0.550:m=0.300"
    assert _deesser_filter(1.0) == "deesser=i=0.800:m=0.100"


def test_deesser_filter_clamps_out_of_range():
    assert _deesser_filter(-0.5) == _deesser_filter(0.0)
    assert _deesser_filter(1.5) == _deesser_filter(1.0)


# ── _parse_progress_value ────────────────────────────────────


def test_parse_progress_out_time_ms_and_us_are_microseconds():
    assert _parse_progress_value("out_time_ms=1500000\n") == pytest.approx(1.5)
    assert _parse_progress_value("out_time_us=2500000") == pytest.approx(2.5)


def test_parse_progress_out_time_clock_format():
    assert _parse_progress_value("out_time=00:01:30.500000") == pytest.approx(90.5)
    assert _parse_progress_value("out_time=01:00:00.000000") == pytest.approx(3600.0)
    assert _parse_progress_value("out_time=-00:00:01.000000") == pytest.approx(-1.0)


def test_parse_progress_ignores_other_lines():
    assert _parse_progress_value("frame=123") is None
    assert _parse_progress_value("progress=end") is None
    assert _parse_progress_value("out_time_ms=N/A") is None
    assert _parse_progress_value("out_time=garbage") is None
    assert _parse_progress_value("no equals sign") is None
    assert _parse_progress_value("") is None


# ── generate_peak_bins ───────────────────────────────────────


def test_generate_peak_bins_header_bin_count_and_values(tmp_path):
    samples = np.zeros(600, dtype=np.int16)
    samples[10] = 16384
    samples[250] = 32767
    samples[500] = -32768
    path = tmp_path / "peaks.wav"
    _write_wav(path, samples)

    data = generate_peak_bins(path, bins_per_sec=200)

    assert data[:4] == b"PPK1"
    bins_per_sec, bin_count, reserved = struct.unpack("<III", data[4:16])
    assert bins_per_sec == 200
    assert bin_count == 3  # 240 + 240 + 120(端数バケット)
    assert reserved == 0
    assert data[16:] == bytes([128, 255, 255])


def test_generate_peak_bins_empty_wav(tmp_path):
    path = tmp_path / "empty.wav"
    _write_wav(path, np.zeros(0, dtype=np.int16))

    data = generate_peak_bins(path)

    assert data[:4] == b"PPK1"
    assert struct.unpack("<III", data[4:16]) == (200, 0, 0)
    assert len(data) == 16


def test_generate_peak_bins_uses_first_channel_only(tmp_path):
    frames = 240
    interleaved = np.zeros(frames * 2, dtype=np.int16)
    interleaved[0::2] = 100  # ch0 静か
    interleaved[1::2] = 32000  # ch1 大音量
    path = tmp_path / "stereo.wav"
    _write_wav(path, interleaved, channels=2)

    data = generate_peak_bins(path)

    assert struct.unpack("<III", data[4:16])[1] == 1
    assert data[16] == (100 * 255 + 16384) // 32768  # == 1


def test_generate_peak_bins_matches_naive_reference_across_read_boundary(tmp_path):
    rng = np.random.default_rng(20260801)
    samples = rng.integers(-32768, 32768, size=250_000, dtype=np.int16)
    path = tmp_path / "long.wav"
    _write_wav(path, samples)

    data = generate_peak_bins(path, bins_per_sec=200)

    expected = bytearray()
    magnitudes = np.abs(samples.astype(np.int32))
    for i in range(0, len(samples), 240):
        peak = int(magnitudes[i : i + 240].max())
        expected.append(min(255, (peak * 255 + 16384) // 32768))
    assert struct.unpack("<III", data[4:16])[1] == len(expected)
    assert data[16:] == bytes(expected)


def test_generate_peak_bins_rejects_invalid_bins_per_sec(tmp_path):
    path = tmp_path / "x.wav"
    _write_wav(path, np.zeros(10, dtype=np.int16))
    with pytest.raises(ValueError):
        generate_peak_bins(path, bins_per_sec=0)


# ── _apply_edge_fade（numpy版 vs 基準器） ────────────────────


def _assert_fade_matches(samples, chunk_start, segment_frames, fade_frames):
    result = _apply_edge_fade(
        np.asarray(samples, dtype=np.int16), chunk_start, segment_frames, fade_frames
    )
    assert list(result) == _apply_edge_fade_ref(
        list(samples), chunk_start, segment_frames, fade_frames
    )


def test_apply_edge_fade_single_chunk_matches_reference():
    rng = np.random.default_rng(1)
    samples = rng.integers(-32768, 32768, size=1000, dtype=np.int16)
    _assert_fade_matches(samples, 0, 1000, 480)


def test_apply_edge_fade_short_segment_overlapping_fades():
    rng = np.random.default_rng(2)
    samples = rng.integers(-32768, 32768, size=600, dtype=np.int16)
    _assert_fade_matches(samples, 0, 600, 480)  # 頭尾フェードが重なる縮退


def test_apply_edge_fade_multi_chunk_matches_reference():
    rng = np.random.default_rng(3)
    full = rng.integers(-32768, 32768, size=1000, dtype=np.int16)
    for chunk_start, size in ((0, 400), (400, 300), (700, 300)):
        _assert_fade_matches(full[chunk_start : chunk_start + size], chunk_start, 1000, 100)


def test_apply_edge_fade_middle_chunk_is_returned_untouched():
    samples = np.arange(300, dtype=np.int16)
    result = _apply_edge_fade(samples, 400, 1000, 100)
    assert result is samples  # フェード区間外は無走査・無コピー


def test_apply_edge_fade_zero_fade_and_empty_input():
    samples = np.array([5, -5], dtype=np.int16)
    assert _apply_edge_fade(samples, 0, 2, 0) is samples
    empty = np.zeros(0, dtype=np.int16)
    assert _apply_edge_fade(empty, 0, 0, 480) is empty


def test_apply_edge_fade_extreme_values():
    samples = np.array([-32768, 32767, -32768, 32767], dtype=np.int16)
    _assert_fade_matches(samples, 0, 4, 3)


# ── _mix_samples（numpy版 vs 基準器） ────────────────────────


def test_mix_samples_matches_reference_with_clipping():
    rng = np.random.default_rng(4)
    incoming = rng.integers(-32768, 32768, size=500, dtype=np.int16)
    existing = rng.integers(-32768, 32768, size=500, dtype=np.int16).tobytes()
    assert _mix_samples(existing, incoming) == _mix_samples_ref(
        existing, list(incoming)
    )


def test_mix_samples_pads_short_existing():
    incoming = np.array([100, 200, 300], dtype=np.int16)
    existing = np.array([10], dtype=np.int16).tobytes()
    assert _mix_samples(existing, incoming) == _mix_samples_ref(existing, [100, 200, 300])
    assert _mix_samples(b"", incoming) == _mix_samples_ref(b"", [100, 200, 300])


def test_mix_samples_truncates_to_incoming_length():
    incoming = np.array([1, 2], dtype=np.int16)
    existing = np.array([10, 20, 30, 40], dtype=np.int16).tobytes()
    result = _mix_samples(existing, incoming)
    assert result == _mix_samples_ref(existing, [1, 2])
    assert len(result) == 4  # incoming長に切り詰め


def test_mix_samples_saturates_at_int16_bounds():
    incoming = np.array([30000, -30000], dtype=np.int16)
    existing = np.array([30000, -30000], dtype=np.int16).tobytes()
    mixed = np.frombuffer(_mix_samples(existing, incoming), dtype="<i2")
    assert list(mixed) == [32767, -32768]


# ── render_edited_track（WAVレンダのフレーム境界） ───────────


def test_render_allocation_uses_write_side_rounding(tmp_path):
    # round ベースの書き込み終端が ceil(end*rate) を1フレーム超えるケース:
    # 旧実装は確保サイズを ceil で計算し data チャンク外へ書き込んでいた。
    rate = 48000
    source = tmp_path / "src.wav"
    _write_wav(source, np.full(48000, 1000, dtype=np.int16))
    block = Block(
        id="a1",
        speaker="A",
        source_start=100.4 / rate,  # round → 100（切り捨て側）
        source_end=200.6 / rate,  # round → 201（切り上げ側）→ 101フレーム
        start=999.6 / rate,  # round → 1000
    )
    assert _block_dest_end_frame(block, rate) == 1101
    assert 1101 > 1100  # ceil(end*rate) == 1100: 旧確保式だと1フレーム不足

    output = tmp_path / "out.wav"
    render_edited_track(source, [block], "A", output, crossfade_ms=0.0)

    samples, frames = _read_wav_samples(output)
    assert frames == 1101
    data_offset = _find_wav_data_offset(output)
    assert output.stat().st_size == data_offset + frames * 2  # チャンク外書き込みなし
    assert samples[999] == 0
    assert samples[1000] == 1000
    assert samples[1100] == 1000  # 最終フレームまで確保内に書けている


def test_render_edge_fade_and_progress_multi_chunk(tmp_path):
    rate = 48000
    source = tmp_path / "src.wav"
    _write_wav(source, np.full(48000, 1000, dtype=np.int16))
    block = Block(id="a1", speaker="A", source_start=0.0, source_end=1.0, start=0.0)
    output = tmp_path / "out.wav"
    seen = []

    render_edited_track(
        source, [block], "A", output, crossfade_ms=10.0, progress=seen.append
    )

    samples, frames = _read_wav_samples(output)
    assert frames == 48000  # セグメント48000は32768+15232の2チャンクに割れる
    assert samples[0] == 0  # フェードイン先頭
    assert samples[100] == round(1000 * 100 / 480)  # == 208
    assert samples[24000] == 1000  # 中間部は無加工
    assert samples[32768] == 1000  # チャンク境界直後も無加工
    assert samples[47900] == round(1000 * 99 / 480)  # フェードアウト中 == 206
    assert samples[47999] == 0  # 最終フレーム factor 0
    assert seen == [1.0]  # ブロックindex/総数ベース


def test_render_progress_reports_one_for_empty_blocks(tmp_path):
    source = tmp_path / "src.wav"
    _write_wav(source, np.zeros(10, dtype=np.int16))
    seen = []
    render_edited_track(
        source, [], "A", tmp_path / "out.wav", minimum_duration=0.001, progress=seen.append
    )
    assert seen == [1.0]


# ── run_ffmpeg / normalize_loudnorm（ffmpeg必須） ────────────


@requires_ffmpeg
def test_run_ffmpeg_reports_progress_from_stdout(tmp_path):
    output = tmp_path / "sine.wav"
    seen = []
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-nostats",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-ar",
            "48000",
            "-ac",
            "1",
            "-sample_fmt",
            "s16",
            str(output),
        ],
        progress_callback=seen.append,
        total_duration=2.0,
    )
    assert output.exists()
    assert seen, "progress lines should be parsed from stdout"
    assert all(0.0 <= value <= 1.0 for value in seen)
    assert max(seen) >= 0.9


@requires_ffmpeg
def test_run_ffmpeg_timeout_raises_timeout_error():
    with pytest.raises(TimeoutError):
        run_ffmpeg(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-nostats",
                "-re",
                "-f",
                "lavfi",
                "-i",
                "sine=duration=5",
                "-f",
                "null",
                "-",
            ],
            timeout=0.8,
        )


# ── encode_mp3（Issue #32: ビットレート引数化） ──────────────


def _capture_encode_args(monkeypatch):
    from podcast_prep import audio as audio_mod

    captured: list[list[str]] = []
    monkeypatch.setattr(
        audio_mod, "run_ffmpeg", lambda args, **_kwargs: captured.append(list(args))
    )
    return audio_mod, captured


def test_encode_mp3_default_matches_legacy_320k(tmp_path, monkeypatch):
    """既定（引数省略）は従来 encode_mp3_320 と同一の ffmpeg 引数 = 320k CBR。"""
    audio_mod, captured = _capture_encode_args(monkeypatch)
    audio_mod.encode_mp3(tmp_path / "in.wav", tmp_path / "out.mp3")
    (args,) = captured
    assert args[args.index("-b:a") + 1] == "320k"
    assert args[args.index("-codec:a") + 1] == "libmp3lame"
    assert args[-1] == str(tmp_path / "out.mp3")


def test_encode_mp3_bitrate_argument_builds_192k(tmp_path, monkeypatch):
    audio_mod, captured = _capture_encode_args(monkeypatch)
    audio_mod.encode_mp3(tmp_path / "in.wav", tmp_path / "out.mp3", bitrate_kbps=192)
    (args,) = captured
    assert args[args.index("-b:a") + 1] == "192k"


# ── convert_to_pcm（ラウドネス正規化なしの形式変換） ─────────


def _quiet_sine(seconds=2.0, rate=48000, amplitude=2000, freq=440.0):
    t = np.arange(int(rate * seconds))
    return (amplitude * np.sin(2 * np.pi * freq * t / rate)).astype(np.int16)


@requires_ffmpeg
def test_convert_to_pcm_outputs_48k_mono_s16(tmp_path):
    # 入力はわざと 44.1kHz ステレオ: 変換で 48k/mono/s16 に揃うことを ffprobe 相当
    # （wave_info）で検証する。
    rate = 44100
    mono = _quiet_sine(seconds=1.0, rate=rate)
    interleaved = np.repeat(mono, 2)  # L=R のステレオ
    source = tmp_path / "in.wav"
    _write_wav(source, interleaved, sample_rate=rate, channels=2)
    output = tmp_path / "out.wav"

    result = convert_to_pcm(source, output)

    info = wave_info(output)
    assert info["sample_rate"] == 48000
    assert info["channels"] == 1
    assert info["sample_width"] == 2
    # normalize_loudnorm と同じキー構成（呼び出し側の分岐を減らすための契約）
    assert set(result) >= {"target_i", "input", "normalized", "loudness_normalized"}
    assert result["normalized"] is None
    assert result["input"] is None
    assert result["loudness_normalized"] is False


@requires_ffmpeg
def test_convert_to_pcm_preserves_loudness_unlike_loudnorm(tmp_path):
    """L の肝: 正規化スキップ経路は音量を動かさない（loudnorm は動かす）。"""
    samples = _quiet_sine(seconds=2.0, amplitude=2000)  # -16 LUFS より十分小さい
    source = tmp_path / "quiet.wav"
    _write_wav(source, samples)

    converted = tmp_path / "converted.wav"
    convert_to_pcm(source, converted)
    normalized = tmp_path / "normalized.wav"
    normalize_loudnorm(source, normalized)

    src_peak = int(np.abs(samples.astype(np.int32)).max())
    conv_peak = int(np.abs(_read_wav_samples(converted)[0].astype(np.int32)).max())
    norm_peak = int(np.abs(_read_wav_samples(normalized)[0].astype(np.int32)).max())
    # 変換のみ: ピークはほぼそのまま（リサンプル無しなので誤差は僅少）
    assert conv_peak == pytest.approx(src_peak, rel=0.02)
    # loudnorm: 静かな素材を -16 LUFS へ持ち上げるので明確に増幅される
    assert norm_peak > src_peak * 2


@requires_ffmpeg
def test_convert_to_pcm_reports_progress(tmp_path):
    source = tmp_path / "in.wav"
    _write_wav(source, _quiet_sine(seconds=2.0))
    seen = []

    convert_to_pcm(source, tmp_path / "out.wav", progress=seen.append)

    assert seen and seen[-1] == 1.0
    assert all(0.0 <= value <= 1.0 for value in seen)
    assert all(b >= a - 1e-9 for a, b in zip(seen, seen[1:]))  # 単調非減少


@requires_ffmpeg
def test_convert_to_pcm_creates_parent_directory(tmp_path):
    source = tmp_path / "in.wav"
    _write_wav(source, _quiet_sine(seconds=0.5))
    output = tmp_path / "nested" / "deep" / "out.wav"
    convert_to_pcm(source, output)
    assert output.is_file()


@requires_ffmpeg
def test_normalize_loudnorm_marks_result_as_normalized(tmp_path):
    source = tmp_path / "in.wav"
    _write_wav(source, _quiet_sine(seconds=1.0, amplitude=8000))
    result = normalize_loudnorm(source, tmp_path / "out.wav")
    assert result["loudness_normalized"] is True


@requires_ffmpeg
def test_normalize_loudnorm_progress_weighting_and_result(tmp_path):
    rate = 48000
    t = np.arange(rate * 2)
    sine = (8000 * np.sin(2 * np.pi * 440 * t / rate)).astype(np.int16)
    source = tmp_path / "in.wav"
    _write_wav(source, sine)
    output = tmp_path / "norm.wav"
    seen = []

    result = normalize_loudnorm(source, output, progress=seen.append)

    assert output.exists()
    assert result["target_i"] == -16.0
    assert "input" in result and "normalized" in result
    assert result.get("normalization_fallback") in (None, True)
    assert seen and seen[-1] == 1.0
    assert all(0.0 <= value <= 1.0 for value in seen)
    assert all(b >= a - 1e-9 for a, b in zip(seen, seen[1:]))  # 3パス重みで単調


# ── should_skip_loudnorm / tolerance スキップ（Issue #37） ────


@pytest.mark.parametrize(
    ("measured_i", "target_i", "tolerance", "expected"),
    [
        (-16.3, -16.0, 0.5, True),   # 目標±許容量以内 → スキップ
        (-17.1, -16.0, 0.5, False),  # 許容量超過 → 正規化する
        (-16.5, -16.0, 0.5, True),   # 境界値ちょうどはスキップ側
        (-16.0, -16.0, 0.0, False),  # 許容量 0 = 常に正規化（現行挙動）
        (-16.0, -16.0, -1.0, False), # 負値も「常に正規化」に倒す（防御）
        (-15.4, -16.0, 0.5, False),  # 上振れ側も対称に判定
        (-15.6, -16.0, 0.5, True),
    ],
)
def test_should_skip_loudnorm_decision(measured_i, target_i, tolerance, expected):
    assert should_skip_loudnorm(measured_i, target_i, tolerance) is expected


def test_should_skip_loudnorm_handles_silence_measurement():
    # 無音素材の loudnorm 計測は input_i が -inf になり得る → 差が inf なので必ず正規化側
    assert should_skip_loudnorm(float("-inf"), -16.0, 0.5) is False


def test_normalize_loudnorm_skip_path_uses_convert_and_maps_progress(tmp_path, monkeypatch):
    """許容量以内: 適用・検証パスを走らせず convert_to_pcm を再利用し、記録を残す。

    ffmpeg 不要（計測・変換をスタブ）。進捗は 計測0.35 / 変換0.65 の読み替えで
    0..1 の単調を保つこと。
    """
    from podcast_prep import audio as audio_mod

    def fake_measure(
        input_path,
        target_i=-16.0,
        true_peak=-1.5,
        lra=11.0,
        progress_callback=None,
        total_duration=None,
    ):
        if progress_callback:
            progress_callback(1.0)
        # loudnorm の print_format=json は数値を文字列で返す（実仕様に合わせる）
        return {
            "input_i": "-16.30",
            "input_tp": "-3.00",
            "input_lra": "4.00",
            "input_thresh": "-27.00",
            "target_offset": "0.00",
        }

    converted = []

    def fake_convert(input_path, output_path, sample_rate=48000, progress=None):
        converted.append(output_path)
        output_path.write_bytes(b"converted-wav")
        if progress:
            for fraction in (0.0, 0.5, 1.0):
                progress(fraction)
        return {
            "target_i": None,
            "input": None,
            "normalized": None,
            "loudness_normalized": False,
        }

    def no_ffmpeg(*args, **kwargs):
        raise AssertionError("スキップ経路で run_ffmpeg を直接呼んではいけない")

    monkeypatch.setattr(audio_mod, "loudnorm_measure", fake_measure)
    monkeypatch.setattr(audio_mod, "convert_to_pcm", fake_convert)
    monkeypatch.setattr(audio_mod, "ffprobe_duration", lambda path: 60.0)
    monkeypatch.setattr(audio_mod, "run_ffmpeg", no_ffmpeg)

    seen = []
    output = tmp_path / "out.wav"
    result = audio_mod.normalize_loudnorm(
        tmp_path / "in.wav", output, tolerance=0.5, progress=seen.append
    )

    assert converted == [output]
    assert output.read_bytes() == b"converted-wav"
    # 記録: normalization_fallback と同じ流儀で結果 dict に載る（track.loudness へ永続化される）
    assert result["normalization_skipped"] is True
    assert result["loudness_normalized"] is True
    assert result["input"]["input_i"] == "-16.30"
    assert result["normalized"] is None  # 適用・検証パスなし
    assert result["target_i"] == -16.0
    # 進捗: 計測完了 0.35 → 変換 0.35..1.0 の線形マップ（fraction 0.5 → 0.675）
    assert seen[-1] == 1.0
    assert any(value == pytest.approx(0.675) for value in seen)
    assert all(0.0 <= value <= 1.0 for value in seen)
    assert all(b >= a - 1e-9 for a, b in zip(seen, seen[1:]))


@requires_ffmpeg
def test_normalize_loudnorm_tolerance_skip_end_to_end(tmp_path):
    """スキップ時も正規化WAV（48k/mono/s16）が生成され、音量は動かないこと。"""
    samples = _quiet_sine(seconds=1.0, amplitude=2000)
    source = tmp_path / "in.wav"
    _write_wav(source, samples)
    output = tmp_path / "out.wav"
    seen = []

    # 許容量を極端に大きくして必ずスキップさせる（素材の実測 LUFS に依存しない）
    result = normalize_loudnorm(source, output, tolerance=100.0, progress=seen.append)

    info = wave_info(output)
    assert info["sample_rate"] == 48000
    assert info["channels"] == 1
    assert info["sample_width"] == 2
    assert result["normalization_skipped"] is True
    assert result["loudness_normalized"] is True
    assert "input_i" in result["input"]  # 計測値ごと記録される
    # フィルタなし変換なのでピークは維持される（loudnorm なら大幅増幅されるレベルの素材）
    src_peak = int(np.abs(samples.astype(np.int32)).max())
    out_peak = int(np.abs(_read_wav_samples(output)[0].astype(np.int32)).max())
    assert out_peak == pytest.approx(src_peak, rel=0.02)
    assert seen and seen[-1] == 1.0
    assert all(b >= a - 1e-9 for a, b in zip(seen, seen[1:]))


@requires_ffmpeg
def test_normalize_loudnorm_tolerance_zero_still_normalizes(tmp_path):
    """許容量 0 は現行挙動（常に正規化）。静かな素材は明確に増幅される。"""
    samples = _quiet_sine(seconds=1.0, amplitude=2000)
    source = tmp_path / "in.wav"
    _write_wav(source, samples)
    output = tmp_path / "out.wav"

    result = normalize_loudnorm(source, output, tolerance=0.0)

    assert result.get("normalization_skipped") is None
    assert result["loudness_normalized"] is True
    src_peak = int(np.abs(samples.astype(np.int32)).max())
    out_peak = int(np.abs(_read_wav_samples(output)[0].astype(np.int32)).max())
    assert out_peak > src_peak * 2
