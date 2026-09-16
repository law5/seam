"""POST /api/projects/open が開いたフォルダを作業フォルダとして直接使う（フェーズ4）。

ここで固定するのは主に5つ:

- 通常ケース: フォルダ内の音源をコピーしない（223MB×2 の複製廃止）+ レジストリ登録
- 再入場: 同じフォルダを2回開いても同じ id（再採番しない）でエントリは1つのまま
- id 衝突: 採番し直してフォルダ内 project.json を新 id で書き戻す（次回は逆引きで同 id）
- 入口の拒否: クラウド同期フォルダ 400 / data_dir 配下 400 / レジストリと
  project.json の食い違い 409 — いずれも1バイトも書かず、レジストリにも登録しない
- レガシー再オープン: 従来配置のフォルダ自身は登録せず・無コピーでそのまま開く
"""

from __future__ import annotations

import json
import struct
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_prep import registry, server, storage, workdir
from podcast_prep.config import data_dir
from podcast_prep.models import Block, ProjectState


@pytest.fixture
def client():
    return TestClient(server.app)


@pytest.fixture(autouse=True)
def _tmp_data(tmp_path, monkeypatch):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))


def _write_wav(path: Path, seconds: float = 0.2, rate: int = 8000) -> None:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(struct.pack("<h", 4096) * int(seconds * rate))


def _folder_doc(pid: str, name: str = "folder open") -> dict:
    return {
        "id": pid,
        "name": name,
        "tracks": {
            sp: {
                "speaker": sp,
                "original_file": "",
                "normalized_wav": f"speaker{sp}_normalized.wav",
            }
            for sp in ("A", "B")
        },
        "blocks": [],
        "transcripts": [],
        "overlaps": [],
    }


def _make_open_folder(base: Path, pid: str, name: str = "folder open") -> Path:
    """project.json と音源が揃った「フォルダから開く」対象を作る。"""
    folder = base / pid
    folder.mkdir(parents=True)
    for sp in ("A", "B"):
        _write_wav(folder / f"speaker{sp}_normalized.wav")
    (folder / "project.json").write_text(
        json.dumps(_folder_doc(pid, name)), encoding="utf-8"
    )
    return folder


def _make_legacy_project(pid: str) -> ProjectState:
    """従来配置（data_dir/projects/{id}）に音源つきプロジェクトを作る。"""
    project = ProjectState.new(pid, f"legacy {pid}")
    project.status = "ready"
    pdir = storage.project_dir(pid, create=True)
    for sp in ("A", "B"):
        name = f"speaker{sp}_normalized.wav"
        _write_wav(pdir / name)
        project.tracks[sp].normalized_wav = name
    storage.save_project(project)
    return project


def _open(client, folder: Path):
    return client.post("/api/projects/open", data={"source_dir": str(folder)})


def _snapshot(folder: Path) -> dict[str, int]:
    """ファイル名 → inode。コピー・差し替えの有無を実体で検証する。"""
    return {p.name: p.stat().st_ino for p in folder.iterdir() if p.is_file()}


# ---------------------------------------------------------------- 通常ケース: 無コピー


def test_open_folder_uses_it_as_workdir_without_copy(client, tmp_path):
    folder = _make_open_folder(tmp_path, "ep31")
    before = _snapshot(folder)

    res = _open(client, folder)

    assert res.status_code == 200, res.text
    payload = res.json()["project"]
    assert payload["id"] == "ep31"
    # project_dir がフォルダ自身を指し、参照はフォルダ内相対のまま
    assert storage.project_dir("ep31") == folder.resolve()
    for sp in ("A", "B"):
        assert payload["tracks"][sp]["normalized_wav"] == f"speaker{sp}_normalized.wav"
    # コピーが1つも発生していない: ファイル集合は不変、音源の実体（inode）も同一。
    # project.json だけは save_project が書き戻す（status/updated_at）ので除外
    after = _snapshot(folder)
    assert set(after) == set(before)
    for name in before:
        if name != "project.json":
            assert after[name] == before[name], f"{name} が差し替わった"
    # 従来配置には何も作られない
    assert not (data_dir() / "projects" / "ep31").exists()
    # レジストリ登録（選択経路が記録される）
    entry = registry.entry_for("ep31")
    assert entry is not None
    assert Path(entry["root"]) == folder.resolve()
    assert entry["root_chosen_via"] == "open"
    assert entry["name"] == "folder open"


