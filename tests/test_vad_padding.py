"""VAD 区間パディング（Issue #26「VADが語尾を削る」）のテスト。

- 末尾が pad_end_s 分伸びる / 先頭は 0 でクランプ / 末尾は音声実尺でクランプ
- パディングで隣接区間が橋渡しされても重なりゼロ・ソート済み（マージが吸収）
- pad ゼロ指定は従来挙動と一致（後方互換）
- 取込経路: settings 値が detect_speech_intervals の kwargs に届く
- POST /api/projects のバリデーション境界（aggressiveness 0〜3 / pad 0〜1.0）

検出はエネルギーフォールバック経路に固定する（_load_webrtcvad を None に差し替え）
— webrtcvad の判定はビルド差があり得るため、決定的な RMS 閾値で回す。
パディングの後処理は webrtcvad 経路と同一コード（detect_speech_intervals 末尾）を通る。
"""

from __future__ import annotations

import struct
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_prep import server, storage, vad
from podcast_prep.models import ProjectState, default_settings


@pytest.fixture(autouse=True)
def _energy_fallback(monkeypatch):
    monkeypatch.setattr(vad, "_load_webrtcvad", lambda aggressiveness: None)


def _write_speech_wav(path: Path, segments, total_s: float, rate: int = 8000):
    """segments = [(start_s, end_s), ...] の区間だけ交番信号、他は無音の WAV を書く。"""
    frames = int(total_s * rate)
    samples = [0] * frames
    for start_s, end_s in segments:
        for i in range(int(start_s * rate), min(frames, int(end_s * rate))):
            samples[i] = 8000 if i % 2 == 0 else -8000
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(struct.pack(f"<{frames}h", *samples))


def _assert_sorted_non_overlapping(intervals):
    for (s1, e1), (s2, e2) in zip(intervals, intervals[1:]):
        assert e1 <= s2, intervals
    for s, e in intervals:
        assert s < e, intervals


# ---------------------------------------------------------------- vad 単体


def test_pad_end_extends_tail(tmp_path):
    wav = tmp_path / "tail.wav"
    _write_speech_wav(wav, [(0.5, 1.5)], total_s=3.0)
    base = vad.detect_speech_intervals(wav, pad_start_s=0.0, pad_end_s=0.0)
    padded = vad.detect_speech_intervals(wav, pad_start_s=0.0, pad_end_s=0.2)
    assert len(base) == len(padded) == 1
    assert padded[0][0] == base[0][0]  # 頭は不変（pad_start=0）
    assert padded[0][1] == pytest.approx(base[0][1] + 0.2, abs=1e-3)


def test_pad_start_clamped_to_zero(tmp_path):
    wav = tmp_path / "head.wav"
    _write_speech_wav(wav, [(0.0, 1.0)], total_s=2.0)
    padded = vad.detect_speech_intervals(wav, pad_start_s=0.5, pad_end_s=0.0)
    assert padded[0][0] == 0.0


def test_pad_end_clamped_to_duration(tmp_path):
    wav = tmp_path / "clamp.wav"
    _write_speech_wav(wav, [(1.0, 2.9)], total_s=3.0)
    padded = vad.detect_speech_intervals(wav, pad_start_s=0.0, pad_end_s=5.0)
    assert padded[-1][1] == pytest.approx(3.0, abs=1e-3)


def test_padding_bridges_without_overlap(tmp_path):
    """0.5s ギャップ（merge_gap_s=0.25 では別区間）がパディングで橋渡しされても、
    出力は重なりゼロ・ソート済み（merge_intervals が吸収して1区間になる）。"""
    wav = tmp_path / "bridge.wav"
    _write_speech_wav(wav, [(0.5, 1.0), (1.5, 2.0)], total_s=3.0)
    base = vad.detect_speech_intervals(wav, pad_start_s=0.0, pad_end_s=0.0)
    assert len(base) == 2  # 前提: パディング無しでは2区間
    padded = vad.detect_speech_intervals(wav, pad_start_s=0.05, pad_end_s=0.3)
    assert len(padded) == 1  # ギャップ 0.5 - 0.3 - 0.05 = 0.15 < merge_gap 0.25 → 併合
    _assert_sorted_non_overlapping(padded)


def test_pad_zero_matches_legacy_behavior(tmp_path):
    """pad ゼロ指定は従来実装（パディング導入前）と同一の出力（後方互換）。"""
    wav = tmp_path / "legacy.wav"
    _write_speech_wav(wav, [(0.3, 0.9), (1.8, 2.4)], total_s=3.0)
    zero = vad.detect_speech_intervals(wav, pad_start_s=0.0, pad_end_s=0.0)
    # 従来実装の等価再現: 生区間をそのまま merge へ
    assert zero == vad.detect_speech_intervals(wav, pad_start_s=-1.0, pad_end_s=-1.0)
    _assert_sorted_non_overlapping(zero)


