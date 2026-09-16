"""server.py の公開品質修正 + ピークバイナリ配信 + R5進捗配線のテスト。

- 404 変換（load_project の FileNotFoundError）
- POST /projects/open の異常系 400 / サイズ上限 413
- GET /preview の duration 上限 + previews/ 掃除
- GET /peaks の PPK1 応答 + サイドカー遅延生成
- GET /audio の Range 206/416（FileResponse 維持の生命線）
- PUT /raw のラウンドトリップ検証
- updated_at が保存時のみスタンプされること（storage 側）
- _run_import / _run_export の進捗帯マッピングと TimeoutError のジョブ error 化
- 完了ジョブの間引き
- L: ラウドネス正規化の選択制（取込スキップ / 後がけ POST /normalize /
  ブロック保持の不変条件 / loudness_normalized の後方互換）
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import time
import wave
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from podcast_prep import server, storage
from podcast_prep.models import ProjectState

requires_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg not installed"
)


def _make_project(tmp_path, monkeypatch, pid="proj-api"):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    project = ProjectState.new(pid, "server api test")
    project.status = "ready"
    storage.save_project(project)
    return project


def _write_wav(path: Path, seconds: float = 1.0, rate: int = 8000, amplitude: int = 16384):
    frames = int(seconds * rate)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(struct.pack("<h", amplitude) * frames)


def _attach_normalized_wav(project, speaker="A", seconds=1.0):
    pdir = storage.project_dir(project.id)
    name = f"speaker{speaker}_normalized.wav"
    _write_wav(pdir / name, seconds=seconds)
    project.tracks[speaker].normalized_wav = name
    storage.save_project(project)
    return pdir / name


@pytest.fixture
def client():
    return TestClient(server.app)


# ---------------------------------------------------------------- 404 変換


@pytest.mark.parametrize(
    "method,url",
    [
        ("GET", "/api/projects/no-such"),
        ("GET", "/api/projects/no-such/audio/A"),
        ("GET", "/api/projects/no-such/peaks/A"),
        ("GET", "/api/projects/no-such/preview/A"),
        ("GET", "/api/projects/no-such/raw"),
        ("POST", "/api/projects/no-such/transcribe"),
        ("POST", "/api/projects/no-such/export"),
    ],
)
def test_missing_project_returns_404(tmp_path, monkeypatch, client, method, url):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    res = client.request(method, url)
    assert res.status_code == 404


# ---------------------------------------------------------------- POST /projects/open


def _upload_project_json(client, content: bytes):
    return client.post(
        "/api/projects/open",
        files={"project_json": ("project.json", content, "application/json")},
    )


def test_open_rejects_invalid_json(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    assert _upload_project_json(client, b"{not json").status_code == 400


def test_open_rejects_non_object_json(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    assert _upload_project_json(client, b"[1, 2, 3]").status_code == 400


def test_open_rejects_missing_required_keys(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    assert _upload_project_json(client, b"{}").status_code == 400  # id 欠落 → KeyError → 400


def test_open_enforces_size_limit(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(server, "MAX_UPLOAD_BYTES", 16)
    payload = b'{"id": "proj-open", "name": "long enough to exceed"}'
    assert _upload_project_json(client, payload).status_code == 413


def test_open_valid_project_roundtrip(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    doc = ProjectState.new("proj-open", "opened").to_dict()
    doc["status"] = "importing"  # open は status を ready に強制する
    import json as _json

    res = _upload_project_json(client, _json.dumps(doc).encode("utf-8"))
    assert res.status_code == 200
    assert res.json()["project"]["status"] == "ready"
    assert storage.load_project("proj-open").name == "opened"


# ---------------------------------------------------------------- GET /preview


def test_preview_duration_limit(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch)
    _attach_normalized_wav(project, "A")
    assert client.get(f"/api/projects/{project.id}/preview/A?duration=31").status_code == 400
    assert client.get(f"/api/projects/{project.id}/preview/A?duration=0").status_code == 400
    assert client.get(f"/api/projects/{project.id}/preview/A?duration=-2").status_code == 400


def test_preview_prunes_stale_files(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch)
    _attach_normalized_wav(project, "A")

    def fake_render(source, output, *, start, duration, gain_db, deesser):
        Path(output).write_bytes(b"RIFFfake")

    monkeypatch.setattr(server, "render_preview_segment", fake_render)
    preview_dir = storage.project_dir(project.id) / "previews"
    preview_dir.mkdir(parents=True, exist_ok=True)
    now = time.time()
    # 20分超の古いファイル3件 + 新しいファイル12件（直近10件超過分も間引かれる）
    for i in range(3):
        path = preview_dir / f"old_{i}.wav"
        path.write_bytes(b"x")
        os.utime(path, (now - 1800, now - 1800))
    for i in range(12):
        path = preview_dir / f"recent_{i}.wav"
        path.write_bytes(b"x")
        os.utime(path, (now - i, now - i))
    res = client.get(f"/api/projects/{project.id}/preview/A?duration=5")
    assert res.status_code == 200
    remaining = [p.name for p in preview_dir.iterdir()]
    assert not any(name.startswith("old_") for name in remaining)
    # 直近10件 + 新規生成1件
    assert len(remaining) == 11


# ---------------------------------------------------------------- GET /peaks（PPK1）


def test_peaks_lazy_generation_and_sidecar_cache(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch)
    source = _attach_normalized_wav(project, "A", seconds=1.0)
    res = client.get(f"/api/projects/{project.id}/peaks/A")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/octet-stream")
    body = res.content
    assert body[:4] == b"PPK1"
    bins_per_sec, bin_count, reserved = struct.unpack("<III", body[4:16])
    assert (bins_per_sec, reserved) == (200, 0)
    assert bin_count == 200  # 1秒 @8kHz / bucket=round(8000/200)=40 → 200ビン
    assert len(body) == 16 + bin_count
    assert set(body[16:]) == {128}  # 一定振幅 16384 → (16384*255+16384)//32768 = 128
    sidecar = storage.project_dir(project.id) / "speakerA_peaks.u8"
    assert sidecar.read_bytes() == body
    # ソースWAVを消してもサイドカーから配信される（再生成しない）
    source.unlink()
    res2 = client.get(f"/api/projects/{project.id}/peaks/A")
    assert res2.status_code == 200
    assert res2.content == body


def test_peaks_404_without_source_or_sidecar(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch)
    # normalized_wav 未設定
    assert client.get(f"/api/projects/{project.id}/peaks/A").status_code == 404
    # 設定はあるがファイル不在
    project.tracks["B"].normalized_wav = "missing.wav"
    storage.save_project(project)
    assert client.get(f"/api/projects/{project.id}/peaks/B").status_code == 404


# ---------------------------------------------------------------- GET /audio（Range）


def test_audio_range_206_and_416(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch)
    path = _attach_normalized_wav(project, "A", seconds=1.0)
    raw = path.read_bytes()
    full = client.get(f"/api/projects/{project.id}/audio/A")
    assert full.status_code == 200
    assert full.headers.get("accept-ranges") == "bytes"
    head = client.get(
        f"/api/projects/{project.id}/audio/A", headers={"Range": "bytes=0-99"}
    )
    assert head.status_code == 206
    assert head.content == raw[:100]
    assert head.headers["content-range"].startswith("bytes 0-99/")
    mid = client.get(
        f"/api/projects/{project.id}/audio/A", headers={"Range": "bytes=100-199"}
    )
    assert mid.status_code == 206
    assert mid.content == raw[100:200]
    beyond = client.get(
        f"/api/projects/{project.id}/audio/A",
        headers={"Range": f"bytes={len(raw) + 10}-"},
    )
    assert beyond.status_code == 416


def test_audio_404_when_track_has_no_wav(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch)
    assert client.get(f"/api/projects/{project.id}/audio/A").status_code == 404


# ---------------------------------------------------------------- PUT /raw


def test_raw_put_rejects_unloadable_document(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch)
    before = storage.project_json_path(project.id).read_bytes()
    bad = {"id": project.id, "blocks": [{"speaker": "A"}]}  # ブロック id 欠落 → KeyError
    res = client.put(f"/api/projects/{project.id}/raw", json=bad)
    assert res.status_code == 400
    worse = {"id": project.id, "blocks": 42}  # 反復不能 → TypeError
    assert client.put(f"/api/projects/{project.id}/raw", json=worse).status_code == 400
    assert storage.project_json_path(project.id).read_bytes() == before


def test_raw_put_id_mismatch_400(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch)
    res = client.put(f"/api/projects/{project.id}/raw", json={"id": "other"})
    assert res.status_code == 400


def test_raw_put_valid_document_saved_with_stamp(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch)
    doc = storage.load_project_dict(project.id)
    old_stamp = doc["updated_at"]
    doc["name"] = "renamed"
    res = client.put(f"/api/projects/{project.id}/raw", json=doc)
    assert res.status_code == 200
    saved = storage.load_project_dict(project.id)
    assert saved["name"] == "renamed"
    assert saved["updated_at"] != old_stamp  # save_project_dict がスタンプ
    assert res.json()["project"]["updated_at"] == saved["updated_at"]


# ---------------------------------------------------------------- QA回帰: settings 型検証
# （open/raw が非数値 settings を無検証永続化 → 以後の保存系が全て 500 になる欠陥）


def test_raw_put_rejects_non_numeric_min_overlap(tmp_path, monkeypatch, client):
    """QA再現: PUT /raw settings.min_overlap_s="abc" が 200 受理 → auto_edit / PUT が 500。"""
    project = _make_project(tmp_path, monkeypatch)
    before = storage.project_json_path(project.id).read_bytes()
    doc = storage.load_project_dict(project.id)
    doc["settings"]["min_overlap_s"] = "abc"
    res = client.put(f"/api/projects/{project.id}/raw", json=doc)
    assert res.status_code == 400
    assert "min_overlap_s" in res.json()["detail"]
    assert storage.project_json_path(project.id).read_bytes() == before  # 汚染永続化なし
    # 保存系が生きていること（回帰の本丸: 以後の保存が 500 で詰む欠陥だった）
    assert client.post(f"/api/projects/{project.id}/auto_edit").status_code == 200


def test_raw_put_rejects_non_numeric_peaks_bins(tmp_path, monkeypatch, client):
    """QA再現: peaks_bins_per_sec="many" が受理され GET /peaks が int() で 500。"""
    project = _make_project(tmp_path, monkeypatch)
    doc = storage.load_project_dict(project.id)
    doc["settings"]["peaks_bins_per_sec"] = "many"
    assert client.put(f"/api/projects/{project.id}/raw", json=doc).status_code == 400


def test_open_rejects_null_numeric_setting(tmp_path, monkeypatch, client):
    """QA再現: open で min_overlap_s: null が 200 受理 → 有効ペイロードの PUT も 500。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    doc = ProjectState.new("proj-null-setting", "opened").to_dict()
    doc["settings"]["min_overlap_s"] = None
    res = _upload_project_json(client, json.dumps(doc).encode("utf-8"))
    assert res.status_code == 400
    assert not (tmp_path / "projects" / "proj-null-setting").exists()  # 汚染永続化なし