def test_open_same_folder_twice_reuses_id(client, tmp_path):
    """再入場: 再採番されず、レジストリのエントリも1つのまま。"""
    folder = _make_open_folder(tmp_path, "ep32")

    first = _open(client, folder)
    second = _open(client, folder)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["project"]["id"] == "ep32"
    assert second.json()["project"]["id"] == "ep32"
    assert second.json()["project"].get("adopted_as_new_project") is None
    entries = registry.all_entries()
    assert list(entries) == ["ep32"]
    # 再入場は last_opened_at を明示更新する（project_dir は純関数のまま）
    assert entries["ep32"].get("last_opened_at")


# ---------------------------------------------------------------- フォルダ外参照は引き込む


def test_absolute_reference_outside_folder_is_copied_in(client, tmp_path):
    """フォルダ外（許可ベース = 衝突元プロジェクト配下）の絶対参照は従来どおり
    コピーで引き込み、フォルダの自己完結性を保つ。"""
    legacy = _make_legacy_project("collide1")
    legacy_dir = storage.project_dir("collide1")
    folder = tmp_path / "incoming"
    folder.mkdir()
    doc = _folder_doc("collide1", name="incoming")
    for sp in ("A", "B"):
        # フォルダ内には音源が無く、旧プロジェクト配下を絶対参照している
        doc["tracks"][sp]["normalized_wav"] = str(
            legacy_dir / f"speaker{sp}_normalized.wav"
        )
    (folder / "project.json").write_text(json.dumps(doc), encoding="utf-8")

    res = _open(client, folder)

    assert res.status_code == 200, res.text
    payload = res.json()["project"]
    new_id = payload["id"]
    assert new_id != "collide1"  # id 衝突なので採番し直し
    assert storage.project_dir(new_id) == folder.resolve()
    for sp in ("A", "B"):
        # 固定名でフォルダへコピーされ、参照も相対になる
        assert payload["tracks"][sp]["normalized_wav"] == f"speaker{sp}_normalized.wav"
        assert (folder / f"speaker{sp}_normalized.wav").is_file()
    # 旧プロジェクトは無傷
    assert (legacy_dir / "speakerA_normalized.wav").is_file()
    assert storage.load_project("collide1").id == legacy.id


# ---------------------------------------------------------------- 入口の拒否


def test_open_cloud_synced_folder_is_rejected_and_writes_nothing(
    client, tmp_path, monkeypatch
):
    cloud_root = tmp_path / "CloudStorage"
    monkeypatch.setattr(workdir, "_cloud_roots", lambda: [cloud_root])
    folder = _make_open_folder(cloud_root, "epcloud")
    before_json = (folder / "project.json").read_bytes()
    before = _snapshot(folder)

    res = _open(client, folder)

    assert res.status_code == 400
    assert "クラウド同期" in res.json()["detail"]
    assert registry.all_entries() == {}
    # 1バイトも書かれていない
    assert _snapshot(folder) == before
    assert (folder / "project.json").read_bytes() == before_json


def test_open_folder_inside_data_dir_is_rejected(client):
    """data_dir 配下（従来配置のプロジェクトフォルダ以外）は 400（create と同文言）。"""
    inside = data_dir() / "inside"
    inside.mkdir(parents=True)
    (inside / "project.json").write_text(
        json.dumps(_folder_doc("epinside")), encoding="utf-8"
    )

    res = _open(client, inside)

    assert res.status_code == 400
    assert "データフォルダ" in res.json()["detail"]
    assert registry.all_entries() == {}


