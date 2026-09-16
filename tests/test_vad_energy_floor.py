"""無音判定の音量しきい値（Issue #32「小声・囁きが切られる」）のテスト。

- energy_threshold_from_db の dB→線形変換（既存フォールバック 0.012 ≒ -38.4dBFS と整合）
- frame_is_speech のハイブリッド判定の真理値表（webrtcvad はモック = 実挙動非依存）
- エネルギーフォールバック経路の決定的テスト:
  -45dBFS トーンが既定（None → 閾値 0.012 ≒ -38.4dB）では落ち、floor=-50 で拾われる
- None は従来挙動と完全一致（後方互換）
- POST /api/projects のバリデーション境界（-80〜0）と settings 配線キャプチャ
- settings の None 永続化（coerce_settings / from_dict ラウンドトリップ）
"""

from __future__ import annotations

import json
import math
import struct
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_prep import server, storage, vad
from podcast_prep.models import ProjectState, coerce_settings, default_settings


# ---------------------------------------------------------------- 変換


def test_energy_threshold_from_db_conversion():
    assert vad.energy_threshold_from_db(0.0) == 1.0
    assert vad.energy_threshold_from_db(-20.0) == pytest.approx(0.1)
    # 既存フォールバック閾値 0.012 との辻褄: -38.4dBFS ≈ 0.01202
    assert vad.energy_threshold_from_db(-38.4) == pytest.approx(0.012, rel=0.01)
    assert 20 * math.log10(0.012) == pytest.approx(-38.4, abs=0.1)


# ---------------------------------------------------------------- 真理値表（webrtcvad モック）


class _FakeVad:
    def __init__(self, result):
        self.result = result

    def is_speech(self, frame, sample_rate):
        return self.result


