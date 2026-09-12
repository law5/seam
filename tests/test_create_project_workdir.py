"""POST /api/projects の workdir 指定（作業フォルダの可変化・フェーズ2-2）のテスト。

ここで固定するのは主に4つ:

- workdir 指定時: project.json と音源が指定フォルダ直下に置かれ、レジストリに登録される
- 拒否時（不正パス・重複・data_dir 配下）: 400 + レジストリ未登録 + フォルダ無傷
- 登録後の失敗（413 等）でダングリングエントリを残さない
- workdir 未指定: 従来配置のまま（回帰確認）
"""

from __future__ import annotations

import io
import struct
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_prep import registry, server
from podcast_prep.config import data_dir


@pytest.fixture
def client():
    return TestClient(server.app)


@pytest.fixture(autouse=True)
def _tmp_data(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_PREP_DATA_DIR", str(tmp_path / "data"))


@pytest.fixture(autouse=True)
def _stub_import(monkeypatch):
    """ffmpeg 依存の取込ジョブを止める。テストが見るのは配置とレジストリだけ。"""
    calls: list[str] = []
    monkeypatch.setattr(
        server, "_run_import", lambda pid, jid, normalize=True: calls.append(pid)
    )
    return calls


def _wav_bytes(seconds: float = 0.1, rate: int = 8000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(struct.pack("<h", 1000) * int(seconds * rate))
    return buf.getvalue()


def _post_project(client, workdir=None, name="EP31"):
    data = {"name": name}
    if workdir is not None:
        data["workdir"] = workdir
    return client.post(
        "/api/projects",
        data=data,
        files={
            "speaker_a": ("a.wav", _wav_bytes(), "audio/wav"),
            "speaker_b": ("b.wav", _wav_bytes(), "audio/wav"),
        },
    )


# ---------------------------------------------------------------- workdir 指定あり


def test_create_with_workdir_places_files_and_registers(client, tmp_path):
    wd = tmp_path / "Podcast" / "EP31"
    wd.mkdir(parents=True)

    res = _post_project(client, workdir=str(wd))

    assert res.status_code == 200
    pid = res.json()["project"]["id"]
    # 実体は指定フォルダ直下、従来配置には何も作られない
    assert (wd / "project.json").is_file()
    assert (wd / "a.wav").is_file()
    assert (wd / "b.wav").is_file()
    assert not (data_dir() / "projects" / pid).exists()
    # レジストリ登録（root は resolve 済み・選択経路が記録される）
    entry = registry.entry_for(pid)
    assert entry is not None
    assert Path(entry["root"]) == wd.resolve()
    assert entry["root_chosen_via"] == "api"
    assert entry["name"] == "EP31"


def test_invalid_workdir_is_400_and_writes_nothing(client, tmp_path):
    missing = tmp_path / "not-created-yet"

    res = _post_project(client, workdir=str(missing))

    assert res.status_code == 400
    assert "見つかりません" in res.json()["detail"]
    assert registry.all_entries() == {}
    assert not missing.exists()  # 勝手に作らない
    # 従来配置側にも何も落ちていない
    projects = data_dir() / "projects"
    assert not projects.exists() or list(projects.iterdir()) == []


def test_same_workdir_twice_is_400_and_first_project_untouched(client, tmp_path):
    wd = tmp_path / "shared"
    wd.mkdir()
    first = _post_project(client, workdir=str(wd), name="first")
    assert first.status_code == 200
    first_id = first.json()["project"]["id"]
    before = (wd / "project.json").read_bytes()

    second = _post_project(client, workdir=str(wd), name="second")

    assert second.status_code == 400
    assert "既に別のプロジェクト" in second.json()["detail"]
    # 先客のプロジェクトが無傷で、レジストリも先客のまま
    assert (wd / "project.json").read_bytes() == before
    entries = registry.all_entries()
    assert list(entries) == [first_id]


def test_workdir_inside_data_dir_is_400(client):
    inside = data_dir() / "inside"
    inside.mkdir(parents=True)

    res = _post_project(client, workdir=str(inside))

    assert res.status_code == 400
    assert "データフォルダ" in res.json()["detail"]
    assert registry.all_entries() == {}


def test_data_dir_itself_is_400(client):
    data_dir().mkdir(parents=True, exist_ok=True)
    res = _post_project(client, workdir=str(data_dir()))
    assert res.status_code == 400
    assert "データフォルダ" in res.json()["detail"]


# ---------------------------------------------------------------- payload の workdir（フェーズ3）


def test_payload_includes_workdir_when_registered(client, tmp_path):
    """レジストリ登録ありの応答は workdir に指定フォルダの実パスを載せる。"""
    wd = tmp_path / "EP31"
    wd.mkdir()

    res = _post_project(client, workdir=str(wd))

    assert res.status_code == 200
    assert res.json()["project"]["workdir"] == str(wd.resolve())
    # GET /api/projects/{id} でも同じ（設定パネルの常時表示が読む値）
    pid = res.json()["project"]["id"]
    assert client.get(f"/api/projects/{pid}").json()["workdir"] == str(wd.resolve())


def test_payload_includes_workdir_for_legacy_layout(client):
    """レジストリ未登録でも従来配置の実パスが載る（UIは常に表示できる）。"""
    res = _post_project(client)

    assert res.status_code == 200
    pid = res.json()["project"]["id"]
    expected = str(data_dir() / "projects" / pid)
    assert res.json()["project"]["workdir"] == expected


# ---------------------------------------------------------------- reveal の作業フォルダ許可（フェーズ3）


def _fake_reveal(monkeypatch, calls):
    monkeypatch.setattr(server.sys, "platform", "darwin")
    monkeypatch.setattr(
        server.subprocess, "run", lambda args, **kwargs: calls.append(args)
    )


def test_reveal_opens_registered_workdir_root(client, tmp_path, monkeypatch):
    """作業フォルダ**そのもの**は「Finderで開く」で開ける。"""
    wd = tmp_path / "wd-reveal"
    wd.mkdir()
    res = _post_project(client, workdir=str(wd))
    assert res.status_code == 200
    pid = res.json()["project"]["id"]
    calls: list = []
    _fake_reveal(monkeypatch, calls)

    r = client.post(f"/api/projects/{pid}/reveal", json={"path": str(wd)})

    assert r.status_code == 200, r.text
    assert r.json()["revealed"] == str(wd.resolve())
    assert calls == [["open", str(wd.resolve())]]


def test_reveal_still_rejects_outside_and_inside_files(client, tmp_path, monkeypatch):
    """対照実験: 作業フォルダの親も、配下の非 exports ファイルも引き続き 400。

    ちょうど root だけの開放で、配下の個別ファイル（project.json 等）まで
    GUI 起動対象を広げない。
    """
    wd = tmp_path / "wd-guard"
    wd.mkdir()
    res = _post_project(client, workdir=str(wd))
    assert res.status_code == 200
    pid = res.json()["project"]["id"]
    calls: list = []
    _fake_reveal(monkeypatch, calls)

    assert (
        client.post(f"/api/projects/{pid}/reveal", json={"path": str(tmp_path)}).status_code
        == 400
    )
    assert (
        client.post(
            f"/api/projects/{pid}/reveal", json={"path": str(wd / "project.json")}
        ).status_code
        == 400
    )
    assert calls == []


# ---------------------------------------------------------------- 失敗時のクリーンアップ


def test_upload_failure_unregisters_dangling_entry(client, tmp_path, monkeypatch):
    """登録後の 413 でエントリを残さない。

    残すと以後の同フォルダ指定が重複扱いで永久に弾かれる（本テストの後段が
    その回復確認 = 対照実験を兼ねる）。
    """
    wd = tmp_path / "wd413"
    wd.mkdir()
    monkeypatch.setattr(server, "MAX_UPLOAD_BYTES", 16)

    res = _post_project(client, workdir=str(wd))

    assert res.status_code == 413
    assert registry.all_entries() == {}
    # 同じフォルダをやり直せる（ダングリングが残っていれば 400 になるはず）
    monkeypatch.setattr(server, "MAX_UPLOAD_BYTES", 2 * 1024 * 1024 * 1024)
    assert _post_project(client, workdir=str(wd)).status_code == 200


# ---------------------------------------------------------------- 既存ファイルの保護（ステージング取込）


def test_upload_never_overwrites_existing_file_in_workdir(client, tmp_path):
    """素材フォルダ自体を作業フォルダに選び、その中の音声と同名でアップロード
    しても、既存ファイルを上書きせず別名（speakerX{suffix}）へ着地する。

    修正前は dest.open("wb") が既存の元音源を truncate していた（QA Critical）。
    """
    wd = tmp_path / "sozai"
    wd.mkdir()
    original = b"ORIGINAL-MASTER-AUDIO"
    (wd / "a.wav").write_bytes(original)

    res = _post_project(client, workdir=str(wd))

    assert res.status_code == 200
    # ユーザーの元音源は1バイトも変わらない
    assert (wd / "a.wav").read_bytes() == original
    # アップロードは別名へ（優先順①: speakerA{suffix}）
    tracks = res.json()["project"]["tracks"]
    assert tracks["A"]["original_file"] == "speakerA.wav"
    assert (wd / "speakerA.wav").is_file()
    assert (wd / "speakerA.wav").read_bytes() != original
    # 衝突していない側は従来どおりアップロード名のまま
    assert tracks["B"]["original_file"] == "b.wav"


def test_upload_collision_falls_back_to_numbered_name(client, tmp_path):
    """speakerA{suffix} まで埋まっていたら speakerA-{n}{suffix} の最初の空きへ。"""
    wd = tmp_path / "sozai"
    wd.mkdir()
    for name in ("a.wav", "speakerA.wav", "speakerA-1.wav"):
        (wd / name).write_bytes(b"KEEP-" + name.encode())

    res = _post_project(client, workdir=str(wd))

    assert res.status_code == 200
    assert res.json()["project"]["tracks"]["A"]["original_file"] == "speakerA-2.wav"
    for name in ("a.wav", "speakerA.wav", "speakerA-1.wav"):
        assert (wd / name).read_bytes() == b"KEEP-" + name.encode()


def test_partial_413_leaves_workdir_untouched(client, tmp_path, monkeypatch):
    """片方が 413 で失敗したら、既存ファイル無傷・最終名なし・.part 残骸なし。

    最終名への配置（os.replace）は両方のステージ成功後なので、A が成功して
    いても B の 413 でフォルダは取込前の状態に戻る。
    """
    wd = tmp_path / "sozai"
    wd.mkdir()
    original = b"ORIGINAL-MASTER-AUDIO"
    (wd / "a.wav").write_bytes(original)
    monkeypatch.setattr(server, "MAX_UPLOAD_BYTES", 4096)

    res = client.post(
        "/api/projects",
        data={"name": "EP31", "workdir": str(wd)},
        files={
            "speaker_a": ("a.wav", _wav_bytes(), "audio/wav"),  # 4096 未満
            "speaker_b": ("b.wav", _wav_bytes(seconds=10.0), "audio/wav"),  # 超過
        },
    )

    assert res.status_code == 413
    assert (wd / "a.wav").read_bytes() == original
    assert sorted(p.name for p in wd.iterdir()) == ["a.wav"]  # .part も最終名も無い
    assert registry.all_entries() == {}


def test_workdir_with_existing_project_json_is_400(client, tmp_path):
    """既存プロジェクトのフォルダを新規取込先にすると project.json を
    上書きしてしまうため、復元へ誘導して断る。"""
    wd = tmp_path / "existing-project"
    wd.mkdir()
    doc = b'{"id": "someone-else"}'
    (wd / "project.json").write_bytes(doc)

    res = _post_project(client, workdir=str(wd))

    assert res.status_code == 400
    assert "復元で開いてください" in res.json()["detail"]
    assert (wd / "project.json").read_bytes() == doc
    assert sorted(p.name for p in wd.iterdir()) == ["project.json"]
    assert registry.all_entries() == {}


@pytest.mark.parametrize(
    "artifact", ["speakerA_normalized.wav", "speakerB_peaks.u8"]
)
def test_workdir_with_existing_artifact_name_is_400(client, tmp_path, artifact):
    """取込パイプラインが固定名で書く派生物（RESERVED_ARTIFACT_NAMES）と同名の
    既存ファイルがあるフォルダは、上書きで壊す前に 400 で断る。"""
    wd = tmp_path / "has-artifact"
    wd.mkdir()
    original = b"user's precious bytes"
    (wd / artifact).write_bytes(original)

    res = _post_project(client, workdir=str(wd))

    assert res.status_code == 400
    assert artifact in res.json()["detail"]
    assert "別のフォルダ" in res.json()["detail"]
    # フォルダは無傷（既存ファイルの中身も、余計な新規ファイルも無い）
    assert (wd / artifact).read_bytes() == original
    assert sorted(p.name for p in wd.iterdir()) == [artifact]
    assert registry.all_entries() == {}


def test_reserved_artifact_names_cover_all_fixed_name_outputs():
    """定数が実装から漏れないことの回帰チェック（正規化WAV + ピークサイドカー）。"""
    assert server.RESERVED_ARTIFACT_NAMES == {
        "speakerA_normalized.wav",
        "speakerB_normalized.wav",
        "speakerA_peaks.u8",
        "speakerB_peaks.u8",
    }
    assert server.RESERVED_UPLOAD_NAMES <= server.RESERVED_ARTIFACT_NAMES


def test_corrupted_registry_is_500_and_writes_nothing(client, tmp_path):
    """レジストリ全体が破損していたら登録を拒否して 500（上書きしない）。"""
    reg_path = data_dir() / registry.REGISTRY_FILENAME
    reg_path.parent.mkdir(parents=True, exist_ok=True)
    reg_path.write_text("{ not json", encoding="utf-8")
    registry.reset_cache()
    wd = tmp_path / "wd"
    wd.mkdir()

    res = _post_project(client, workdir=str(wd))

    assert res.status_code == 500
    assert "破損" in res.json()["detail"]
    assert reg_path.read_text(encoding="utf-8") == "{ not json"
    assert list(wd.iterdir()) == []  # 登録前に止まるのでフォルダにも書かない


# ---------------------------------------------------------------- workdir 未指定（回帰）


def test_create_without_workdir_uses_legacy_layout(client):
    res = _post_project(client)

    assert res.status_code == 200
    pid = res.json()["project"]["id"]
    legacy = data_dir() / "projects" / pid
    assert (legacy / "project.json").is_file()
    assert (legacy / "a.wav").is_file()
    assert registry.all_entries() == {}  # レジストリには一切触れない


# ---------------------------------------------------------------- 既定パスの表示用 API


def test_system_paths_returns_default_projects_root(client):
    """GET /api/system/paths が既定の作業フォルダ配置先を返す（取込オーバーレイの表示用）。"""
    res = client.get("/api/system/paths")
    assert res.status_code == 200
    assert res.json() == {"default_projects_root": str(data_dir() / "projects")}
