"""Whisperモデル管理API（Issue #12）のテスト。実ダウンロードはしない。

- GET /api/whisper/models: 配置有無の判定（model.bin 実在）・size_bytes・
  compute_types の available が cuda 判定に連動すること
- POST /api/whisper/models/download: 許可リスト外 400 / 配置済み即 complete /
  同一モデルの多重ダウンロード防止 / DL完了検証（model.bin 欠損は error）
- settings 既定値（whisper_compute_type / whisper_device）の後方互換マージ
"""

from __future__ import annotations

import sys
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from podcast_prep import server, transcribe
from podcast_prep.models import ProjectState, default_settings
from podcast_prep.transcribe import WHISPER_MODEL_NAMES


@pytest.fixture
def client():
    return TestClient(server.app)


@pytest.fixture(autouse=True)
def _isolated_jobs():
    """テストごとにジョブ辞書を退避・復元する（多重DL防止テストが注入するため）。"""
    with server._job_lock:
        saved = dict(server._jobs)
        server._jobs.clear()
    yield
    with server._job_lock:
        server._jobs.clear()
        server._jobs.update(saved)


def _use_tmp_data_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    return tmp_path


def _place_model(tmp_path, name: str, *, with_bin: bool = True, extra_bytes: int = 0):
    """models/faster-whisper-{name} を疑似配置する。"""
    target = tmp_path / "models" / f"faster-whisper-{name}"
    target.mkdir(parents=True, exist_ok=True)
    if with_bin:
        (target / "model.bin").write_bytes(b"x" * 1024)
    if extra_bytes:
        (target / "tokenizer.json").write_bytes(b"y" * extra_bytes)
    return target


# ---------------------------------------------------------------- GET /api/whisper/models


def test_models_list_reports_downloaded_and_size(monkeypatch, tmp_path, client):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    _place_model(tmp_path, "small", with_bin=True, extra_bytes=2048)
    # model.bin の無いディレクトリは「未配置」（部分DLを済み扱いしない）
    _place_model(tmp_path, "medium", with_bin=False, extra_bytes=512)

    res = client.get("/api/whisper/models")
    assert res.status_code == 200
    models = {m["name"]: m for m in res.json()["models"]}
    assert list(models) == list(WHISPER_MODEL_NAMES)  # 順序も契約どおり

    assert models["small"]["downloaded"] is True
    assert models["small"]["size_bytes"] == 1024 + 2048
    assert models["medium"]["downloaded"] is False
    assert models["medium"]["size_bytes"] is None
    assert models["tiny"]["downloaded"] is False
    for item in models.values():
        assert isinstance(item["speed_hint"], str) and item["speed_hint"]


def test_models_list_size_excludes_hf_cache(monkeypatch, tmp_path, client):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    target = _place_model(tmp_path, "small", with_bin=True)
    cache = target / ".cache" / "huggingface"
    cache.mkdir(parents=True)
    (cache / "meta.lock").write_bytes(b"z" * 4096)

    res = client.get("/api/whisper/models")
    models = {m["name"]: m for m in res.json()["models"]}
    assert models["small"]["size_bytes"] == 1024


@pytest.mark.parametrize("cuda", [False, True])
def test_compute_types_availability_follows_cuda(monkeypatch, tmp_path, client, cuda):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    monkeypatch.setattr(server, "_cuda_available", lambda: cuda)

    env = client.get("/api/whisper/models").json()["environment"]
    assert env["platform"] == sys.platform
    assert env["cuda_available"] is cuda
    options = {o["value"]: o for o in env["compute_types"]}
    assert list(options) == ["auto", "int8", "float16", "float32"]
    assert options["auto"]["available"] is True
    assert options["auto"]["note"] is None
    assert options["int8"]["available"] is True
    assert options["float16"]["available"] is cuda  # CUDA 連動
    assert options["float16"]["note"] == "CUDA環境のみ選択可能"
    assert options["float32"]["available"] is True


# ---------------------------------------------------------------- POST /api/whisper/models/download


@pytest.mark.parametrize("payload", [None, {}, {"model": "large-v2"}, {"model": "../evil"}])
def test_download_rejects_unknown_model(monkeypatch, tmp_path, client, payload):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    res = client.post("/api/whisper/models/download", json=payload)
    assert res.status_code == 400


def test_download_already_downloaded_completes_immediately(monkeypatch, tmp_path, client):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    _place_model(tmp_path, "small", with_bin=True)

    def _must_not_download(*args, **kwargs):  # pragma: no cover - 呼ばれたら失敗
        raise AssertionError("download_whisper_model must not be called")

    monkeypatch.setattr(server, "download_whisper_model", _must_not_download)
    res = client.post("/api/whisper/models/download", json={"model": "small"})
    assert res.status_code == 200
    job = res.json()["job"]
    assert job["kind"] == "model_download"
    assert job["status"] == "complete"
    assert job["progress"] == 1.0
    assert job["result"]["already_downloaded"] is True
    assert job["result"]["model"] == "small"