def test_open_coerces_numeric_strings_and_keeps_default_merge(tmp_path, monkeypatch, client):
    """正常系維持: 欠損キーのデフォルトマージ + 数値文字列の型強制（保存系が全経路生存）。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    doc = ProjectState.new("proj-coerce", "opened").to_dict()
    doc["settings"] = {"min_overlap_s": "0.5", "peaks_bins_per_sec": "100"}  # 他キー欠損
    res = _upload_project_json(client, json.dumps(doc).encode("utf-8"))
    assert res.status_code == 200
    saved = storage.load_project("proj-coerce")
    assert saved.settings["min_overlap_s"] == 0.5  # float に強制
    assert saved.settings["peaks_bins_per_sec"] == 100  # int に強制
    assert saved.settings["target_lufs"] == -16.0  # 欠損キーはデフォルトマージ
    assert saved.settings["whisper_model"] == "medium"  # 非数値キーは無変換
    # 開いた直後に保存系が全て生きている（GET エコーの PUT / auto_edit）
    echoed = client.get("/api/projects/proj-coerce").json()
    assert client.put("/api/projects/proj-coerce", json=echoed).status_code == 200
    assert client.post("/api/projects/proj-coerce/auto_edit").status_code == 200


def test_from_dict_settings_coercion_unit():
    """models 単体: 非数値は ValueError（open/raw の except 対象）、正常系は型強制。"""
    base = ProjectState.new("p", "n").to_dict()
    base["settings"] = {"min_overlap_s": "abc"}
    with pytest.raises(ValueError):
        ProjectState.from_dict(base)
    base["settings"] = {"vad_aggressiveness": None}
    with pytest.raises(ValueError):
        ProjectState.from_dict(base)
    base["settings"] = {"sample_rate": 48000.0, "target_lufs": "-14"}
    state = ProjectState.from_dict(base)
    assert state.settings["sample_rate"] == 48000 and isinstance(
        state.settings["sample_rate"], int
    )
    assert state.settings["target_lufs"] == -14.0


# ---------------------------------------------------------------- QA回帰: サイドカー破損の自己修復
# （非アトミック書込の部分ファイルが is_file() だけで恒久配信される欠陥）


def _corrupt_and_refetch(client, project, sidecar, corrupt: bytes):
    sidecar.write_bytes(corrupt)
    res = client.get(f"/api/projects/{project.id}/peaks/A")
    assert res.status_code == 200
    body = res.content
    assert body[:4] == b"PPK1"
    bin_count = struct.unpack_from("<I", body, 8)[0]
    assert len(body) == 16 + bin_count  # ヘッダ宣言とサイズが一致する完全なファイル
    assert sidecar.read_bytes() == body  # ディスク上も修復済み
    return body


def test_corrupt_sidecar_is_deleted_and_regenerated(tmp_path, monkeypatch, client):
    """QA再現: 7バイトへの truncate 後も 200 で破損がそのまま配信され続けた。"""
    project = _make_project(tmp_path, monkeypatch)
    _attach_normalized_wav(project, "A", seconds=1.0)
    first = client.get(f"/api/projects/{project.id}/peaks/A")
    assert first.status_code == 200
    sidecar = storage.project_dir(project.id) / "speakerA_peaks.u8"
    # (1) マジックごと壊れた 7 バイト
    body = _corrupt_and_refetch(client, project, sidecar, b"PPK1\x00\x00\x00"[:7])
    # (2) マジック・ヘッダは有効だがボディが欠けた部分ファイル（RLIMIT/ENOSPC 途中失敗の形）
    truncated = first.content[: 16 + 10]  # 宣言 bin_count のまま 10 バイトだけ残す
    body2 = _corrupt_and_refetch(client, project, sidecar, truncated)
    assert body == body2 == first.content


def test_corrupt_sidecar_without_source_is_404_not_served(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch)
    sidecar = storage.project_dir(project.id, create=True) / "speakerA_peaks.u8"
    sidecar.write_bytes(b"garbage")  # normalized_wav 未設定なので再生成不能
    res = client.get(f"/api/projects/{project.id}/peaks/A")
    assert res.status_code == 404  # 破損の 200 配信より欠損の 404
    assert not sidecar.exists()  # 破損ファイルは削除される


def test_atomic_write_bytes_keeps_original_on_failure(tmp_path, monkeypatch):
    """途中失敗で最終パスに部分ファイルが残らない（QA指摘の書込パターン）。"""
    target = tmp_path / "peaks.u8"
    target.write_bytes(b"original")
    monkeypatch.setattr(
        storage.os, "replace", lambda src, dst: (_ for _ in ()).throw(OSError("disk full"))
    )
    with pytest.raises(OSError):
        storage.atomic_write_bytes(target, b"new-content")
    assert target.read_bytes() == b"original"  # 旧内容が無傷
    assert [p.name for p in tmp_path.iterdir()] == ["peaks.u8"]  # tmp 残骸なし


def test_save_project_failure_keeps_previous_json(tmp_path, monkeypatch):
    """project.json も tmp+replace: 書込失敗がクラッシュしても全損しない。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    project = ProjectState.new("proj-atomic", "atomic")
    storage.save_project(project)
    before = storage.project_json_path(project.id).read_bytes()
    monkeypatch.setattr(
        storage.os, "replace", lambda src, dst: (_ for _ in ()).throw(OSError("disk full"))
    )
    project.name = "changed"
    with pytest.raises(OSError):
        storage.save_project(project)
    assert storage.project_json_path(project.id).read_bytes() == before


def test_save_project_leaves_no_tmp_residue(tmp_path, monkeypatch):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    project = ProjectState.new("proj-clean", "clean")
    storage.save_project(project)
    storage.save_project_dict(storage.load_project_dict(project.id))
    assert [p.name for p in storage.project_dir(project.id).iterdir()] == ["project.json"]


# ---------------------------------------------------------------- QA回帰: project id 検証
# （'..' で 500、'.'/'' で projects ルート直下に project.json、404 probe で空ディレクトリ）


@pytest.mark.parametrize("bad_id", ["..", ".", "", "evil/nested", "a" * 65, "has space"])
def test_open_rejects_invalid_project_ids(tmp_path, monkeypatch, client, bad_id):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    doc = ProjectState.new("placeholder", "opened").to_dict()
    doc["id"] = bad_id
    res = _upload_project_json(client, json.dumps(doc).encode("utf-8"))
    assert res.status_code == 400
    projects = tmp_path / "projects"
    # QA再現の後遺症が無いこと: ルート直下 project.json・ネストディレクトリの迷子ファイル
    assert not projects.exists() or list(projects.iterdir()) == []