def test_registry_and_project_json_mismatch_is_409(client, tmp_path):
    """フォルダは登録済みなのに project.json の id が食い違う → 黙って直さず 409。"""
    folder = _make_open_folder(tmp_path, "ep33")
    assert _open(client, folder).status_code == 200  # 登録

    # 何者かが project.json の id だけ差し替えた（壊れた対応）
    doc = json.loads((folder / "project.json").read_text(encoding="utf-8"))
    doc["id"] = "someoneelse"
    (folder / "project.json").write_text(json.dumps(doc), encoding="utf-8")

    res = _open(client, folder)

    assert res.status_code == 409
    assert "対応が壊れています" in res.json()["detail"]
    # レジストリは元のまま（上書きも追加もしない）
    assert list(registry.all_entries()) == ["ep33"]


# ---------------------------------------------------------------- id 衝突の採番し直し


def test_id_collision_renumbers_and_rewrites_folder_project_json(client, tmp_path):
    _make_legacy_project("collide2")
    folder = _make_open_folder(tmp_path, "collide2")

    res = _open(client, folder)

    assert res.status_code == 200, res.text
    payload = res.json()["project"]
    new_id = payload["id"]
    assert new_id != "collide2"
    assert payload["adopted_as_new_project"] is True
    assert payload["source_project_id"] == "collide2"
    # フォルダ内 project.json が新 id で書き戻される（書き戻さないと次回また衝突する）
    on_disk = json.loads((folder / "project.json").read_text(encoding="utf-8"))
    assert on_disk["id"] == new_id
    entry = registry.entry_for(new_id)
    assert entry is not None and Path(entry["root"]) == folder.resolve()

    # 2回目は逆引きで同じ id に戻る（採番が増殖しない）
    again = _open(client, folder)
    assert again.status_code == 200, again.text
    assert again.json()["project"]["id"] == new_id
    assert list(registry.all_entries()) == [new_id]


# ---------------------------------------------------------------- レガシー再オープン


def test_legacy_layout_folder_reopens_in_place_without_registration(client, tmp_path):
    project = _make_legacy_project("legacyreopen")
    pdir = storage.project_dir(project.id)
    before = _snapshot(pdir)

    res = _open(client, pdir)

    assert res.status_code == 200, res.text
    assert res.json()["project"]["id"] == project.id  # 自分自身なので採番しない
    assert registry.all_entries() == {}  # 従来配置のまま（登録しない）
    after = _snapshot(pdir)
    assert set(after) == set(before)  # 無コピー
    for name in before:
        if name != "project.json":
            assert after[name] == before[name]


# ---------------------------------------------------------------- 幽霊プロジェクト


def test_ghost_project_is_rejected_before_any_write(client, tmp_path):
    """編集済みなのに音源参照が無い文書は引き続き 400。登録も書き込みもしない。"""
    folder = tmp_path / "ghost"
    folder.mkdir()
    project = ProjectState.new("ghostopen", "ghost")
    project.blocks.append(
        Block(id="b0", speaker="A", start=0.0, source_start=0.0, source_end=0.5)
    )
    (folder / "project.json").write_text(
        json.dumps(project.to_dict(), ensure_ascii=False), encoding="utf-8"
    )
    before_json = (folder / "project.json").read_bytes()

    res = _open(client, folder)

    assert res.status_code == 400
    assert "音源が設定されていない" in res.json()["detail"]
    assert registry.all_entries() == {}
    assert _snapshot(folder) == {"project.json": (folder / "project.json").stat().st_ino}
    assert (folder / "project.json").read_bytes() == before_json


def test_failed_resolution_unregisters_dangling_entry(client, tmp_path):
    """登録後に音源解決で 400 になってもエントリを残さない（create と同じ判断）。

    残すと以後の同フォルダ指定が逆引きで旧 id を掴み続ける。後段は音源を
    足せばやり直せることの回復確認（対照実験を兼ねる）。
    """
    folder = tmp_path / "halfopen"
    folder.mkdir()
    (folder / "project.json").write_text(
        json.dumps(_folder_doc("halfopen")), encoding="utf-8"
    )  # 参照だけあって実体なし

    res = _open(client, folder)

    assert res.status_code == 400
    assert "音源ファイルが見つかりません" in res.json()["detail"]
    assert registry.all_entries() == {}

    for sp in ("A", "B"):
        _write_wav(folder / f"speaker{sp}_normalized.wav")
    assert _open(client, folder).status_code == 200
    assert list(registry.all_entries()) == ["halfopen"]