def _frame(amplitude: int, n: int = 240) -> bytes:
    # 交番信号: RMS = amplitude/32768
    return struct.pack(f"<{n}h", *([amplitude, -amplitude] * (n // 2)))


LOUD = _frame(8000)    # RMS ≈ 0.244
QUIET = _frame(100)    # RMS ≈ 0.003 （-50dB ≈ 0.00316 をわずかに下回る）
MID = _frame(200)      # RMS ≈ 0.0061（-50dB は超え、既定 0.012 は下回る）


@pytest.mark.parametrize(
    "vad_obj,threshold,frame,expected",
    [
        (_FakeVad(True), None, QUIET, True),     # webrtcvad が拾えばそれで確定
        (_FakeVad(False), None, LOUD, False),    # 閾値なし: webrtcvad のみ（後方互換）
        (_FakeVad(False), 0.00316, MID, True),   # OR 判定: エネルギーで救済
        (_FakeVad(False), 0.00316, QUIET, False),  # 閾値未満は救済しない
        (None, 0.00316, MID, True),              # フォールバック: 指定値が既定の代わり
        (None, None, MID, False),                # フォールバック既定 0.012 では落ちる
        (None, None, LOUD, True),                # フォールバック既定でも大音量は拾う
    ],
)
def test_frame_is_speech_truth_table(vad_obj, threshold, frame, expected):
    assert vad.frame_is_speech(frame, vad_obj, 8000, threshold) is expected


# ---------------------------------------------------------------- フォールバック経路（決定的）


def _write_tone(path: Path, amplitude: int, start_s=0.5, end_s=1.5, total_s=3.0, rate=8000):
    frames = int(total_s * rate)
    samples = [0] * frames
    for i in range(int(start_s * rate), int(end_s * rate)):
        samples[i] = amplitude if i % 2 == 0 else -amplitude
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(struct.pack(f"<{frames}h", *samples))


@pytest.fixture(autouse=True)
def _energy_fallback(monkeypatch):
    monkeypatch.setattr(vad, "_load_webrtcvad", lambda aggressiveness: None)


def test_quiet_tone_rescued_by_floor(tmp_path):
    """-45dBFS のトーン（RMS ≈ 0.0056）は既定（0.012 ≒ -38.4dB）で落ち、
    floor=-50（0.00316）で拾われる。"""
    wav = tmp_path / "whisper.wav"
    amplitude = int(32768 * 10 ** (-45 / 20))  # ≈ 184
    _write_tone(wav, amplitude)
    assert vad.detect_speech_intervals(wav) == []  # None = 従来挙動で棄却
    rescued = vad.detect_speech_intervals(wav, energy_floor_db=-50.0)
    assert len(rescued) == 1
    assert rescued[0][0] == pytest.approx(0.45, abs=0.05)  # 0.5 - pad_start 0.05


def test_none_matches_legacy_behavior(tmp_path):
    """energy_floor_db=None は引数導入前と完全一致（後方互換）。"""
    wav = tmp_path / "loud.wav"
    _write_tone(wav, 8000)
    assert vad.detect_speech_intervals(wav) == vad.detect_speech_intervals(
        wav, energy_floor_db=None
    )
    assert len(vad.detect_speech_intervals(wav)) == 1


# ---------------------------------------------------------------- サーバ配線・バリデーション


@pytest.fixture
def client():
    return TestClient(server.app)


def _import_form(**overrides):
    files = {
        "speaker_a": ("a.wav", b"RIFFxxxx", "audio/wav"),
        "speaker_b": ("b.wav", b"RIFFxxxx", "audio/wav"),
    }
    data = {"name": "energy floor"}
    data.update({k: str(v) for k, v in overrides.items()})
    return {"files": files, "data": data}


@pytest.mark.parametrize("value", [-80.1, 0.1, 5, "nan", "inf"])
def test_create_project_rejects_out_of_range_floor(tmp_path, monkeypatch, client, value):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    res = client.post("/api/projects", **_import_form(vad_energy_floor_db=value))
    assert res.status_code == 400, res.text
    assert "vad_energy_floor_db" in res.json()["detail"]


def test_create_project_accepts_boundary_and_persists(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(server, "_run_import", lambda *a, **k: None)
    res = client.post("/api/projects", **_import_form(vad_energy_floor_db=-80))
    assert res.status_code == 200, res.text
    saved = storage.load_project(res.json()["project"]["id"])
    assert saved.settings["vad_energy_floor_db"] == -80.0


def test_create_project_defaults_floor_to_none(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(server, "_run_import", lambda *a, **k: None)
    res = client.post("/api/projects", **_import_form())
    assert res.status_code == 200, res.text
    saved = storage.load_project(res.json()["project"]["id"])
    assert saved.settings["vad_energy_floor_db"] is None


@pytest.mark.parametrize("stored,expected", [(-50.0, -50.0), (None, None)])
def test_run_import_passes_floor_setting(tmp_path, monkeypatch, stored, expected):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    project = ProjectState.new("floor-wire", "floor wiring")
    project.settings["vad_energy_floor_db"] = stored
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
    assert [k["energy_floor_db"] for k in captured] == [expected, expected]


# ---------------------------------------------------------------- None の永続化


def test_settings_none_roundtrip():
    assert default_settings()["vad_energy_floor_db"] is None
    # coerce_settings: None は素通し・数値文字列は float 化・非数値は ValueError
    assert coerce_settings({"vad_energy_floor_db": None})["vad_energy_floor_db"] is None
    assert coerce_settings({"vad_energy_floor_db": "-50"})["vad_energy_floor_db"] == -50.0
    with pytest.raises(ValueError):
        coerce_settings({"vad_energy_floor_db": "quiet"})
    # from_dict ラウンドトリップ（JSON null → None のまま開ける）
    project = ProjectState.new("floor-rt", "roundtrip")
    data = json.loads(json.dumps(project.to_dict()))
    assert data["settings"]["vad_energy_floor_db"] is None
    assert ProjectState.from_dict(data).settings["vad_energy_floor_db"] is None
    data["settings"]["vad_energy_floor_db"] = -42
    assert ProjectState.from_dict(data).settings["vad_energy_floor_db"] == -42.0
