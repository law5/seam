"""作業フォルダ衝突時の行き止まり解消（Issue #53）のテスト。

固定するのは6つ:

- 孤児レジストリエントリ（登録あり + project.json 実在なし、Issue #34）:
  precheck が "ok" を返し、create が黙って登録を付け替えて成功する
- 本物の既存プロジェクト: precheck が "existing_project"、overwrite_existing なしの
  create は従来どおり 400（API 直叩きでも既定では破壊できない）
- overwrite_existing=true: project.json + 派生物（RESERVED_ARTIFACT_NAMES）の実在分
  **だけ**が消え、無関係なユーザーファイルは無傷。旧エントリは unregister される
- precheck: validate_workdir + data_dir ガードを create と同じ判定で通し
  （拒否パスは create に進む前にここで 400）、読み書きゼロ
- 上書き対象のプロジェクトに実行中ジョブがあれば 400（削除と派生物書き込みの競合防止）
- 不変条件「拒否される取込は旧プロジェクトを1バイトも消さない」: アップロード失敗
  （413 等）で終わる上書き取込は project.json・派生物・レジストリエントリ全て無傷
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
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))


@pytest.fixture(autouse=True)
def _stub_import(monkeypatch):
    """ffmpeg 依存の取込ジョブを止める。テストが見るのは配置とレジストリだけ。

    注意: スタブは _update_job を呼ばないため、取込ジョブは "running" のまま
    残る（= 実行中ジョブチェックに引っかかる）。上書きを成功させたいテストは
    _finish_import_job で先に完了扱いにすること。
    """
    monkeypatch.setattr(server, "_run_import", lambda pid, jid, normalize=True: None)


@pytest.fixture(autouse=True)
def _clear_jobs():
    """モジュールグローバルの _jobs をテスト間で持ち越さない。"""
    server._jobs.clear()
    yield
    server._jobs.clear()


def _finish_import_job(create_response) -> None:
    """スタブ取込で running のまま残るジョブを完了扱いにする。"""
    server._update_job(create_response.json()["job"]["id"], status="complete")


def _wav_bytes(seconds: float = 0.1, rate: int = 8000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(struct.pack("<h", 1000) * int(seconds * rate))
    return buf.getvalue()


def _post_project(client, workdir=None, name="EP53", overwrite=None):
    data = {"name": name}
    if workdir is not None:
        data["workdir"] = workdir
    if overwrite is not None:
        data["overwrite_existing"] = overwrite
    return client.post(
        "/api/projects",
        data=data,
        files={
            "speaker_a": ("a.wav", _wav_bytes(), "audio/wav"),
            "speaker_b": ("b.wav", _wav_bytes(), "audio/wav"),
        },
    )


def _precheck(client, workdir):
    return client.post("/api/system/workdir_precheck", json={"workdir": workdir})


# ---------------------------------------------------------------- 孤児の自動付け替え（#34 案1）


def test_orphan_entry_is_silently_replaced(client, tmp_path):
    """登録あり + project.json なし = 孤児。precheck は ok（ダイアログ相当なし）で、
    create が stale エントリを外して成功し、登録が新プロジェクトに付け替わる。"""
    wd = tmp_path / "orphaned"
    wd.mkdir()
    first = _post_project(client, workdir=str(wd), name="first")
    assert first.status_code == 200
    first_id = first.json()["project"]["id"]
    # ユーザーがフォルダの中身を手動で全部消した状況を再現
    for path in wd.iterdir():
        path.unlink()

    # precheck は孤児を existing_project にしない（サーバ側で透過処理するため）
    pre = _precheck(client, str(wd))
    assert pre.status_code == 200
    assert pre.json()["status"] == "ok"

    res = _post_project(client, workdir=str(wd), name="second")

    assert res.status_code == 200
    second_id = res.json()["project"]["id"]
    assert (wd / "project.json").is_file()
    entries = registry.all_entries()
    assert first_id not in entries  # stale エントリは消えている
    assert list(entries) == [second_id]
    assert Path(entries[second_id]["root"]) == wd.resolve()


def test_orphan_cleanup_does_not_touch_other_roots(client, tmp_path):
    """孤児の無効化は同フォルダを root とするエントリだけ。別フォルダの
    プロジェクトのエントリと実体には影響しない。"""
    other = tmp_path / "other"
    other.mkdir()
    keep = _post_project(client, workdir=str(other), name="keep")
    assert keep.status_code == 200
    keep_id = keep.json()["project"]["id"]
    keep_doc = (other / "project.json").read_bytes()

    wd = tmp_path / "orphaned"
    wd.mkdir()
    first = _post_project(client, workdir=str(wd), name="first")
    assert first.status_code == 200
    for path in wd.iterdir():
        path.unlink()

    res = _post_project(client, workdir=str(wd), name="second")

    assert res.status_code == 200
    entries = registry.all_entries()
    assert keep_id in entries
    assert Path(entries[keep_id]["root"]) == other.resolve()
    assert (other / "project.json").read_bytes() == keep_doc


# ---------------------------------------------------------------- 本物ケース（既定は 400 のまま）


def test_precheck_reports_existing_project(client, tmp_path):
    wd = tmp_path / "real"
    wd.mkdir()
    (wd / "project.json").write_bytes(b'{"id": "someone"}')

    res = _precheck(client, str(wd))

    assert res.status_code == 200
    assert res.json() == {"status": "existing_project", "workdir": str(wd.resolve())}


def test_create_on_real_project_without_consent_is_400(client, tmp_path):
    """overwrite_existing なし（既定 false）は従来どおり 400 — API 直叩きでも
    既定では破壊できない。明示 false も同じ。"""
    wd = tmp_path / "real"
    wd.mkdir()
    doc = b'{"id": "someone"}'
    (wd / "project.json").write_bytes(doc)

    for overwrite in (None, "false"):
        res = _post_project(client, workdir=str(wd), overwrite=overwrite)
        assert res.status_code == 400
        assert "復元で開いてください" in res.json()["detail"]
        assert (wd / "project.json").read_bytes() == doc
        assert registry.all_entries() == {}


# ---------------------------------------------------------------- 上書きの明示同意


def test_overwrite_existing_replaces_project_and_keeps_user_files(client, tmp_path):
    """overwrite_existing=true で project.json + 派生物の実在分だけが消えて新規取込が
    成功する。旧エントリは unregister され、無関係なユーザーファイルは無傷。"""
    wd = tmp_path / "real"
    wd.mkdir()
    first = _post_project(client, workdir=str(wd), name="first")
    assert first.status_code == 200
    first_id = first.json()["project"]["id"]
    _finish_import_job(first)  # 実行中ジョブがあると上書きは 400（別テストで固定）
    # 取込パイプラインの派生物（本テストでは _run_import をスタブしているので手置き）
    (wd / "speakerA_normalized.wav").write_bytes(b"stale artifact")
    (wd / "speakerB_peaks.u8").write_bytes(b"stale peaks")
    # 無関係なユーザーファイルとサブフォルダ（識別できないものには絶対に触れない）
    user_note = b"user's precious bytes"
    (wd / "notes.txt").write_bytes(user_note)
    (wd / "exports").mkdir()
    (wd / "exports" / "old_export.wav").write_bytes(b"old export")

    res = _post_project(client, workdir=str(wd), name="second", overwrite="true")

    assert res.status_code == 200, res.text
    second_id = res.json()["project"]["id"]
    assert second_id != first_id
    # project.json は新プロジェクトのものに置き換わっている
    assert f'"{second_id}"' in (wd / "project.json").read_text(encoding="utf-8")
    # 派生物は消えている（取込が上書きで壊す前に掃除済み）
    assert not (wd / "speakerA_normalized.wav").exists()
    assert not (wd / "speakerB_peaks.u8").exists()
    # ユーザーファイル・サブフォルダは1バイトも変わらない
    assert (wd / "notes.txt").read_bytes() == user_note
    assert (wd / "exports" / "old_export.wav").read_bytes() == b"old export"
    # レジストリは旧エントリが消えて新エントリだけ
    entries = registry.all_entries()
    assert list(entries) == [second_id]
    assert Path(entries[second_id]["root"]) == wd.resolve()


def test_overwrite_does_not_lift_data_dir_guard(client):
    """同意フラグが外すのは「このフォルダの既存プロジェクト」のガードだけ。
    アプリのデータフォルダ保護は overwrite_existing でも解除されない。"""
    inside = data_dir() / "inside"
    inside.mkdir(parents=True)

    res = _post_project(client, workdir=str(inside), overwrite="true")

    assert res.status_code == 400
    assert "データフォルダ" in res.json()["detail"]


def test_overwrite_while_job_running_is_rejected(client, tmp_path):
    """上書き対象のプロジェクトに実行中ジョブがあれば 400。実行中の ffmpeg/whisper は
    解決済みパスを掴んでおり、削除+新規取込と派生物を上書きし合うため。
    400 の時点では旧プロジェクト（ファイル・レジストリ）は1バイトも変わらず、
    ジョブ完了後は同じリクエストが成功する。"""
    wd = tmp_path / "real"
    wd.mkdir()
    first = _post_project(client, workdir=str(wd), name="first")
    assert first.status_code == 200
    first_id = first.json()["project"]["id"]
    # _stub_import は _update_job を呼ばないので取込ジョブは "running" のまま
    doc = (wd / "project.json").read_bytes()
    (wd / "speakerA_normalized.wav").write_bytes(b"artifact")

    res = _post_project(client, workdir=str(wd), name="second", overwrite="true")

    assert res.status_code == 400
    assert "実行中" in res.json()["detail"]
    assert (wd / "project.json").read_bytes() == doc
    assert (wd / "speakerA_normalized.wav").read_bytes() == b"artifact"
    assert list(registry.all_entries()) == [first_id]

    # ジョブ完了後は同じリクエストで上書きできる
    _finish_import_job(first)
    res = _post_project(client, workdir=str(wd), name="second", overwrite="true")
    assert res.status_code == 200, res.text
    assert list(registry.all_entries()) == [res.json()["project"]["id"]]


def test_failed_upload_leaves_old_project_fully_intact(client, tmp_path, monkeypatch):
    """不変条件「拒否される取込は旧プロジェクトを1バイトも消さない」の固定。

    上書き同意済みでも、アップロードが途中で失敗（片方が 413）した取込は
    旧 project.json・派生物・レジストリエントリを全て無傷のまま残し、
    一時ファイル（.upload-*.part）も新規エントリも残さない — 「旧だけ消えて
    新規も作れない」中間状態を作らない。"""
    wd = tmp_path / "real"
    wd.mkdir()
    first = _post_project(client, workdir=str(wd), name="first")
    assert first.status_code == 200
    first_id = first.json()["project"]["id"]
    _finish_import_job(first)  # 実行中ジョブチェックではなく失敗経路を見るテスト
    (wd / "speakerA_normalized.wav").write_bytes(b"artifact")
    doc = (wd / "project.json").read_bytes()
    before = sorted(path.name for path in wd.iterdir())

    # speaker_b だけ上限超過にして「A ステージ成功 → B で 413」を再現
    monkeypatch.setattr(server, "MAX_UPLOAD_BYTES", 1024)
    res = client.post(
        "/api/projects",
        data={"name": "second", "workdir": str(wd), "overwrite_existing": "true"},
        files={
            "speaker_a": ("a.wav", _wav_bytes(0.01), "audio/wav"),
            "speaker_b": ("b.wav", b"x" * 2048, "audio/wav"),
        },
    )

    assert res.status_code == 413
    assert (wd / "project.json").read_bytes() == doc
    assert (wd / "speakerA_normalized.wav").read_bytes() == b"artifact"
    assert list(registry.all_entries()) == [first_id]
    # フォルダ構成ごと無傷: .part もステージ済みファイルも残らない
    assert sorted(path.name for path in wd.iterdir()) == before


def test_overwrite_with_corrupted_registry_deletes_nothing(client, tmp_path):
    """レジストリ破損時は登録（register）で 500 になり、ファイル削除まで進まない。
    「消えたのに登録は旧のまま」という中途半端な状態を作らない順序の固定。"""
    wd = tmp_path / "real"
    wd.mkdir()
    doc = b'{"id": "someone"}'
    (wd / "project.json").write_bytes(doc)
    (wd / "speakerA_normalized.wav").write_bytes(b"artifact")
    reg_path = data_dir() / registry.REGISTRY_FILENAME
    reg_path.parent.mkdir(parents=True, exist_ok=True)
    reg_path.write_text("{ not json", encoding="utf-8")
    registry.reset_cache()

    res = _post_project(client, workdir=str(wd), overwrite="true")

    assert res.status_code == 500
    assert "破損" in res.json()["detail"]
    assert (wd / "project.json").read_bytes() == doc
    assert (wd / "speakerA_normalized.wav").read_bytes() == b"artifact"
    assert reg_path.read_text(encoding="utf-8") == "{ not json"


# ---------------------------------------------------------------- precheck の規律


def test_precheck_rejects_data_dir_with_same_detail_as_create(client):
    """data_dir 配下は create の最終ガードで必ず 400 になる指定。precheck が ok を
    返すと「ダイアログ無しで取込に進んでから 400」の UX 不整合になるため、
    precheck も同じ判定（共有ヘルパ）で同じ detail の 400 を返す。"""
    inside = data_dir() / "inside"
    inside.mkdir(parents=True)

    pre = _precheck(client, str(inside))
    created = _post_project(client, workdir=str(inside))

    assert pre.status_code == 400
    assert created.status_code == 400
    assert (
        pre.json()["detail"]
        == created.json()["detail"]
        == "アプリのデータフォルダ内は指定できません"
    )


def test_precheck_ok_for_empty_folder(client, tmp_path):
    wd = tmp_path / "empty"
    wd.mkdir()
    res = _precheck(client, str(wd))
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "workdir": str(wd.resolve())}


def test_precheck_rejects_invalid_workdir_and_writes_nothing(client, tmp_path, monkeypatch):
    """validate_workdir を迂回しない: 不存在パス・クラウド同期フォルダは 400。
    読み書きゼロ（フォルダもレジストリも無傷）。"""
    # 不存在パス
    missing = tmp_path / "not-created"
    res = _precheck(client, str(missing))
    assert res.status_code == 400
    assert "見つかりません" in res.json()["detail"]
    assert not missing.exists()  # 勝手に作らない

    # クラウド同期フォルダ（validate_workdir の拒否リスト）
    cloud = tmp_path / "cloud-root"
    target = cloud / "Podcast"
    target.mkdir(parents=True)
    from podcast_prep import workdir as workdir_mod

    monkeypatch.setattr(workdir_mod, "_cloud_roots", lambda: [cloud])
    res = _precheck(client, str(target))
    assert res.status_code == 400
    assert "クラウド同期フォルダ" in res.json()["detail"]

    # 読み書きゼロ: レジストリファイルが作られていない
    assert not (data_dir() / registry.REGISTRY_FILENAME).exists()
    assert list(target.iterdir()) == []


def test_precheck_requires_workdir_string(client):
    assert _precheck(client, None).status_code == 400
    res = client.post("/api/system/workdir_precheck", json={})
    assert res.status_code == 400
    assert "workdir" in res.json()["detail"]