def test_default_padding_applied(tmp_path):
    """既定値（0.05 / 0.2）が引数省略で効く。"""
    wav = tmp_path / "default.wav"
    _write_speech_wav(wav, [(0.5, 1.5)], total_s=3.0)
    zero = vad.detect_speech_intervals(wav, pad_start_s=0.0, pad_end_s=0.0)
    default = vad.detect_speech_intervals(wav)
    assert default[0][0] == pytest.approx(zero[0][0] - 0.05, abs=1e-3)
    assert default[0][1] == pytest.approx(zero[0][1] + 0.2, abs=1e-3)


# ---------------------------------------------------------------- 取込経路の配線


def test_run_import_passes_vad_settings(tmp_path, monkeypatch):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    project = ProjectState.new("vad-wire", "vad wiring")
    project.settings["vad_aggressiveness"] = 3
    project.settings["vad_pad_start_s"] = 0.1
    project.settings["vad_pad_end_s"] = 0.4
    pdir = storage.project_dir(project.id, create=True)
    for sp in ("A", "B"):
        (pdir / f"{sp.lower()}.wav").write_bytes(b"fake")
        project.tracks[sp].original_file = f"{sp.lower()}.wav"
    storage.save_project(project)
    job = server._new_job("import", project.id)

    captured = []

    def fake_prepare(project, speaker, job_id, **kwargs):
        path = storage.project_dir(project.id) / f"speaker{speaker}_normalized.wav"
        path.write_bytes(b"fake-wav")
        project.tracks[speaker].normalized_wav = path.name
        return path

    monkeypatch.setattr(server, "_prepare_track_audio", fake_prepare)
    monkeypatch.setattr(server, "_write_peaks_sidecar", lambda *a, **k: None)
    monkeypatch.setattr(
        server,
        "detect_speech_intervals",
        lambda path, **kwargs: captured.append(kwargs) or [(0.0, 1.0)],
    )
    server._run_import(project.id, job["id"])
    assert server._jobs[job["id"]]["status"] == "complete", server._jobs[job["id"]]["error"]
    assert len(captured) == 2
    for kwargs in captured:
        assert kwargs["aggressiveness"] == 3
        assert kwargs["pad_start_s"] == pytest.approx(0.1)
        assert kwargs["pad_end_s"] == pytest.approx(0.4)


def test_default_settings_contain_vad_keys():
    settings = default_settings()
    assert settings["vad_aggressiveness"] == 2
    assert settings["vad_pad_start_s"] == 0.05
    assert settings["vad_pad_end_s"] == 0.2


# ---------------------------------------------------------------- バリデーション


@pytest.fixture
def client():
    return TestClient(server.app)


def _import_form(**overrides):
    files = {
        "speaker_a": ("a.wav", b"RIFFxxxx", "audio/wav"),
        "speaker_b": ("b.wav", b"RIFFxxxx", "audio/wav"),
    }
    data = {"name": "vad validation"}
    data.update({k: str(v) for k, v in overrides.items()})
    return {"files": files, "data": data}


@pytest.mark.parametrize(
    "field,value",
    [
        ("vad_aggressiveness", 4),
        ("vad_aggressiveness", -1),
        ("vad_pad_start_s", -0.1),
        ("vad_pad_start_s", 1.5),
        ("vad_pad_end_s", -0.01),
        ("vad_pad_end_s", 1.01),
        ("vad_pad_end_s", "nan"),
    ],
)
def test_create_project_rejects_invalid_vad_options(tmp_path, monkeypatch, client, field, value):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    kwargs = _import_form(**{field: value})
    res = client.post("/api/projects", **kwargs)
    assert res.status_code == 400, res.text
    assert field.split("_pad")[0] in res.json()["detail"] or field in res.json()["detail"]


def test_create_project_accepts_boundary_vad_options(tmp_path, monkeypatch, client):
    """境界値（0 / 3 / 0.0 / 1.0）は 400 にならず取込が開始される。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(server, "_run_import", lambda *a, **k: None)  # ffmpeg を起こさない
    kwargs = _import_form(
        vad_aggressiveness=3, vad_pad_start_s=0.0, vad_pad_end_s=1.0
    )
    res = client.post("/api/projects", **kwargs)
    assert res.status_code == 200, res.text
    pid = res.json()["project"]["id"]
    saved = storage.load_project(pid)
    assert saved.settings["vad_aggressiveness"] == 3
    assert saved.settings["vad_pad_start_s"] == 0.0
    assert saved.settings["vad_pad_end_s"] == 1.0