def test_download_dedupes_running_job(monkeypatch, tmp_path, client):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    running = {
        "id": uuid4().hex,
        "kind": "model_download",
        "project_id": "",
        "status": "running",
        "progress": 0.4,
        "message": "Downloading model small (40%)",
        "result": None,
        "error": None,
        "created_at": time.time(),
        "model": "small",
    }
    with server._job_lock:
        server._jobs[running["id"]] = running

    res = client.post("/api/whisper/models/download", json={"model": "small"})
    assert res.status_code == 200
    assert res.json()["job"]["id"] == running["id"]  # 新規ジョブを作らない
    with server._job_lock:
        dl_jobs = [j for j in server._jobs.values() if j["kind"] == "model_download"]
    assert len(dl_jobs) == 1

    # 別モデルはブロックされない
    monkeypatch.setattr(server, "download_whisper_model", lambda model, target: target)
    res2 = client.post("/api/whisper/models/download", json={"model": "tiny"})
    assert res2.json()["job"]["id"] != running["id"]


def test_download_job_completes_and_verifies(monkeypatch, tmp_path, client):
    _use_tmp_data_dir(monkeypatch, tmp_path)

    def fake_download(model, target):
        target.mkdir(parents=True, exist_ok=True)
        (target / "model.bin").write_bytes(b"w" * 2048)
        return target

    monkeypatch.setattr(server, "download_whisper_model", fake_download)
    res = client.post("/api/whisper/models/download", json={"model": "tiny"})
    assert res.status_code == 200
    job_id = res.json()["job"]["id"]
    # TestClient は background task を同期実行するため、この時点で完了している
    job = client.get(f"/api/jobs/{job_id}").json()
    assert job["status"] == "complete"
    assert job["progress"] == 1.0
    assert job["result"]["size_bytes"] == 2048
    assert (tmp_path / "models" / "faster-whisper-tiny" / "model.bin").exists()


def test_download_missing_model_bin_becomes_job_error(monkeypatch, tmp_path, client):
    _use_tmp_data_dir(monkeypatch, tmp_path)

    def fake_download(model, target):
        target.mkdir(parents=True, exist_ok=True)  # model.bin を書かない = 完了検証に失敗
        return target

    monkeypatch.setattr(server, "download_whisper_model", fake_download)
    res = client.post("/api/whisper/models/download", json={"model": "tiny"})
    job = client.get(f"/api/jobs/{res.json()['job']['id']}").json()
    assert job["status"] == "error"
    assert "model.bin" in job["error"]


# ---------------------------------------------------------------- settings 既定値・後方互換


def test_default_settings_include_whisper_runtime_keys():
    settings = default_settings()
    assert settings["whisper_compute_type"] == "auto"
    assert settings["whisper_device"] == "auto"


def test_legacy_project_json_gains_runtime_keys_via_merge():
    legacy = {
        "id": "proj-legacy",
        "name": "old",
        "settings": {"whisper_model": "small"},  # 旧 project.json（新キー欠損）
        "tracks": {},
    }
    project = ProjectState.from_dict(legacy)
    assert project.settings["whisper_compute_type"] == "auto"
    assert project.settings["whisper_device"] == "auto"
    assert project.settings["whisper_model"] == "small"


# ---------------------------------------------- QA回帰（2026-08-06）


def test_dir_size_counts_inflight_only_when_requested(tmp_path):
    """転送中バイト（.cache配下の .incomplete）は進捗計測時のみ合算する。

    回帰: huggingface_hub は DL 中のバイトを .cache/huggingface/download/*.incomplete に
    書いて完了時に rename するため、これを除外すると model.bin 転送中ずっと進捗が
    数%で固まって見える（QAで実測: tiny で総DL時間の8割が3%固定）。
    """
    root = tmp_path / "faster-whisper-x"
    (root / ".cache" / "huggingface" / "download").mkdir(parents=True)
    (root / "config.json").write_bytes(b"x" * 1000)
    (root / ".cache" / "huggingface" / "download" / "model.bin.incomplete").write_bytes(b"y" * 50_000)
    (root / ".cache" / "huggingface" / "download" / "model.bin.metadata").write_bytes(b"z" * 100)

    # 完了サイズの報告は従来どおり .cache を丸ごと除外
    assert transcribe.dir_size_bytes(root) == 1000
    # 進捗計測時は .incomplete のみ合算（metadata は除外のまま）
    assert transcribe.dir_size_bytes(root, include_inflight=True) == 51_000


def test_inflight_progress_is_visible_during_download(tmp_path, monkeypatch):
    """.incomplete しか無い段階でも進捗が 0 より大きくなる（ハング誤認の防止）。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    target = transcribe.whisper_model_dir("small")
    (target / ".cache" / "huggingface" / "download").mkdir(parents=True)
    (target / ".cache" / "huggingface" / "download" / "model.bin.incomplete").write_bytes(
        b"a" * 200_000_000
    )
    approx = transcribe.WHISPER_MODEL_APPROX_BYTES["small"]
    without = transcribe.whisper_model_size_bytes("small") / approx
    with_inflight = transcribe.whisper_model_size_bytes("small", include_inflight=True) / approx
    assert without == 0.0
    assert with_inflight > 0.3
