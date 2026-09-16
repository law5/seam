"""アーカイブ / 復元（Issue #22）のテスト。

- POST /archive の前提条件（元音源欠損 / ジョブ実行中 / 二重アーカイブ / 中間WAV欠損）
- アーカイブの実行結果（記録・削除・freed_bytes・peaks.u8 温存）
- 「開く」経由の復元ジョブ起票と採用（converted / normalized 両モード）
- ffmpeg 実機でのアーカイブ→復元ラウンドトリップのバイト同一性
- フレーム数不一致 → 復元失敗 + normalized_wav を残さない
- 元音源欠損のアーカイブ済みプロジェクトを開いたときの 400
- アーカイブ済みプロジェクトのエクスポート拒否メッセージ
- models: archived の to_dict/from_dict ラウンドトリップ（非アーカイブは additive）
"""

from __future__ import annotations

import json
import shutil
import struct
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_prep import server, storage
from podcast_prep.audio import convert_to_pcm, normalize_loudnorm, wave_info
from podcast_prep.exporter import export_project
from podcast_prep.models import Block, ProjectState

requires_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg not installed"
)


@pytest.fixture
def client():
    return TestClient(server.app)


@pytest.fixture(autouse=True)
def _tmp_data(tmp_path, monkeypatch):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))


def _write_wav(path: Path, frames: int = 1600, rate: int = 8000, amplitude: int = 4096):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        # DC 定数はラウドネス計測が -inf になる（loudnorm が受け付けない）ため
        # 交番信号（rate/2 の矩形波）で書く
        pair = struct.pack("<hh", amplitude, -amplitude)
        wf.writeframes(pair * (frames // 2) + struct.pack("<h", amplitude) * (frames % 2))


def _make_project(pid="proj-arch", *, with_original=True, with_normalized=True):
    """従来配置に original + normalized 付きのプロジェクトを作る。"""
    project = ProjectState.new(pid, "archive test")
    project.status = "ready"
    pdir = storage.project_dir(pid, create=True)
    for sp in ("A", "B"):
        if with_original:
            _write_wav(pdir / f"speaker{sp}.wav")
            project.tracks[sp].original_file = f"speaker{sp}.wav"
        if with_normalized:
            _write_wav(pdir / f"speaker{sp}_normalized.wav", frames=2400)
            project.tracks[sp].normalized_wav = f"speaker{sp}_normalized.wav"
            project.tracks[sp].duration = 2400 / 8000
    storage.save_project(project)
    return project


# ---------------------------------------------------------------- 前提条件の拒否


def test_archive_missing_project_404(client):
    assert client.post("/api/projects/no-such/archive").status_code == 404


def test_archive_rejects_missing_original(client):
    project = _make_project(with_original=False)
    res = client.post(f"/api/projects/{project.id}/archive")
    assert res.status_code == 400
    assert "元音源" in res.json()["detail"]
    # 1バイトも変えない: 中間WAVは残っている
    assert (storage.project_dir(project.id) / "speakerA_normalized.wav").is_file()


def test_archive_rejects_missing_normalized(client):
    project = _make_project(with_normalized=False)
    res = client.post(f"/api/projects/{project.id}/archive")
    assert res.status_code == 400


def test_archive_rejects_running_job(client):
    project = _make_project()
    job = server._new_job("transcribe", project.id)
    try:
        res = client.post(f"/api/projects/{project.id}/archive")
        assert res.status_code == 400
        assert "実行中" in res.json()["detail"]
    finally:
        server._update_job(job["id"], status="error", error="test cleanup")


def test_archive_rejects_double_archive(client):
    project = _make_project()
    assert client.post(f"/api/projects/{project.id}/archive").status_code == 200
    res = client.post(f"/api/projects/{project.id}/archive")
    assert res.status_code == 400
    assert "アーカイブ済み" in res.json()["detail"]


# ---------------------------------------------------------------- アーカイブの実行結果


def test_archive_deletes_wavs_and_records_metadata(client):
    project = _make_project()
    pdir = storage.project_dir(project.id)
    # peaks サイドカーは削除対象外（波形の即時表示に使う）
    (pdir / "speakerA_peaks.u8").write_bytes(b"PPK1" + b"\x00" * 12)
    wav_bytes = sum(
        (pdir / f"speaker{sp}_normalized.wav").stat().st_size for sp in ("A", "B")
    )
    res = client.post(f"/api/projects/{project.id}/archive")
    assert res.status_code == 200
    body = res.json()
    assert body["freed_bytes"] == wav_bytes
    for sp in ("A", "B"):
        assert not (pdir / f"speaker{sp}_normalized.wav").exists()
    assert (pdir / "speakerA_peaks.u8").is_file()

    saved = storage.load_project(project.id)
    assert saved.status == "archived"
    assert saved.archived is not None
    for sp in ("A", "B"):
        rec = saved.archived["tracks"][sp]
        assert rec["samples"] == 2400
        assert rec["mode"] == "converted"  # loudness_normalized=False の既定
        assert rec["normalized_wav"] == f"speaker{sp}_normalized.wav"
        assert saved.tracks[sp].normalized_wav == ""
        # 元音源の参照は温存（復元の入力）
        assert saved.tracks[sp].original_file == f"speaker{sp}.wav"


def test_archive_records_normalized_mode_from_loudness(client):
    project = _make_project()
    project.tracks["A"].loudness_normalized = True
    project.tracks["A"].loudness = {"normalized": {"input_i": "-16.0"}}
    # スキップされた正規化は実体がフィルタなし変換 → converted として記録する
    project.tracks["B"].loudness_normalized = True
    project.tracks["B"].loudness = {"normalization_skipped": True, "normalized": None}
    storage.save_project(project)
    assert client.post(f"/api/projects/{project.id}/archive").status_code == 200
    saved = storage.load_project(project.id)
    assert saved.archived["tracks"]["A"]["mode"] == "normalized"
    assert saved.archived["tracks"]["B"]["mode"] == "converted"


# ---------------------------------------------------------------- 「開く」経由の復元


def _archived_folder(base: Path, pid: str, *, drop_original=False) -> Path:
    """作業フォルダ配置のアーカイブ済みプロジェクトを作る。"""
    folder = base / pid
    folder.mkdir(parents=True)
    doc = {
        "id": pid,
        "name": "archived folder",
        "status": "archived",
        "tracks": {},
        "blocks": [
            {"id": "a-1", "speaker": "A", "source_start": 0.0, "source_end": 0.1, "start": 0.0}
        ],
        "archived": {"archived_at": "2026-09-16T00:00:00+00:00", "tracks": {}},
    }
    for sp in ("A", "B"):
        if not drop_original:
            _write_wav(folder / f"speaker{sp}.wav")
        doc["tracks"][sp] = {
            "speaker": sp,
            "original_file": f"speaker{sp}.wav",
            "normalized_wav": "",
            "loudness_normalized": False,
        }
        doc["archived"]["tracks"][sp] = {
            "normalized_wav": f"speaker{sp}_normalized.wav",
            "samples": 2400,
            "mode": "converted",
            "params": {"target_lufs": -16.0, "true_peak": -1.5, "lra": 11.0, "sample_rate": 48000},
        }
    (folder / "project.json").write_text(json.dumps(doc), encoding="utf-8")
    return folder


def _open_folder(client, folder: Path):
    return client.post("/api/projects/open", data={"source_dir": str(folder)})


def test_open_archived_starts_restore_job_and_restores(tmp_path, monkeypatch, client):
    folder = _archived_folder(tmp_path / "work", "arch-open-1")

    def fake_convert(original, output, sample_rate=48000, progress=None):
        _write_wav(Path(output), frames=2400)
        return {"target_i": None, "input": None, "normalized": None, "loudness_normalized": False}

    monkeypatch.setattr(server, "convert_to_pcm", fake_convert)
    res = _open_folder(client, folder)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["restore_job"]["kind"] == "restore"
    # TestClient は background task を応答生成後に同期実行する → 既に完了している
    job = client.get(f"/api/jobs/{body['restore_job']['id']}").json()
    assert job["status"] == "complete", job
    result = job["result"]["project"]
    assert result.get("archived") is None
    pid = body["project"]["id"]
    saved = storage.load_project(pid)
    assert saved.archived is None
    for sp in ("A", "B"):
        assert saved.tracks[sp].normalized_wav == f"speaker{sp}_normalized.wav"
        assert (folder / f"speaker{sp}_normalized.wav").is_file()
    assert saved.status == "ready"


def test_open_archived_without_original_400(tmp_path, client):
    folder = _archived_folder(tmp_path / "work", "arch-open-2", drop_original=True)
    res = _open_folder(client, folder)
    assert res.status_code == 400
    assert "アーカイブ済み" in res.json()["detail"]
    assert "復元" in res.json()["detail"]


def test_open_non_archived_has_no_restore_job(tmp_path, client):
    folder = tmp_path / "work" / "plain"
    folder.mkdir(parents=True)
    doc = {
        "id": "plain-open",
        "name": "plain",
        "tracks": {
            sp: {"speaker": sp, "original_file": "", "normalized_wav": f"speaker{sp}_normalized.wav"}
            for sp in ("A", "B")
        },
        "blocks": [],
    }
    for sp in ("A", "B"):
        _write_wav(folder / f"speaker{sp}_normalized.wav")
    (folder / "project.json").write_text(json.dumps(doc), encoding="utf-8")
    res = _open_folder(client, folder)
    assert res.status_code == 200, res.text
    assert "restore_job" not in res.json()


# ---------------------------------------------------------------- フレーム数照合


def test_restore_mismatch_fails_and_removes_wav(tmp_path, monkeypatch, client):
    folder = _archived_folder(tmp_path / "work", "arch-mismatch")

    def fake_convert(original, output, sample_rate=48000, progress=None):
        _write_wav(Path(output), frames=999)  # 記録 2400 と不一致
        return {"target_i": None, "input": None, "normalized": None, "loudness_normalized": False}

    monkeypatch.setattr(server, "convert_to_pcm", fake_convert)
    res = _open_folder(client, folder)
    assert res.status_code == 200, res.text
    job = client.get(f"/api/jobs/{res.json()['restore_job']['id']}").json()
    assert job["status"] == "error"
    assert "一致しません" in job["error"]
    # 不一致の normalized_wav は残さない・アーカイブ記録は解除しない
    assert not (folder / "speakerA_normalized.wav").exists()
    saved = storage.load_project(res.json()["project"]["id"])
    assert saved.archived is not None
    assert saved.tracks["A"].normalized_wav == ""


# ---------------------------------------------------------------- ffmpeg 実機ラウンドトリップ


def _roundtrip(client, tmp_path, pid: str, *, normalized_mode: bool):
    folder = tmp_path / "work" / pid
    folder.mkdir(parents=True)
    for sp in ("A", "B"):
        # EBU R128 のゲーティングは 400ms ブロック単位 → 短すぎると計測が -inf に
        # なる（loudnorm が受け付けない）ため 1.2 秒にする
        _write_wav(folder / f"speaker{sp}.wav", frames=9600, rate=8000)
    doc = {
        "id": pid,
        "name": pid,
        "tracks": {},
        "blocks": [
            {"id": "a-1", "speaker": "A", "source_start": 0.0, "source_end": 0.1, "start": 0.0}
        ],
    }
    originals = {}
    for sp in ("A", "B"):
        out = folder / f"speaker{sp}_normalized.wav"
        if normalized_mode:
            loudness = normalize_loudnorm(
                folder / f"speaker{sp}.wav", out,
                target_i=-16.0, true_peak=-1.5, lra=11.0, tolerance=0.0,
            )
        else:
            loudness = convert_to_pcm(folder / f"speaker{sp}.wav", out, sample_rate=48000)
        originals[sp] = out.read_bytes()
        doc["tracks"][sp] = {
            "speaker": sp,
            "original_file": f"speaker{sp}.wav",
            "normalized_wav": out.name,
            "duration": wave_info(out)["duration"],
            "loudness": loudness,
            "loudness_normalized": loudness["loudness_normalized"],
        }
    (folder / "project.json").write_text(json.dumps(doc), encoding="utf-8")

    res = _open_folder(client, folder)
    assert res.status_code == 200, res.text
    pid_actual = res.json()["project"]["id"]
    assert client.post(f"/api/projects/{pid_actual}/archive").status_code == 200
    for sp in ("A", "B"):
        assert not (folder / f"speaker{sp}_normalized.wav").exists()

    res2 = _open_folder(client, folder)
    assert res2.status_code == 200, res2.text
    job = client.get(f"/api/jobs/{res2.json()['restore_job']['id']}").json()
    assert job["status"] == "complete", job
    for sp in ("A", "B"):
        assert (folder / f"speaker{sp}_normalized.wav").read_bytes() == originals[sp]
    saved = storage.load_project(pid_actual)
    assert saved.archived is None
    # 復元は取込ではない: blocks は温存される
    assert [b.id for b in saved.blocks] == ["a-1"]


@requires_ffmpeg
def test_roundtrip_byte_identical_converted(tmp_path, client):
    _roundtrip(client, tmp_path, "rt-converted", normalized_mode=False)


@requires_ffmpeg
def test_roundtrip_byte_identical_normalized(tmp_path, client):
    _roundtrip(client, tmp_path, "rt-normalized", normalized_mode=True)


# ---------------------------------------------------------------- エクスポート拒否


def test_export_rejects_archived_project_with_guidance(tmp_path):
    project = ProjectState.new("arch-export", "archived export")
    project.blocks = [Block(id="a-1", speaker="A", source_start=0.0, source_end=1.0, start=0.0)]
    project.archived = {"archived_at": "2026-09-16T00:00:00+00:00", "tracks": {}}
    with pytest.raises(ValueError, match="アーカイブ済み"):
        export_project(project, tmp_path / "export-target")


# ---------------------------------------------------------------- models ラウンドトリップ


def test_models_archived_roundtrip():
    project = ProjectState.new("m-arch", "models")
    assert "archived" not in project.to_dict()  # 非アーカイブは従来と同一キー構成
    record = {"archived_at": "2026-09-16T00:00:00+00:00", "tracks": {"A": {"samples": 1}}}
    project.archived = record
    data = project.to_dict()
    assert data["archived"] == record
    assert ProjectState.from_dict(data).archived == record
    # 不正型は None に落とす
    data["archived"] = "broken"
    assert ProjectState.from_dict(data).archived is None