def test_open_accepts_hyphen_underscore_ids(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    doc = ProjectState.new("Proj_ok-123", "opened").to_dict()
    res = _upload_project_json(client, json.dumps(doc).encode("utf-8"))
    assert res.status_code == 200


def test_raw_put_rejects_invalid_path_id(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    bad_id = "a" * 65
    res = client.put(f"/api/projects/{bad_id}/raw", json={"id": bad_id})
    assert res.status_code == 400
    assert not (tmp_path / "projects" / bad_id).exists()


def test_404_probe_does_not_create_directories(tmp_path, monkeypatch, client):
    """QA再現: 存在しない id の GET のたびに空ディレクトリが蓄積されていた。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    for url in (
        "/api/projects/no-such-id-12345",
        "/api/projects/no-such-id-12345/raw",
        "/api/projects/no-such-id-12345/audio/A",
        "/api/projects/no-such-id-12345/peaks/A",
        "/api/projects/no-such-id-12345/preview/A",
    ):
        assert client.get(url).status_code == 404
    projects = tmp_path / "projects"
    assert not projects.exists() or list(projects.iterdir()) == []


# ---------------------------------------------------------------- QA回帰: normalized_wav トラバーサル値
# （resolve_project_file の ValueError 未変換で audio/peaks/preview が 500）


@pytest.mark.parametrize("evil", ["../../../etc/hosts", "/etc/hosts"])
def test_traversal_normalized_wav_is_404_not_500(tmp_path, monkeypatch, client, evil):
    project = _make_project(tmp_path, monkeypatch)
    doc = storage.load_project_dict(project.id)
    doc["tracks"]["A"]["normalized_wav"] = evil
    # 受理仕様は現状維持（修正は配信3エンドポイントの 404 正規化）
    assert client.put(f"/api/projects/{project.id}/raw", json=doc).status_code == 200
    for url in (
        f"/api/projects/{project.id}/audio/A",
        f"/api/projects/{project.id}/peaks/A",
        f"/api/projects/{project.id}/preview/A?duration=5",
    ):
        res = client.get(url)
        assert res.status_code == 404  # 500 でも 200（流出）でもない
        assert b"localhost" not in res.content  # /etc/hosts の内容が漏れない


# ---------------------------------------------------------------- updated_at の意味論


def test_updated_at_changes_only_on_save(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch)
    on_disk = storage.load_project_dict(project.id)["updated_at"]
    # GET は読み取りだけ → updated_at を変えない（to_dict 再スタンプ廃止 + 保存なし）
    first = client.get(f"/api/projects/{project.id}").json()["updated_at"]
    second = client.get(f"/api/projects/{project.id}").json()["updated_at"]
    assert first == second == on_disk
    assert storage.load_project_dict(project.id)["updated_at"] == on_disk
    # PUT（保存）でだけスタンプが進む
    doc = client.get(f"/api/projects/{project.id}").json()
    res = client.put(f"/api/projects/{project.id}", json=doc)
    assert res.status_code == 200
    stamped = storage.load_project_dict(project.id)["updated_at"]
    assert stamped != on_disk
    assert res.json()["project"]["updated_at"] == stamped


# ---------------------------------------------------------------- ジョブ間引き


def test_finished_jobs_are_pruned_on_new_job(monkeypatch):
    monkeypatch.setattr(server, "_jobs", {})
    now = time.time()
    # 1時間超過の完了ジョブ → 削除対象
    server._jobs["stale"] = {
        "id": "stale", "kind": "export", "project_id": "p", "status": "complete",
        "progress": 1.0, "message": "", "result": None, "error": None,
        "created_at": now - 8000, "finished_at": now - 7200,
    }
    # 直近の完了ジョブを上限+5件 → 古い5件が削除される
    for i in range(server.JOB_KEEP_FINISHED + 5):
        jid = f"done-{i:03d}"
        server._jobs[jid] = {
            "id": jid, "kind": "export", "project_id": "p", "status": "complete",
            "progress": 1.0, "message": "", "result": None, "error": None,
            "created_at": now - 200, "finished_at": now - 100 + i,
        }
    # running のジョブは絶対に消えない
    server._jobs["running"] = {
        "id": "running", "kind": "import", "project_id": "p", "status": "running",
        "progress": 0.5, "message": "", "result": None, "error": None,
        "created_at": now - 9999,
    }
    job = server._new_job("export", "p")
    assert "stale" not in server._jobs
    assert "running" in server._jobs
    assert job["id"] in server._jobs
    finished = [j for j in server._jobs.values() if j["status"] == "complete"]
    assert len(finished) == server.JOB_KEEP_FINISHED
    # 残るのは finished_at が新しい方から50件
    assert "done-000" not in server._jobs
    assert f"done-{server.JOB_KEEP_FINISHED + 4:03d}" in server._jobs


# ---------------------------------------------------------------- R5: _run_import 進捗配線


def test_run_import_maps_loudnorm_progress_and_writes_peak_sidecar(tmp_path, monkeypatch):
    project = _make_project(tmp_path, monkeypatch, pid="proj-import")
    project.tracks["A"].original_file = "a.mp3"
    project.tracks["B"].original_file = "b.mp3"
    storage.save_project(project)
    job = server._new_job("import", project.id)
    seen: list[float] = []

    def fake_normalize(
        original, normalized, *, target_i, true_peak, lra, tolerance=0.0, progress=None
    ):
        Path(normalized).write_bytes(b"fake-wav")
        progress(0.5)  # loudnorm 全体の 50% 地点
        seen.append(server._jobs[job["id"]]["progress"])
        return {"target_i": target_i}

    monkeypatch.setattr(server, "normalize_loudnorm", fake_normalize)
    monkeypatch.setattr(server, "ffprobe_duration", lambda path: 60.0)
    monkeypatch.setattr(
        server, "detect_speech_intervals", lambda path, aggressiveness=2: [(0.0, 1.0)]
    )
    monkeypatch.setattr(
        server, "generate_peak_bins", lambda path, bins_per_sec=200: b"PPK1" + b"\x00" * 12
    )
    server._run_import(project.id, job["id"])
    state = server._jobs[job["id"]]
    assert state["status"] == "complete", state["error"]
    # 話者ごとの帯 base+0.02..base+0.26 への線形マップ（fraction=0.5 → base+0.14）
    assert seen == [pytest.approx(0.14), pytest.approx(0.59)]
    for speaker in ("A", "B"):
        sidecar = storage.project_dir(project.id) / f"speaker{speaker}_peaks.u8"
        assert sidecar.read_bytes() == b"PPK1" + b"\x00" * 12
    saved = storage.load_project(project.id)
    assert saved.status == "ready"
    assert saved.tracks["A"].peaks == []  # ピークは project.json に入れない
    assert len(saved.blocks) == 2  # A/B 各1ブロック（fake VAD 区間）


# ---------------------------------------------------------------- L: ラウドネス正規化の選択制


def _import_ready_project(tmp_path, monkeypatch, pid):
    """original_file を持つ取込前プロジェクト（実 WAV 付き）を用意する。"""
    project = _make_project(tmp_path, monkeypatch, pid=pid)
    pdir = storage.project_dir(project.id)
    for speaker in ("A", "B"):
        name = f"{speaker.lower()}.wav"
        _write_wav(pdir / name, seconds=1.0)
        project.tracks[speaker].original_file = name
    storage.save_project(project)
    return project


def _stub_audio_pipeline(monkeypatch, calls):
    """ffmpeg を叩かずに取込/正規化経路を回すスタブ一式。

    normalize_loudnorm / convert_to_pcm のどちらが呼ばれたかを calls に記録する。
    """

    def fake_normalize(
        original, normalized, *, target_i, true_peak, lra, tolerance=0.0, progress=None
    ):
        calls.append(("normalize", Path(normalized).name, target_i))
        Path(normalized).write_bytes(b"normalized-wav")
        if progress:
            progress(1.0)
        return {
            "target_i": target_i,
            "input": {"input_i": -30.0},
            "normalized": {"input_i": target_i},
            "loudness_normalized": True,
        }

    def fake_convert(original, output, sample_rate=48000, progress=None):
        calls.append(("convert", Path(output).name, sample_rate))
        Path(output).write_bytes(b"converted-wav")
        if progress:
            progress(1.0)
        return {
            "target_i": None,
            "input": None,
            "normalized": None,
            "loudness_normalized": False,
        }

    monkeypatch.setattr(server, "normalize_loudnorm", fake_normalize)
    monkeypatch.setattr(server, "convert_to_pcm", fake_convert)
    monkeypatch.setattr(server, "ffprobe_duration", lambda path: 60.0)
    monkeypatch.setattr(
        server, "detect_speech_intervals", lambda path, aggressiveness=2: [(0.0, 1.0)]
    )
    monkeypatch.setattr(
        server, "generate_peak_bins", lambda path, bins_per_sec=200: b"PPK1" + b"\x00" * 12
    )


def test_import_with_normalize_false_skips_loudnorm_but_builds_blocks(
    tmp_path, monkeypatch
):
    """normalize=False の取込: loudnorm は一切走らず、VAD ブロックは生成される。"""
    project = _import_ready_project(tmp_path, monkeypatch, "proj-skip-norm")
    job = server._new_job("import", project.id)
    calls: list[tuple] = []
    _stub_audio_pipeline(monkeypatch, calls)

    server._run_import(project.id, job["id"], False)

    state = server._jobs[job["id"]]
    assert state["status"] == "complete", state["error"]
    # loudnorm は1回も呼ばれない（3パスの数分を丸ごとスキップ）
    assert [kind for kind, _, _ in calls] == ["convert", "convert"]
    saved = storage.load_project(project.id)
    assert saved.status == "ready"
    assert len(saved.blocks) == 2  # VAD ブロックは通常どおり生成される
    for speaker in ("A", "B"):
        track = saved.tracks[speaker]
        assert track.loudness_normalized is False
        assert track.normalized_wav == f"speaker{speaker}_normalized.wav"
        assert track.loudness["normalized"] is None
        sidecar = storage.project_dir(project.id) / f"speaker{speaker}_peaks.u8"
        assert sidecar.is_file()  # ピークは正規化の有無に関わらず作る


def test_import_default_still_normalizes(tmp_path, monkeypatch):
    project = _import_ready_project(tmp_path, monkeypatch, "proj-default-norm")
    job = server._new_job("import", project.id)
    calls: list[tuple] = []
    _stub_audio_pipeline(monkeypatch, calls)

    server._run_import(project.id, job["id"])  # 既定は normalize=True

    assert [kind for kind, _, _ in calls] == ["normalize", "normalize"]
    saved = storage.load_project(project.id)
    assert all(saved.tracks[s].loudness_normalized is True for s in ("A", "B"))


@requires_ffmpeg
def test_import_normalize_false_does_not_change_volume(tmp_path, monkeypatch):
    """実測: normalize=False の取込は音量を動かさない（スタブ無しの実 ffmpeg 経路）。"""
    project = _make_project(tmp_path, monkeypatch, pid="proj-real-skip")
    pdir = storage.project_dir(project.id)
    rate = 48000
    t = np.arange(rate)
    samples = (2000 * np.sin(2 * np.pi * 440 * t / rate)).astype("<i2")  # 静かな素材
    for speaker in ("A", "B"):
        name = f"{speaker.lower()}.wav"
        with wave.open(str(pdir / name), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(rate)
            wf.writeframes(samples.tobytes())
        project.tracks[speaker].original_file = name
    storage.save_project(project)
    job = server._new_job("import", project.id)
    monkeypatch.setattr(
        server, "detect_speech_intervals", lambda path, aggressiveness=2: [(0.0, 1.0)]
    )

    server._run_import(project.id, job["id"], False)

    state = server._jobs[job["id"]]
    assert state["status"] == "complete", state["error"]
    source_peak = int(np.abs(samples.astype(np.int32)).max())
    with wave.open(str(pdir / "speakerA_normalized.wav"), "rb") as wf:
        out = np.frombuffer(wf.readframes(wf.getnframes()), dtype="<i2")
    assert int(np.abs(out.astype(np.int32)).max()) == pytest.approx(source_peak, rel=0.02)


# ---------------------------------------------------------------- L: 後がけ正規化


def _blocks_signature(project):
    return [
        (b.id, b.speaker, b.source_start, b.source_end, b.start, b.deleted)
        for b in project.blocks
    ]


def _normalized_project(tmp_path, monkeypatch, pid, calls):
    """normalize=False で取り込み済み（= 未正規化）のプロジェクトを作る。"""
    project = _import_ready_project(tmp_path, monkeypatch, pid)
    job = server._new_job("import", project.id)
    _stub_audio_pipeline(monkeypatch, calls)
    server._run_import(project.id, job["id"], False)
    assert server._jobs[job["id"]]["status"] == "complete"
    calls.clear()
    return storage.load_project(project.id)


def test_normalize_job_preserves_blocks_and_regenerates_peaks(tmp_path, monkeypatch):
    """後がけ正規化の不変条件: ブロックは保持・ピークは再生成・loudness が入る。"""
    calls: list[tuple] = []
    before = _normalized_project(tmp_path, monkeypatch, "proj-post-norm", calls)
    before_blocks = _blocks_signature(before)
    assert before_blocks, "前提: 取込でブロックが出来ている"
    # ピークサイドカーを別内容にしておき、再生成されたことを検出できるようにする
    pdir = storage.project_dir(before.id)
    for speaker in ("A", "B"):
        (pdir / f"speaker{speaker}_peaks.u8").write_bytes(b"STALE")
    job = server._new_job("normalize", before.id)

    server._run_normalize(before.id, job["id"], ["A", "B"], True, {})

    state = server._jobs[job["id"]]
    assert state["status"] == "complete", state["error"]
    assert [kind for kind, _, _ in calls] == ["normalize", "normalize"]
    after = storage.load_project(before.id)
    # 不変条件: VAD は再実行せず、ブロックは時間軸ごとそのまま
    assert _blocks_signature(after) == before_blocks
    for speaker in ("A", "B"):
        track = after.tracks[speaker]
        assert track.loudness_normalized is True
        assert track.loudness["normalized"] == {"input_i": -16.0}
        # ピークは作り直されている（STALE が残っていない）
        assert (pdir / f"speaker{speaker}_peaks.u8").read_bytes() != b"STALE"


def test_normalize_job_can_revert_to_unnormalized(tmp_path, monkeypatch):
    """normalize=false は「正規化を解除して元に戻す」経路（同一エンドポイント）。"""
    calls: list[tuple] = []
    project = _import_ready_project(tmp_path, monkeypatch, "proj-revert")
    job = server._new_job("import", project.id)
    _stub_audio_pipeline(monkeypatch, calls)
    server._run_import(project.id, job["id"])  # 正規化ありで取込
    calls.clear()
    before_blocks = _blocks_signature(storage.load_project(project.id))

    job2 = server._new_job("normalize", project.id)
    server._run_normalize(project.id, job2["id"], ["A"], False, {})

    assert server._jobs[job2["id"]]["status"] == "complete"
    assert [kind for kind, _, _ in calls] == ["convert"]
    after = storage.load_project(project.id)
    assert after.tracks["A"].loudness_normalized is False
    assert after.tracks["B"].loudness_normalized is True  # 指定外の話者は不変
    assert _blocks_signature(after) == before_blocks


def test_normalize_job_applies_setting_overrides(tmp_path, monkeypatch):
    calls: list[tuple] = []
    project = _normalized_project(tmp_path, monkeypatch, "proj-norm-override", calls)
    job = server._new_job("normalize", project.id)

    server._run_normalize(project.id, job["id"], ["A"], True, {"target_lufs": -14.0})

    assert server._jobs[job["id"]]["status"] == "complete"
    assert calls == [("normalize", "speakerA_normalized.wav", -14.0)]
    assert storage.load_project(project.id).settings["target_lufs"] == -14.0


def test_normalize_job_progress_is_monotonic_across_speakers(tmp_path, monkeypatch):
    calls: list[tuple] = []
    project = _normalized_project(tmp_path, monkeypatch, "proj-norm-progress", calls)
    job = server._new_job("normalize", project.id)
    seen: list[float] = []

    def fake_normalize(
        original, normalized, *, target_i, true_peak, lra, tolerance=0.0, progress=None
    ):
        Path(normalized).write_bytes(b"n")
        for fraction in (0.0, 0.5, 1.0):
            progress(fraction)
            seen.append(server._jobs[job["id"]]["progress"])
        return {"target_i": target_i, "input": {}, "normalized": {}, "loudness_normalized": True}

    monkeypatch.setattr(server, "normalize_loudnorm", fake_normalize)
    server._run_normalize(project.id, job["id"], ["A", "B"], True, {})

    state = server._jobs[job["id"]]
    assert state["status"] == "complete", state["error"]
    assert all(b >= a - 1e-9 for a, b in zip(seen, seen[1:]))  # 話者跨ぎで単調
    assert all(0.0 <= value <= 1.0 for value in seen)
    assert state["progress"] == 1.0


def test_normalize_job_error_path(tmp_path, monkeypatch):
    calls: list[tuple] = []
    project = _normalized_project(tmp_path, monkeypatch, "proj-norm-error", calls)
    before_blocks = _blocks_signature(project)

    def boom(*args, **kwargs):
        raise TimeoutError("command timed out after 3600s: ffmpeg")

    monkeypatch.setattr(server, "normalize_loudnorm", boom)
    job = server._new_job("normalize", project.id)
    server._run_normalize(project.id, job["id"], ["A"], True, {})

    state = server._jobs[job["id"]]
    assert state["status"] == "error"
    assert "timed out" in state["error"]
    assert state["finished_at"] > 0
    after = storage.load_project(project.id)
    assert after.tracks["A"].loudness_normalized is False  # 失敗で状態を偽らない
    assert _blocks_signature(after) == before_blocks  # 失敗してもブロックは無傷


def test_normalize_job_errors_without_original_audio(tmp_path, monkeypatch):
    project = _make_project(tmp_path, monkeypatch, pid="proj-norm-noaudio")
    job = server._new_job("normalize", project.id)
    server._run_normalize(project.id, job["id"], ["A"], True, {})
    state = server._jobs[job["id"]]
    assert state["status"] == "error"
    assert "元音源がありません" in state["error"]


# ---------------------------------------------------------------- L: POST /normalize 入力検証


def test_normalize_endpoint_starts_job(tmp_path, monkeypatch, client):
    calls: list[tuple] = []
    project = _normalized_project(tmp_path, monkeypatch, "proj-norm-api", calls)
    res = client.post(f"/api/projects/{project.id}/normalize", json={"speakers": ["A"]})
    assert res.status_code == 200
    job = res.json()["job"]
    assert job["kind"] == "normalize"
    assert job["project_id"] == project.id
    # TestClient は BackgroundTasks を応答後に同期実行する
    assert server._jobs[job["id"]]["status"] == "complete"
    assert storage.load_project(project.id).tracks["A"].loudness_normalized is True


def test_normalize_endpoint_defaults_to_both_speakers(tmp_path, monkeypatch, client):
    calls: list[tuple] = []
    project = _normalized_project(tmp_path, monkeypatch, "proj-norm-both", calls)
    assert client.post(f"/api/projects/{project.id}/normalize").status_code == 200
    assert [kind for kind, _, _ in calls] == ["normalize", "normalize"]


def test_normalize_endpoint_404_for_missing_project(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    assert client.post("/api/projects/no-such/normalize").status_code == 404


@pytest.mark.parametrize(
    "payload",
    [
        {"speakers": ["C"]},
        {"speakers": "A"},
        {"speakers": []},
        {"target_lufs": "loud"},
        {"lra": "wide"},
        {"true_peak": "hot"},
    ],
)
def test_normalize_endpoint_rejects_bad_payload(tmp_path, monkeypatch, client, payload):
    calls: list[tuple] = []
    project = _normalized_project(tmp_path, monkeypatch, "proj-norm-bad", calls)
    res = client.post(f"/api/projects/{project.id}/normalize", json=payload)
    assert res.status_code == 400
    assert not calls  # ジョブを開始せずに弾く


def test_normalize_endpoint_rejects_speaker_without_audio(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, pid="proj-norm-api-noaudio")
    res = client.post(f"/api/projects/{project.id}/normalize", json={"speakers": ["A"]})
    assert res.status_code == 400
    assert "元音源がありません" in res.json()["detail"]


def test_normalize_endpoint_deduplicates_speakers(tmp_path, monkeypatch, client):
    calls: list[tuple] = []
    project = _normalized_project(tmp_path, monkeypatch, "proj-norm-dupe", calls)
    res = client.post(
        f"/api/projects/{project.id}/normalize", json={"speakers": ["A", "A"]}
    )
    assert res.status_code == 200
    assert [kind for kind, _, _ in calls] == ["normalize"]  # 二度処理しない


# ---------------------------------------------------------------- L: loudness_normalized の後方互換


def test_legacy_project_without_flag_is_treated_as_normalized(tmp_path, monkeypatch, client):
    """旧 project.json（取込時は必ず loudnorm）は計測値の有無で正規化済みと判定する。"""
    project = _make_project(tmp_path, monkeypatch, pid="proj-legacy-flag")
    doc = storage.load_project_dict(project.id)
    doc["tracks"]["A"]["loudness"] = {"target_i": -16.0, "input": {}, "normalized": {}}
    doc["tracks"]["A"].pop("loudness_normalized", None)
    doc["tracks"]["B"]["loudness"] = {}
    doc["tracks"]["B"].pop("loudness_normalized", None)
    storage.save_project_dict(doc)

    loaded = storage.load_project(project.id)
    assert loaded.tracks["A"].loudness_normalized is True  # 計測値あり → 正規化済み
    assert loaded.tracks["B"].loudness_normalized is False  # 未取込 → 未正規化
    # API 応答にもフラグが出る（UI が現在状態を表示できることが要件）
    body = client.get(f"/api/projects/{project.id}").json()
    assert body["tracks"]["A"]["loudness_normalized"] is True
    assert body["tracks"]["B"]["loudness_normalized"] is False


def test_loudness_normalized_survives_put_roundtrip(tmp_path, monkeypatch, client):
    calls: list[tuple] = []
    project = _normalized_project(tmp_path, monkeypatch, "proj-flag-roundtrip", calls)
    assert project.tracks["A"].loudness_normalized is False
    doc = client.get(f"/api/projects/{project.id}").json()
    assert client.put(f"/api/projects/{project.id}", json=doc).status_code == 200
    assert storage.load_project(project.id).tracks["A"].loudness_normalized is False


# ---------------------------------------------------------------- R5: _run_export 進捗配線


def test_run_export_maps_render_progress(tmp_path, monkeypatch):
    project = _make_project(tmp_path, monkeypatch, pid="proj-export")
    job = server._new_job("export", project.id)
    seen: list[float] = []

    def fake_export(project_arg, target, export_format="wav", progress=None, **_kwargs):
        progress("A", 0.5)
        seen.append(server._jobs[job["id"]]["progress"])
        progress("B", 0.25)
        seen.append(server._jobs[job["id"]]["progress"])
        return {"speakerA.wav": "x"}

    monkeypatch.setattr(server, "export_project", fake_export)
    server._run_export(project.id, job["id"], None, "wav")
    state = server._jobs[job["id"]]
    assert state["status"] == "complete", state["error"]
    # A=0.10..0.50 / B=0.50..0.90 の帯マッピング
    assert seen == [pytest.approx(0.3), pytest.approx(0.6)]


# ---------------------------------------------------------------- G: エクスポート先の可視化


def test_export_result_carries_output_dir_and_file_names(tmp_path, monkeypatch):
    """完了ジョブの result からフルパスと生成ファイル名が読めること（G のサーバ側）。"""
    project = _make_project(tmp_path, monkeypatch, pid="proj-outdir")
    job = server._new_job("export", project.id)

    def fake_export(project_arg, target, export_format="wav", progress=None, **_kwargs):
        Path(target).mkdir(parents=True, exist_ok=True)
        return {
            "speakerB.wav": str(Path(target) / "speakerB.wav"),
            "speakerA.wav": str(Path(target) / "speakerA.wav"),
            "transcript.srt": str(Path(target) / "transcript.srt"),
        }

    monkeypatch.setattr(server, "export_project", fake_export)
    server._run_export(project.id, job["id"], "take2", "wav")
    result = server._jobs[job["id"]]["result"]
    expected = storage.project_dir(project.id).resolve() / "exports" / "take2"
    assert result["output_dir"] == str(expected)
    assert Path(result["output_dir"]).is_absolute()
    assert result["files"] == ["speakerA.wav", "speakerB.wav", "transcript.srt"]  # 名前・安定順
    assert result["file_paths"]["speakerA.wav"].endswith("/take2/speakerA.wav")


def test_run_export_default_targets_exports_root(tmp_path, monkeypatch):
    """未指定の書き出し先は exports 直下で、latest サブフォルダを作らない（Issue #28）。"""
    project = _make_project(tmp_path, monkeypatch, pid="proj-defaultout")
    job = server._new_job("export", project.id)
    captured: dict[str, Path] = {}

    def fake_export(project_arg, target, export_format="wav", progress=None, **_kwargs):
        captured["target"] = Path(target)
        Path(target).mkdir(parents=True, exist_ok=True)
        return {}

    monkeypatch.setattr(server, "export_project", fake_export)
    server._run_export(project.id, job["id"], None, "wav")
    assert server._jobs[job["id"]]["status"] == "complete"
    exports = storage.project_dir(project.id).resolve() / "exports"
    assert captured["target"] == exports
    assert not (exports / "latest").exists()


def _fake_run(calls, *, exc=None):
    def runner(args, **kwargs):
        calls.append((args, kwargs))
        if exc is not None:
            raise exc
        return None

    return runner


def _make_export_dir(project, label=None):
    """既定（label なし）は exports 直下 = 既定の書き出し先（Issue #28）。"""
    exports = (storage.project_dir(project.id) / "exports").resolve()
    target = exports / label if label else exports
    target.mkdir(parents=True, exist_ok=True)
    (target / "speakerA.wav").write_bytes(b"RIFFfake")
    return target


def test_reveal_invokes_platform_command_with_argument_array(tmp_path, monkeypatch, client):
    """正常系: shell=False の引数配列で固定コマンドが呼ばれる（実際には open しない）。"""
    project = _make_project(tmp_path, monkeypatch)
    target = _make_export_dir(project, "take1")
    calls: list = []
    monkeypatch.setattr(server.sys, "platform", "darwin")
    monkeypatch.setattr(server.subprocess, "run", _fake_run(calls))
    res = client.post(f"/api/projects/{project.id}/reveal", json={"path": str(target)})
    assert res.status_code == 200
    assert res.json()["revealed"] == str(target)
    (args, kwargs), = calls
    assert args == ["open", str(target)]  # 文字列連結でなく配列
    assert kwargs["shell"] is False
    assert kwargs["timeout"] == server.REVEAL_TIMEOUT_S


@pytest.mark.parametrize(
    "platform,command", [("darwin", "open"), ("linux", "xdg-open"), ("win32", "explorer")]
)
def test_reveal_command_per_platform(tmp_path, monkeypatch, client, platform, command):
    project = _make_project(tmp_path, monkeypatch)
    _make_export_dir(project)
    calls: list = []
    monkeypatch.setattr(server.sys, "platform", platform)
    monkeypatch.setattr(server.subprocess, "run", _fake_run(calls))
    res = client.post(f"/api/projects/{project.id}/reveal", json={})
    assert res.status_code == 200
    assert calls[0][0][0] == command


def test_reveal_defaults_to_exports_root(tmp_path, monkeypatch, client):
    """未指定の reveal は exports 自身を開く（Issue #28: 既定の書き出し先に追随）。

    ラベル書き出しのサブフォルダが残っていても exports 自身を開く
    （既定エクスポートの成果物は exports 直下に落ちるため）。
    """
    project = _make_project(tmp_path, monkeypatch)
    exports = _make_export_dir(project)
    _make_export_dir(project, "take1")  # サブフォルダがあっても既定は exports 自身
    calls: list = []
    monkeypatch.setattr(server.sys, "platform", "darwin")
    monkeypatch.setattr(server.subprocess, "run", _fake_run(calls))
    res = client.post(f"/api/projects/{project.id}/reveal", json={})
    assert res.status_code == 200
    assert res.json()["revealed"] == str(exports)


@pytest.mark.parametrize(
    "evil",
    [
        "../../../etc",
        "/etc",
        "/etc/hosts",
        "..",
        "../project.json",
    ],
)
def test_reveal_rejects_paths_outside_exports(tmp_path, monkeypatch, client, evil):
    """トラバーサルは 400 で、subprocess は一切呼ばれない（任意GUI起動の遮断）。"""
    project = _make_project(tmp_path, monkeypatch)
    _make_export_dir(project)
    calls: list = []
    monkeypatch.setattr(server.sys, "platform", "darwin")
    monkeypatch.setattr(server.subprocess, "run", _fake_run(calls))
    res = client.post(f"/api/projects/{project.id}/reveal", json={"path": evil})
    assert res.status_code == 400
    assert calls == []


def test_reveal_allows_workdir_root_itself(tmp_path, monkeypatch, client):
    """作業フォルダそのもの（project_dir ちょうど）は exports が無くても開ける（フェーズ3）。"""
    project = _make_project(tmp_path, monkeypatch)
    root = storage.project_dir(project.id).resolve()
    calls: list = []
    monkeypatch.setattr(server.sys, "platform", "darwin")
    monkeypatch.setattr(server.subprocess, "run", _fake_run(calls))
    res = client.post(f"/api/projects/{project.id}/reveal", json={"path": str(root)})
    assert res.status_code == 200
    assert res.json()["revealed"] == str(root)
    assert calls[0][0] == ["open", str(root)]


def test_reveal_rejects_workdir_files_outside_exports(tmp_path, monkeypatch, client):
    """対照実験: 作業フォルダ配下でも exports 外の個別ファイルは引き続き 400。"""
    project = _make_project(tmp_path, monkeypatch)
    target = storage.project_dir(project.id) / "project.json"
    assert target.is_file()
    calls: list = []
    monkeypatch.setattr(server.sys, "platform", "darwin")
    monkeypatch.setattr(server.subprocess, "run", _fake_run(calls))
    res = client.post(f"/api/projects/{project.id}/reveal", json={"path": str(target)})
    assert res.status_code == 400
    assert calls == []


def test_reveal_rejects_symlink_escape(tmp_path, monkeypatch, client):
    """exports 配下のシンボリックリンク経由の脱出も 400（resolve 後に包含判定）。"""
    project = _make_project(tmp_path, monkeypatch)
    exports = _make_export_dir(project)
    outside = tmp_path / "outside"
    outside.mkdir()
    link = exports / "escape"
    link.symlink_to(outside, target_is_directory=True)
    calls: list = []
    monkeypatch.setattr(server.sys, "platform", "darwin")
    monkeypatch.setattr(server.subprocess, "run", _fake_run(calls))
    res = client.post(f"/api/projects/{project.id}/reveal", json={"path": str(link)})
    assert res.status_code == 400
    assert calls == []


def test_reveal_missing_path_is_404(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch)
    exports = _make_export_dir(project)
    calls: list = []
    monkeypatch.setattr(server.sys, "platform", "darwin")
    monkeypatch.setattr(server.subprocess, "run", _fake_run(calls))
    res = client.post(
        f"/api/projects/{project.id}/reveal", json={"path": str(exports / "nope")}
    )
    assert res.status_code == 404
    assert calls == []


def test_reveal_without_exports_dir_is_404(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch)
    calls: list = []
    monkeypatch.setattr(server.sys, "platform", "darwin")
    monkeypatch.setattr(server.subprocess, "run", _fake_run(calls))
    res = client.post(f"/api/projects/{project.id}/reveal", json={})
    assert res.status_code == 404
    assert calls == []


def test_reveal_unsupported_platform_is_501(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch)
    _make_export_dir(project)
    calls: list = []
    monkeypatch.setattr(server.sys, "platform", "freebsd14")
    monkeypatch.setattr(server.subprocess, "run", _fake_run(calls))
    res = client.post(f"/api/projects/{project.id}/reveal", json={})
    assert res.status_code == 501
    assert calls == []


def test_reveal_unknown_project_is_404(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    calls: list = []
    monkeypatch.setattr(server.sys, "platform", "darwin")
    monkeypatch.setattr(server.subprocess, "run", _fake_run(calls))
    assert client.post("/api/projects/no-such/reveal", json={}).status_code == 404
    assert calls == []


def test_reveal_rejects_non_string_path(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch)
    _make_export_dir(project)
    calls: list = []
    monkeypatch.setattr(server.sys, "platform", "darwin")
    monkeypatch.setattr(server.subprocess, "run", _fake_run(calls))
    assert client.post(f"/api/projects/{project.id}/reveal", json={"path": 42}).status_code == 400
    assert calls == []


def test_reveal_subprocess_failure_is_500(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch)
    _make_export_dir(project)
    calls: list = []
    monkeypatch.setattr(server.sys, "platform", "darwin")
    monkeypatch.setattr(
        server.subprocess, "run", _fake_run(calls, exc=FileNotFoundError("open not found"))
    )
    res = client.post(f"/api/projects/{project.id}/reveal", json={})
    assert res.status_code == 500
    assert calls  # 呼ばれた上での失敗であること


def test_run_export_timeout_becomes_job_error(tmp_path, monkeypatch):
    project = _make_project(tmp_path, monkeypatch, pid="proj-timeout")
    job = server._new_job("export", project.id)

    def fake_export(*args, **kwargs):
        raise TimeoutError("command timed out after 3600s: ffmpeg")

    monkeypatch.setattr(server, "export_project", fake_export)
    server._run_export(project.id, job["id"], None, "wav")
    state = server._jobs[job["id"]]
    assert state["status"] == "error"
    assert "timed out" in state["error"]
    assert state["finished_at"] > 0


def test_static_responses_are_no_cache(tmp_path, monkeypatch):
    # UI更新後にブラウザのヒューリスティックキャッシュが旧 index/JS/CSS を出し続けないよう、
    # "/" と "/static/*" は Cache-Control: no-cache（毎回再検証・304利用）で配る。
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    client = TestClient(server.app)
    for path in ("/", "/static/styles.css", "/static/js/main.js"):
        response = client.get(path)
        assert response.status_code == 200, path
        assert response.headers.get("cache-control") == "no-cache", path
    # API 応答にはキャッシュ制御を足さない（既存挙動維持）
    health = client.get("/api/health")
    assert health.status_code == 200
    assert "cache-control" not in {k.lower() for k in health.headers}


# ---------------------------------------------------------------- wav 取込対応（2026-08）


def _wav_bytes(seconds: float = 1.0, rate: int = 8000) -> bytes:
    """テスト用の合成 WAV（無音でない正弦波）をバイト列で返す。"""
    import io

    frames = int(seconds * rate)
    t = np.arange(frames)
    samples = (8000 * np.sin(2 * np.pi * 440 * t / rate)).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(samples.tobytes())
    return buf.getvalue()


def test_create_project_preserves_uploaded_wav_extension(tmp_path, monkeypatch, client):
    """wav をアップロードすると original_file が .wav で保存され、実ファイルが置かれること。

    以前は拡張子が speakerA.mp3 固定に倒れており、wav 素材でも mp3 名で保存されていた。
    """
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    calls: list[tuple] = []
    _stub_audio_pipeline(monkeypatch, calls)

    payload = _wav_bytes()
    res = client.post(
        "/api/projects",
        files={
            "speaker_a": ("収録A.wav", payload, "audio/wav"),
            "speaker_b": ("rec-b.WAV", payload, "audio/x-wav"),
        },
        data={"name": "wav import", "normalize": "false"},
    )
    assert res.status_code == 200, res.text
    pid = res.json()["project"]["id"]

    saved = storage.load_project(pid)
    # 実際の拡張子が尊重される（日本語部分は _ に潰れるが .wav は保たれる）
    assert saved.tracks["A"].original_file.endswith(".wav")
    assert saved.tracks["B"].original_file.endswith(".WAV")
    pdir = storage.project_dir(pid)
    assert (pdir / saved.tracks["A"].original_file).read_bytes() == payload
    assert (pdir / saved.tracks["B"].original_file).read_bytes() == payload
    # TestClient は BackgroundTasks を応答後に同期実行するので取込まで完走している
    assert saved.status == "ready"
    assert saved.blocks  # VAD ブロックが生成されている


def test_create_project_falls_back_for_unknown_extension(tmp_path, monkeypatch, client):
    """未知拡張子・拡張子なしは話者既定名（speakerX.wav）へ倒れること。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    calls: list[tuple] = []
    _stub_audio_pipeline(monkeypatch, calls)

    payload = _wav_bytes()
    res = client.post(
        "/api/projects",
        files={
            "speaker_a": ("../../evil.exe", payload, "application/octet-stream"),
            "speaker_b": ("noext", payload, "application/octet-stream"),
        },
        data={"normalize": "false"},
    )
    assert res.status_code == 200, res.text
    saved = storage.load_project(res.json()["project"]["id"])
    assert saved.tracks["A"].original_file == "speakerA.wav"
    assert saved.tracks["B"].original_file == "speakerB.wav"


def test_create_project_same_filename_splits_by_speaker_keeping_extension(
    tmp_path, monkeypatch, client
):
    """同名を2スロットに入れても上書きせず、拡張子を保ったまま話者名で分けること。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    calls: list[tuple] = []
    _stub_audio_pipeline(monkeypatch, calls)

    payload = _wav_bytes()
    res = client.post(
        "/api/projects",
        files={
            "speaker_a": ("same.wav", payload, "audio/wav"),
            "speaker_b": ("same.wav", payload, "audio/wav"),
        },
        data={"normalize": "false"},
    )
    assert res.status_code == 200, res.text
    saved = storage.load_project(res.json()["project"]["id"])
    assert saved.tracks["A"].original_file == "speakerA.wav"
    assert saved.tracks["B"].original_file == "speakerB.wav"


@requires_ffmpeg
def test_import_real_wav_runs_full_pipeline_and_builds_blocks(tmp_path, monkeypatch, client):
    """実 ffmpeg で合成 wav を取り込み、ブロックが生成されるまで完走すること。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    # VAD だけは合成音の性質に依存しないよう固定（ffmpeg 経路の検証が目的）
    monkeypatch.setattr(
        server, "detect_speech_intervals", lambda path, aggressiveness=2: [(0.0, 1.0)]
    )
    payload = _wav_bytes(seconds=2.0, rate=48000)
    res = client.post(
        "/api/projects",
        files={
            "speaker_a": ("a.wav", payload, "audio/wav"),
            "speaker_b": ("b.wav", payload, "audio/wav"),
        },
        data={"normalize": "false"},  # loudnorm 3パスは重いので形式変換のみ
    )
    assert res.status_code == 200, res.text
    pid = res.json()["project"]["id"]
    job_id = res.json()["job"]["id"]

    assert server._jobs[job_id]["status"] == "complete", server._jobs[job_id]["error"]
    saved = storage.load_project(pid)
    assert saved.status == "ready"
    assert saved.blocks  # wav からブロックが生成される
    for speaker in ("A", "B"):
        track = saved.tracks[speaker]
        assert track.original_file == f"{speaker.lower()}.wav"
        normalized = storage.project_dir(pid) / track.normalized_wav
        assert normalized.is_file() and normalized.stat().st_size > 0
        assert (storage.project_dir(pid) / f"speaker{speaker}_peaks.u8").is_file()


# ---------------------------------------------------- クロスチェック回帰（2026-08-04）


def test_upload_named_like_derived_artifact_falls_back(tmp_path, monkeypatch):
    """派生物と同名のアップロードは既定名へ倒す。

    回帰: speakerA_normalized.wav をアップロードすると original_file と ffmpeg の
    出力先が同一パスになり、in-place 編集拒否で取込も後がけ正規化も永久に失敗した。
    """
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    for speaker in ("A", "B"):
        reserved = f"speaker{speaker}_normalized.wav"
        assert reserved in server.RESERVED_UPLOAD_NAMES
        assert server._safe_audio_name(reserved, server.DEFAULT_UPLOAD_NAME[speaker]) == (
            server.DEFAULT_UPLOAD_NAME[speaker]
        )
    # 通常の音声名は従来どおり保持される（過剰な巻き込みが無いこと）
    assert server._safe_audio_name("myvoice.wav", "speakerA.wav") == "myvoice.wav"
    assert server._safe_audio_name("speakerA_raw.wav", "speakerA.wav") == "speakerA_raw.wav"


def test_reveal_default_branch_rejects_symlink_escape(tmp_path, monkeypatch, client):
    """path 省略時の既定分岐もシンボリックリンク脱出を弾く。

    回帰: 明示指定の分岐だけが包含判定を持ち、既定分岐は iterdir/is_dir が
    リンクを辿るため exports 外のディレクトリをそのまま開いていた。
    """
    project = _make_project(tmp_path, monkeypatch, pid="revealdef")
    exports = storage.project_dir(project.id) / "exports"
    exports.mkdir(parents=True, exist_ok=True)
    outside = tmp_path / "outside_secrets"
    outside.mkdir()
    (exports / "escape").symlink_to(outside, target_is_directory=True)

    calls: list[list[str]] = []
    monkeypatch.setattr(
        server.subprocess, "run", lambda args, **kw: calls.append(list(args)) or None
    )
    response = client.post(f"/api/projects/{project.id}/reveal", json={})
    # exports 配下に「開ける実体」が無いので exports 自身へ落ちる（外部は開かない）
    if response.status_code == 200:
        revealed = Path(response.json()["revealed"]).resolve()
        assert revealed == exports.resolve()
        assert all(outside.resolve() != Path(c[-1]).resolve() for c in calls)
    else:
        assert response.status_code in (400, 404)
        assert not calls


def test_reveal_allows_configured_export_dir(tmp_path, monkeypatch, client):
    """SEAM_EXPORT_DIR 配下も「Finderで開く」の対象にする。

    回帰: Issue #18 で書き出し先に SEAM_EXPORT_DIR が加わったのに reveal 側の
    許可ベースが exports 配下のままで、EXPORT_DIR へ書き出した直後に開こうとすると
    400「path escapes...」になった（実機で発生）。書き出せる場所は必ず開けること。
    """
    project = _make_project(tmp_path, monkeypatch)
    export_base = tmp_path / "Podcast" / "exports"
    target = export_base / "ep1"
    target.mkdir(parents=True)
    (target / "speakerA.wav").write_bytes(b"RIFFfake")
    monkeypatch.setenv("SEAM_EXPORT_DIR", str(export_base))
    calls: list = []
    monkeypatch.setattr(server.sys, "platform", "darwin")
    monkeypatch.setattr(server.subprocess, "run", _fake_run(calls))

    res = client.post(f"/api/projects/{project.id}/reveal", json={"path": str(target)})
    assert res.status_code == 200, res.text
    assert res.json()["revealed"] == str(target.resolve())
    (args, _kwargs), = calls
    assert args == ["open", str(target.resolve())]


def test_reveal_still_rejects_outside_allowed_bases(tmp_path, monkeypatch, client):
    """許可ベース（exports / EXPORT_DIR）のどちらでもない場所は従来どおり 400。"""
    project = _make_project(tmp_path, monkeypatch)
    export_base = tmp_path / "Podcast" / "exports"
    export_base.mkdir(parents=True)
    monkeypatch.setenv("SEAM_EXPORT_DIR", str(export_base))
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    calls: list = []
    monkeypatch.setattr(server.sys, "platform", "darwin")
    monkeypatch.setattr(server.subprocess, "run", _fake_run(calls))

    res = client.post(f"/api/projects/{project.id}/reveal", json={"path": str(outside)})
    assert res.status_code == 400
    assert not calls  # コマンドは呼ばれない


# ---------------------------------------------------------------- Issue #37: ラウドネス詳細設定（true_peak / tolerance）


def _capture_loudnorm_kwargs(monkeypatch, captured):
    """normalize_loudnorm への受け値（kwargs）を丸ごと記録するスタブ一式。"""

    def fake_normalize(original, normalized, **kwargs):
        kwargs.pop("progress", None)
        captured.append(kwargs)
        Path(normalized).write_bytes(b"normalized-wav")
        return {
            "target_i": kwargs.get("target_i"),
            "input": {"input_i": -30.0},
            "normalized": {"input_i": kwargs.get("target_i")},
            "loudness_normalized": True,
        }

    monkeypatch.setattr(server, "normalize_loudnorm", fake_normalize)
    monkeypatch.setattr(server, "ffprobe_duration", lambda path: 60.0)
    monkeypatch.setattr(
        server, "detect_speech_intervals", lambda path, aggressiveness=2: [(0.0, 1.0)]
    )
    monkeypatch.setattr(
        server, "generate_peak_bins", lambda path, bins_per_sec=200: b"PPK1" + b"\x00" * 12
    )


def test_create_project_pipes_true_peak_and_tolerance_to_audio(
    tmp_path, monkeypatch, client
):
    """取込経路: Form の true_peak/tolerance が settings に永続化され audio 層まで届く。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    captured: list[dict] = []
    _capture_loudnorm_kwargs(monkeypatch, captured)

    payload = _wav_bytes()
    res = client.post(
        "/api/projects",
        files={
            "speaker_a": ("a.wav", payload, "audio/wav"),
            "speaker_b": ("b.wav", payload, "audio/wav"),
        },
        data={"target_lufs": "-16", "true_peak": "-2.0", "tolerance": "1.0"},
    )
    assert res.status_code == 200, res.text
    saved = storage.load_project(res.json()["project"]["id"])
    assert saved.settings["true_peak"] == -2.0
    assert saved.settings["tolerance"] == 1.0
    assert len(captured) == 2  # A/B 両話者
    for kwargs in captured:
        assert kwargs["true_peak"] == -2.0
        assert kwargs["tolerance"] == 1.0


def test_create_project_defaults_keep_current_behavior(tmp_path, monkeypatch, client):
    """フィールド未送信時の既定: true_peak=-1.5（現行固定値）/ tolerance=0.5。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    captured: list[dict] = []
    _capture_loudnorm_kwargs(monkeypatch, captured)

    payload = _wav_bytes()
    res = client.post(
        "/api/projects",
        files={
            "speaker_a": ("a.wav", payload, "audio/wav"),
            "speaker_b": ("b.wav", payload, "audio/wav"),
        },
    )
    assert res.status_code == 200, res.text
    saved = storage.load_project(res.json()["project"]["id"])
    assert saved.settings["true_peak"] == -1.5
    assert saved.settings["tolerance"] == 0.5
    assert captured and all(k["true_peak"] == -1.5 for k in captured)
    assert all(k["tolerance"] == 0.5 for k in captured)


@pytest.mark.parametrize(
    "data",
    [
        {"true_peak": "-9.1"},   # loudnorm TP 下限（-9）超過
        {"true_peak": "0.5"},    # 上限（0）超過
        {"tolerance": "-0.1"},   # 負の許容量
    ],
)
def test_create_project_rejects_out_of_range_loudnorm_options(
    tmp_path, monkeypatch, client, data
):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    captured: list[dict] = []
    _capture_loudnorm_kwargs(monkeypatch, captured)

    payload = _wav_bytes()
    res = client.post(
        "/api/projects",
        files={
            "speaker_a": ("a.wav", payload, "audio/wav"),
            "speaker_b": ("b.wav", payload, "audio/wav"),
        },
        data=data,
    )
    assert res.status_code == 400, res.text
    assert not captured  # 取込ジョブは開始されない


@pytest.mark.parametrize("value", ["nan", "inf"])
def test_create_project_rejects_non_finite_tolerance(tmp_path, monkeypatch, client, value):
    """nan/inf は 400（本実装の範囲チェック）または 422（Form の型検証）で必ず弾く。

    どちらの層で止まるかはフレームワークのパース仕様に依存するため固定しない。
    inf を settings（JSON）に永続化させないことが目的。
    """
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    captured: list[dict] = []
    _capture_loudnorm_kwargs(monkeypatch, captured)

    payload = _wav_bytes()
    res = client.post(
        "/api/projects",
        files={
            "speaker_a": ("a.wav", payload, "audio/wav"),
            "speaker_b": ("b.wav", payload, "audio/wav"),
        },
        data={"tolerance": value},
    )
    assert res.status_code in (400, 422), res.text
    assert not captured


def test_create_project_true_peak_boundaries_are_accepted(tmp_path, monkeypatch, client):
    """境界値 -9 / 0 は受け付ける（loudnorm の受付範囲そのもの）。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    captured: list[dict] = []
    _capture_loudnorm_kwargs(monkeypatch, captured)
    payload = _wav_bytes()
    for value in ("-9", "0"):
        res = client.post(
            "/api/projects",
            files={
                "speaker_a": ("a.wav", payload, "audio/wav"),
                "speaker_b": ("b.wav", payload, "audio/wav"),
            },
            data={"true_peak": value},
        )
        assert res.status_code == 200, res.text


def test_normalize_endpoint_pipes_true_peak_and_tolerance(tmp_path, monkeypatch, client):
    """後がけ経路: payload の true_peak/tolerance が settings 更新 + audio 層まで届く。"""
    calls: list[tuple] = []
    project = _normalized_project(tmp_path, monkeypatch, "proj-norm-tp", calls)
    captured: list[dict] = []
    _capture_loudnorm_kwargs(monkeypatch, captured)

    res = client.post(
        f"/api/projects/{project.id}/normalize",
        json={"speakers": ["A"], "true_peak": -2.0, "tolerance": 1.0},
    )
    assert res.status_code == 200, res.text
    assert server._jobs[res.json()["job"]["id"]]["status"] == "complete"
    assert len(captured) == 1
    assert captured[0]["true_peak"] == -2.0
    assert captured[0]["tolerance"] == 1.0
    saved = storage.load_project(project.id)
    assert saved.settings["true_peak"] == -2.0
    assert saved.settings["tolerance"] == 1.0


@pytest.mark.parametrize(
    "payload",
    [
        {"true_peak": -9.1},
        {"true_peak": 0.5},
        {"tolerance": -0.1},
    ],
)
def test_normalize_endpoint_rejects_out_of_range_options(
    tmp_path, monkeypatch, client, payload
):
    calls: list[tuple] = []
    project = _normalized_project(tmp_path, monkeypatch, "proj-norm-range", calls)
    res = client.post(f"/api/projects/{project.id}/normalize", json=payload)
    assert res.status_code == 400
    assert not calls  # ジョブを開始せずに弾く


@pytest.mark.parametrize(
    "key,bad_value",
    [
        ("true_peak", -20.0),
        ("tolerance", float("inf")),
        # 文字列等の非数値は from_dict の coerce_settings 側で扱いが決まるため
        # ここでは扱わない（本テストの対象は「数値だが範囲外/非有限」の永続値）
    ],
)
def test_normalize_endpoint_rejects_broken_persisted_settings(
    tmp_path, monkeypatch, client, key, bad_value
):
    """QA #43 指摘: PUT 経由で永続化された settings は範囲検証を通っていない。
    overrides の無い実行でも**実効値**（settings まで遡る）で検証して 400 で断ち、
    壊れた保存値（tolerance=inf → 全計測サイレントスキップ等）を使わせない。"""
    calls: list[tuple] = []
    project = _normalized_project(tmp_path, monkeypatch, f"proj-norm-persist-{key}", calls)
    project.settings[key] = bad_value  # coerce_settings を素通りした壊れ値を再現
    storage.save_project(project)
    res = client.post(f"/api/projects/{project.id}/normalize", json={})
    assert res.status_code == 400
    assert "リセット" in res.json()["detail"]  # 復旧導線を案内する
    assert not calls  # ジョブを開始せずに弾く


def test_normalize_endpoint_overrides_can_rescue_broken_persisted_settings(
    tmp_path, monkeypatch, client
):
    """壊れた保存値があっても、有効な overrides を明示すれば実行できる（実効値検証）。"""
    calls: list[tuple] = []
    project = _normalized_project(tmp_path, monkeypatch, "proj-norm-rescue", calls)
    project.settings["true_peak"] = -20.0
    storage.save_project(project)
    res = client.post(
        f"/api/projects/{project.id}/normalize",
        json={"speakers": ["A"], "true_peak": -2.0},
    )
    assert res.status_code == 200, res.text


def test_run_normalize_records_skip_marker_in_track_loudness(tmp_path, monkeypatch):
    """スキップ発生時: audio 層の normalization_skipped が track.loudness に永続化される。"""
    calls: list[tuple] = []
    project = _normalized_project(tmp_path, monkeypatch, "proj-norm-skiprec", calls)

    def fake_normalize(original, normalized, **kwargs):
        Path(normalized).write_bytes(b"converted-wav")
        return {
            "target_i": kwargs.get("target_i"),
            "input": {"input_i": "-16.30"},
            "normalized": None,
            "loudness_normalized": True,
            "normalization_skipped": True,
        }

    monkeypatch.setattr(server, "normalize_loudnorm", fake_normalize)
    job = server._new_job("normalize", project.id)
    server._run_normalize(project.id, job["id"], ["A"], True, {"tolerance": 0.5})

    assert server._jobs[job["id"]]["status"] == "complete"
    saved = storage.load_project(project.id)
    track = saved.tracks["A"]
    assert track.loudness_normalized is True  # 目標±許容量以内 = 正規化済み扱い
    assert track.loudness["normalization_skipped"] is True
    assert track.loudness["input"]["input_i"] == "-16.30"  # 計測値ごと記録
