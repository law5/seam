"""エクスポートの可搬性（Issue #19）とエクスポート先の自由化（Issue #18）。

- exporter が project.json に**相対参照**を書き、素材音源を出力先へ同梱すること
- 出力先フォルダごと別の場所へ移動しても POST /api/projects/open で開けること
- 旧形式（絶対パス）の project.json が従来どおり開けること（後方互換）
- 音源不在は誘導メッセージつき 400
- GET /api/export/targets と POST /export の許可ベース検証
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
from podcast_prep.exporter import export_project
from podcast_prep.models import Block, ProjectState


@pytest.fixture()
def client():
    return TestClient(server.app)


def _write_wav(path: Path, seconds: float = 1.0, rate: int = 48000) -> None:
    frames = int(seconds * rate)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(struct.pack("<h", 4096) * frames)


def _make_full_project(tmp_path, monkeypatch, pid="proj-portable") -> ProjectState:
    """両トラックに実ファイル（original + normalized）を持つプロジェクトを作る。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    project = ProjectState.new(pid, "portable test")
    project.status = "ready"
    pdir = storage.project_dir(pid, create=True)
    for index, speaker in enumerate(("A", "B")):
        original = f"speaker{speaker}.wav"
        normalized = f"speaker{speaker}_normalized.wav"
        _write_wav(pdir / original)
        _write_wav(pdir / normalized)
        track = project.tracks[speaker]
        track.original_file = original
        track.normalized_wav = normalized
        track.duration = 1.0
        project.blocks.append(
            Block(
                id=f"b{index}",
                speaker=speaker,
                start=0.0,
                source_start=0.0,
                source_end=0.5,
            )
        )
    storage.save_project(project)
    return project


requires_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg not installed"
)


# ---------------------------------------------------------------- exporter: 相対参照


@requires_ffmpeg
def test_export_writes_relative_audio_references(tmp_path, monkeypatch):
    """bundle="reeditable" のとき、素材参照は相対（= 同階層のファイル名）であること。"""
    project = _make_full_project(tmp_path, monkeypatch)
    outdir = tmp_path / "out"
    export_project(project, outdir, bundle="reeditable")

    doc = json.loads((outdir / "project.json").read_text(encoding="utf-8"))
    for speaker in ("A", "B"):
        value = doc["tracks"][speaker]["normalized_wav"]
        assert value, f"{speaker}.normalized_wav が空"
        assert not Path(value).is_absolute(), f"{speaker} が絶対パス: {value}"
        assert Path(value).name == value, "サブディレクトリを挟まないファイル名であること"
        assert (outdir / value).is_file(), f"参照先が同梱されていない: {value}"
        # 取込元は同梱しない（_source が上位互換なので重複を排した）
        assert doc["tracks"][speaker]["original_file"] == ""
        assert not list(outdir.glob(f"speaker{speaker}_original.*"))


@requires_ffmpeg
def test_export_source_is_not_the_rendered_track(tmp_path, monkeypatch):
    """normalized_wav の参照先は編集後レンダリング speakerX.wav ではないこと。

    ここを取り違えると開き直したときブロック座標が編集済み音声に再適用され、
    二重編集になる（可搬性のためにデータを壊してはいけない）。
    """
    project = _make_full_project(tmp_path, monkeypatch)
    outdir = tmp_path / "out"
    export_project(project, outdir, bundle="reeditable")
    doc = json.loads((outdir / "project.json").read_text(encoding="utf-8"))
    for speaker in ("A", "B"):
        assert doc["tracks"][speaker]["normalized_wav"] != f"speaker{speaker}.wav"
        # 素材は元の normalized と同一バイト列（レンダリング結果ではない）
        exported = (outdir / doc["tracks"][speaker]["normalized_wav"]).read_bytes()
        source = (
            storage.project_dir(project.id) / f"speaker{speaker}_normalized.wav"
        ).read_bytes()
        assert exported == source


# ---------------------------------------------------------------- open: フォルダごと移動


@requires_ffmpeg
def test_moved_export_folder_can_be_opened(tmp_path, monkeypatch, client):
    """要件の本丸: エクスポート → 別ディレクトリへ移動 → open で音源が解決できる。

    可搬性は bundle="reeditable"（素材同梱）が担保する。既定の "none" は
    納品物のみで、再編集は元プロジェクトから行う。
    """
    project = _make_full_project(tmp_path, monkeypatch)
    outdir = tmp_path / "out"
    export_project(project, outdir, bundle="reeditable")

    moved = tmp_path / "moved" / "episode12"
    moved.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(outdir), str(moved))

    # 元のデータディレクトリごと消しても開けること（＝絶対パスに依存していない）
    shutil.rmtree(tmp_path / "data")

    payload = (moved / "project.json").read_bytes()
    res = client.post(
        "/api/projects/open",
        files={"project_json": ("project.json", payload, "application/json")},
        data={"source_dir": str(moved)},
    )
    assert res.status_code == 200, res.text
    opened = res.json()["project"]
    pdir = storage.project_dir(opened["id"])
    for speaker in ("A", "B"):
        track = opened["tracks"][speaker]
        assert not Path(track["normalized_wav"]).is_absolute()
        assert (pdir / track["normalized_wav"]).is_file()
        # 取込元は同梱しないので参照も空（編集・再生・書き出しは normalized_wav で完結）
        assert track["original_file"] == ""


@requires_ffmpeg
def test_moved_export_can_be_opened_via_uploaded_audio(tmp_path, monkeypatch, client):
    """ブラウザ経路: source_dir を渡せない代わりに音源を同送して解決する。"""
    project = _make_full_project(tmp_path, monkeypatch)
    outdir = tmp_path / "out"
    export_project(project, outdir, bundle="reeditable")
    moved = tmp_path / "moved"
    shutil.move(str(outdir), str(moved))
    shutil.rmtree(tmp_path / "data")

    doc = json.loads((moved / "project.json").read_text(encoding="utf-8"))
    uploads = [("project_json", ("project.json", json.dumps(doc).encode("utf-8"), "application/json"))]
    for speaker in ("A", "B"):
        name = doc["tracks"][speaker]["normalized_wav"]
        uploads.append(("audio", (name, (moved / name).read_bytes(), "audio/wav")))

    res = client.post("/api/projects/open", files=uploads)
    assert res.status_code == 200, res.text
    pdir = storage.project_dir(res.json()["project"]["id"])
    assert (pdir / "speakerA_normalized.wav").is_file()
    assert (pdir / "speakerB_normalized.wav").is_file()


# ---------------------------------------------------------------- open: 後方互換


def test_open_legacy_absolute_paths_need_the_audio_alongside(tmp_path, monkeypatch, client):
    """旧形式（絶対パス）は、素材を同送すれば開ける。

    **仕様変更（QA Critical 指摘）**: 以前は「絶対パスが実在すれば無条件に採用」して
    project_dir へコピーしていたため、細工した project.json でホスト上の任意ファイル
    （SSH鍵・認証情報など）を引き込んで GET /audio から読み出せた。絶対パスも
    許可ディレクトリ（source_dir / project_dir）配下に封じ込める。
    旧形式の利用者は素材を一緒に選べば従来どおり開ける。
    """
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    legacy_dir = tmp_path / "legacy"
    legacy_dir.mkdir()
    doc = ProjectState.new("proj-legacy", "legacy").to_dict()
    for speaker in ("A", "B"):
        original = legacy_dir / f"old{speaker}.wav"
        normalized = legacy_dir / f"old{speaker}_norm.wav"
        _write_wav(original)
        _write_wav(normalized)
        doc["tracks"][speaker]["original_file"] = str(original)
        doc["tracks"][speaker]["normalized_wav"] = str(normalized)

    payload = json.dumps(doc).encode("utf-8")
    # 素材のフォルダを source_dir として渡せば開ける
    res = client.post(
        "/api/projects/open",
        data={"source_dir": str(legacy_dir)},
        files={"project_json": ("project.json", payload, "application/json")},
    )
    assert res.status_code == 200, res.text
    pdir = storage.project_dir(res.json()["project"]["id"])
    for speaker in ("A", "B"):
        track = res.json()["project"]["tracks"][speaker]
        assert (pdir / track["normalized_wav"]).is_file()


def test_open_rejects_absolute_path_outside_allowed_dirs(tmp_path, monkeypatch, client):
    """許可ディレクトリ外の絶対パスは引き込まない（任意ファイル読み取りの防止）。

    回帰: 細工した project.json に /etc/hosts や鍵ファイルの絶対パスを入れて開くと、
    project_dir へコピーされ GET /audio で中身が読めた（QA Critical）。
    """
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    secret = tmp_path / "outside" / "id_rsa"
    secret.parent.mkdir(parents=True)
    secret.write_bytes(b"-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n")
    doc = ProjectState.new("proj-exfil", "exfil").to_dict()
    for speaker in ("A", "B"):
        doc["tracks"][speaker]["original_file"] = ""
        doc["tracks"][speaker]["normalized_wav"] = str(secret)

    res = client.post(
        "/api/projects/open",
        files={
            "project_json": ("project.json", json.dumps(doc).encode("utf-8"), "application/json")
        },
    )
    assert res.status_code == 400
    assert "音源ファイルが見つかりません" in res.json()["detail"]
    # 1バイトも引き込まれていない
    pdir = storage.data_dir() / "projects" / "proj-exfil"
    assert not pdir.exists() or not any(
        f.read_bytes().startswith(b"-----BEGIN") for f in pdir.iterdir() if f.is_file()
    )


def test_open_with_colliding_id_does_not_destroy_existing_audio(tmp_path, monkeypatch, client):
    """ID衝突時は別プロジェクトとして採番し、既存の収録音源を上書きしない。

    回帰: project.json は id を保持したまま書き出されるため、同じプロジェクトを
    2回書き出して片方を開き直すだけで、既存の（録り直せない）音源が固定名で
    無警告に上書きされていた（QA Critical・攻撃者不要）。
    """
    existing = _make_full_project(tmp_path, monkeypatch, pid="collide")
    pdir = storage.project_dir(existing.id)
    precious = pdir / existing.tracks["A"].normalized_wav
    precious.write_bytes(b"MY-PRECIOUS-RECORDING")

    src = tmp_path / "incoming"
    src.mkdir()
    _write_wav(src / "speakerA_source.wav", seconds=0.5)
    _write_wav(src / "speakerB_source.wav", seconds=0.5)
    doc = {
        "id": existing.id,  # 同じID
        "name": "incoming",
        "tracks": {
            sp: {"speaker": sp, "original_file": "", "normalized_wav": f"speaker{sp}_source.wav"}
            for sp in ("A", "B")
        },
        "blocks": [],
        "transcripts": [],
        "overlaps": [],
    }
    res = client.post(
        "/api/projects/open",
        data={"source_dir": str(src)},
        files={
            "project_json": ("project.json", json.dumps(doc).encode("utf-8"), "application/json")
        },
    )
    assert res.status_code == 200, res.text
    payload = res.json()["project"]
    assert payload["id"] != existing.id  # 別プロジェクトとして採番された
    assert payload.get("adopted_as_new_project") is True
    assert precious.read_bytes() == b"MY-PRECIOUS-RECORDING"  # 既存の音源は無傷


def test_open_relative_paths_already_in_project_dir(tmp_path, monkeypatch, client):
    """同じデータディレクトリで開き直すケース（source_dir なしでも解決できる）。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-reopen")
    doc = json.loads(
        (storage.project_dir(project.id) / "project.json").read_text(encoding="utf-8")
    )
    res = client.post(
        "/api/projects/open",
        files={"project_json": ("project.json", json.dumps(doc).encode("utf-8"), "application/json")},
    )
    assert res.status_code == 200, res.text


def test_open_missing_audio_returns_guiding_400(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    doc = ProjectState.new("proj-missing", "missing").to_dict()
    doc["tracks"]["A"]["normalized_wav"] = "speakerA_source.wav"
    res = client.post(
        "/api/projects/open",
        files={"project_json": ("project.json", json.dumps(doc).encode("utf-8"), "application/json")},
    )
    assert res.status_code == 400
    detail = res.json()["detail"]
    assert "speakerA_source.wav" in detail
    assert "project.json と同じフォルダ" in detail


def test_open_rejects_traversal_in_track_reference(tmp_path, monkeypatch, client):
    """project.json 内のトラック値で '..' 脱出を狙っても取り込めない（400）。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    outside = tmp_path / "outside"
    outside.mkdir()
    secret = outside / "secret.wav"
    _write_wav(secret)
    sibling = tmp_path / "sibling"
    sibling.mkdir()

    doc = ProjectState.new("proj-evil", "evil").to_dict()
    doc["tracks"]["A"]["normalized_wav"] = "../outside/secret.wav"
    res = client.post(
        "/api/projects/open",
        files={"project_json": ("project.json", json.dumps(doc).encode("utf-8"), "application/json")},
        data={"source_dir": str(sibling)},
    )
    assert res.status_code == 400
    assert not (storage.project_dir("proj-evil") / "speakerA_normalized.wav").exists()


def test_open_rejects_symlink_escape_in_track_reference(tmp_path, monkeypatch, client):
    """source_dir 内のシンボリックリンク経由で外部ファイルを取り込めない。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    outside = tmp_path / "outside"
    outside.mkdir()
    secret = outside / "secret.wav"
    _write_wav(secret)
    sibling = tmp_path / "sibling"
    sibling.mkdir()
    (sibling / "innocent.wav").symlink_to(secret)

    doc = ProjectState.new("proj-link", "link").to_dict()
    doc["tracks"]["A"]["normalized_wav"] = "innocent.wav"
    res = client.post(
        "/api/projects/open",
        files={"project_json": ("project.json", json.dumps(doc).encode("utf-8"), "application/json")},
        data={"source_dir": str(sibling)},
    )
    assert res.status_code == 400
    assert not (storage.project_dir("proj-link") / "speakerA_normalized.wav").exists()


def test_open_same_file_for_original_and_normalized(tmp_path, monkeypatch, client):
    """病的ケース: original_file と normalized_wav が同一ファイルを指しても壊れない。

    フェーズ4（作業フォルダの可変化）以降、source_dir はそのまま作業フォルダに
    なり、フォルダ内の音源はコピーしない。両フィールドは同じ相対参照を保持した
    まま開き、コピー元を自身で上書きする経路は構造的に存在しなくなった。
    """
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    sibling = tmp_path / "sibling"
    sibling.mkdir()
    _write_wav(sibling / "shared.wav")
    before = (sibling / "shared.wav").read_bytes()
    doc = ProjectState.new("proj-collide", "collide").to_dict()
    doc["tracks"]["A"]["original_file"] = "shared.wav"
    doc["tracks"]["A"]["normalized_wav"] = "shared.wav"
    res = client.post(
        "/api/projects/open",
        files={"project_json": ("project.json", json.dumps(doc).encode("utf-8"), "application/json")},
        data={"source_dir": str(sibling)},
    )
    assert res.status_code == 200, res.text
    track = res.json()["project"]["tracks"]["A"]
    assert track["original_file"] == "shared.wav"
    assert track["normalized_wav"] == "shared.wav"
    pdir = storage.project_dir("proj-collide")
    assert pdir == sibling.resolve()  # フォルダ自身が作業フォルダになった
    assert (sibling / "shared.wav").read_bytes() == before  # 1バイトも壊れていない


@requires_ffmpeg
def test_export_into_project_exports_dir_is_self_consistent(tmp_path, monkeypatch):
    """出力先がプロジェクト配下（既定の exports 直下。Issue #28）でも相対参照になること。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-inplace")
    outdir = storage.project_dir(project.id) / "exports"
    export_project(project, outdir, bundle="reeditable")
    doc = json.loads((outdir / "project.json").read_text(encoding="utf-8"))
    for speaker in ("A", "B"):
        value = doc["tracks"][speaker]["normalized_wav"]
        assert not Path(value).is_absolute()
        assert (outdir / value).is_file()


@pytest.mark.parametrize("bad", ["relative/dir", "not-absolute"])
def test_open_rejects_non_absolute_source_dir(tmp_path, monkeypatch, client, bad):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    doc = ProjectState.new("proj-sd", "sd").to_dict()
    res = client.post(
        "/api/projects/open",
        files={"project_json": ("project.json", json.dumps(doc).encode("utf-8"), "application/json")},
        data={"source_dir": bad},
    )
    assert res.status_code == 400


def test_open_rejects_missing_source_dir(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    doc = ProjectState.new("proj-sd2", "sd").to_dict()
    res = client.post(
        "/api/projects/open",
        files={"project_json": ("project.json", json.dumps(doc).encode("utf-8"), "application/json")},
        data={"source_dir": str(tmp_path / "does-not-exist")},
    )
    assert res.status_code == 400


# ---------------------------------------------------------------- Issue #18: 書き出し先


def test_export_targets_without_env_returns_single_entry(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    storage.project_dir("proj-t", create=True)
    res = client.get("/api/export/targets", params={"project_id": "proj-t"})
    assert res.status_code == 200
    body = res.json()
    assert body["configured"] is False
    assert len(body["targets"]) == 1
    assert body["targets"][0]["is_default"] is True


def test_export_targets_with_env_returns_two_entries(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    base = tmp_path / "Podcast" / "exports"
    base.mkdir(parents=True)
    monkeypatch.setenv("SEAM_EXPORT_DIR", str(base))
    storage.project_dir("proj-t2", create=True)
    res = client.get("/api/export/targets", params={"project_id": "proj-t2"})
    body = res.json()
    assert body["configured"] is True
    assert [t["path"] for t in body["targets"]][1] == str(base.resolve())


def test_export_targets_rejects_bad_project_id(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    res = client.get("/api/export/targets", params={"project_id": "../escape"})
    assert res.status_code == 400


def test_start_export_rejects_absolute_path_outside_allowed(tmp_path, monkeypatch, client):
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-x1")
    res = client.post(
        f"/api/projects/{project.id}/export",
        json={"format": "wav", "output_dir": "/tmp/definitely-not-allowed"},
    )
    assert res.status_code == 400


def test_start_export_accepts_absolute_path_inside_configured_base(tmp_path, monkeypatch, client):
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-x2")
    base = tmp_path / "Podcast" / "exports"
    base.mkdir(parents=True)
    monkeypatch.setenv("SEAM_EXPORT_DIR", str(base))
    captured: dict[str, Path] = {}

    def fake_export(project_arg, target, export_format="wav", progress=None, **_kwargs):
        captured["target"] = Path(target)
        Path(target).mkdir(parents=True, exist_ok=True)
        return {}

    monkeypatch.setattr(server, "export_project", fake_export)
    res = client.post(
        f"/api/projects/{project.id}/export",
        json={"format": "wav", "output_dir": str(base / "ep12")},
    )
    assert res.status_code == 200, res.text
    assert captured["target"] == (base / "ep12").resolve()


def test_start_export_label_backward_compatible(tmp_path, monkeypatch, client):
    """後方互換: ラベル指定は従来どおり exports/<label>。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-x3")
    captured: dict[str, Path] = {}

    def fake_export(project_arg, target, export_format="wav", progress=None, **_kwargs):
        captured["target"] = Path(target)
        Path(target).mkdir(parents=True, exist_ok=True)
        return {}

    monkeypatch.setattr(server, "export_project", fake_export)
    res = client.post(
        f"/api/projects/{project.id}/export", json={"format": "wav", "output_dir": "take7"}
    )
    assert res.status_code == 200, res.text
    expected = (storage.project_dir(project.id) / "exports" / "take7").resolve()
    assert captured["target"] == expected


def test_start_export_rejects_label_colliding_with_existing_file(tmp_path, monkeypatch, client):
    """成果物と同名ラベルは 400 で事前に断る（QA指摘）。

    既定エクスポート（exports 直下）を済ませた後にラベル "speakerA.wav" を指定すると、
    exports/speakerA.wav が**ファイル**として既に在るため mkdir が FileExistsError になり、
    ジョブ error に生メッセージが漏れていた。ジョブを作る前に日本語の理由で拒否する。
    """
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-x5")
    exports = storage.project_dir(project.id) / "exports"
    exports.mkdir(parents=True, exist_ok=True)
    (exports / "speakerA.wav").write_bytes(b"artifact")  # 既定エクスポートの成果物を再現

    res = client.post(
        f"/api/projects/{project.id}/export",
        json={"format": "wav", "output_dir": "speakerA.wav"},
    )
    assert res.status_code == 400
    assert "別の名前" in res.json()["detail"]
    assert "FileExistsError" not in res.json()["detail"]


def test_start_export_label_reusing_existing_directory_is_ok(tmp_path, monkeypatch, client):
    """既存**ディレクトリ**と同名のラベルは従来どおり通る（上書きエクスポートの正常系）。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-x6")
    exports = storage.project_dir(project.id) / "exports"
    (exports / "take7").mkdir(parents=True)
    captured: dict[str, Path] = {}

    def fake_export(project_arg, target, export_format="wav", progress=None, **_kwargs):
        captured["target"] = Path(target)
        return {}

    monkeypatch.setattr(server, "export_project", fake_export)
    res = client.post(
        f"/api/projects/{project.id}/export", json={"format": "wav", "output_dir": "take7"}
    )
    assert res.status_code == 200, res.text
    assert captured["target"] == (exports / "take7").resolve()


def test_start_export_rejects_non_string_output_dir(tmp_path, monkeypatch, client):
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-x4")
    res = client.post(
        f"/api/projects/{project.id}/export", json={"format": "wav", "output_dir": 42}
    )
    assert res.status_code == 400


def test_open_without_original_file_succeeds(tmp_path, monkeypatch, client):
    """normalized_wav さえあれば、元音源が無くても開ける（実機フィードバック）。

    original_file は「後がけ正規化のやり直し」専用で、編集・再生・書き出しは
    normalized_wav で完結する。ユーザーが正規化WAVだけを選んで開いたときに
    400 で弾かれると実運用の摩擦になるため、参照を落として開く。
    """
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    src = tmp_path / "moved"
    src.mkdir()
    _write_wav(src / "speakerA_source.wav", seconds=0.5)
    _write_wav(src / "speakerB_source.wav", seconds=0.5)
    document = {
        "id": "portableopen",
        "name": "portable",
        "tracks": {
            "A": {
                "speaker": "A",
                "original_file": "speakerA_original.mp3",  # 存在しない
                "normalized_wav": "speakerA_source.wav",
            },
            "B": {
                "speaker": "B",
                "original_file": "speakerB_original.mp3",  # 存在しない
                "normalized_wav": "speakerB_source.wav",
            },
        },
        "blocks": [],
        "transcripts": [],
        "overlaps": [],
    }
    response = client.post(
        "/api/projects/open",
        data={"source_dir": str(src)},
        files={
            "project_json": (
                "project.json",
                json.dumps(document).encode("utf-8"),
                "application/json",
            )
        },
    )
    assert response.status_code == 200, response.text
    project = response.json()["project"]
    for speaker in ("A", "B"):
        assert project["tracks"][speaker]["normalized_wav"]  # 実体は引き込まれた
        assert project["tracks"][speaker]["original_file"] == ""  # 参照は落ちる


def test_open_without_normalized_wav_is_rejected(tmp_path, monkeypatch, client):
    """normalized_wav は編集・再生・書き出しの実体なので欠けたら 400（誘導メッセージ）。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    src = tmp_path / "moved"
    src.mkdir()
    document = {
        "id": "portablemissing",
        "name": "portable",
        "tracks": {
            "A": {"speaker": "A", "original_file": "", "normalized_wav": "speakerA_source.wav"},
            "B": {"speaker": "B", "original_file": "", "normalized_wav": "speakerB_source.wav"},
        },
        "blocks": [],
        "transcripts": [],
        "overlaps": [],
    }
    response = client.post(
        "/api/projects/open",
        data={"source_dir": str(src)},
        files={
            "project_json": (
                "project.json",
                json.dumps(document).encode("utf-8"),
                "application/json",
            )
        },
    )
    assert response.status_code == 400
    assert "音源ファイルが見つかりません" in response.json()["detail"]


def test_export_refuses_to_overwrite_its_own_source(tmp_path, monkeypatch):
    """出力先が素材そのものを指す場合は書き出さない（QA指摘）。

    プロジェクトディレクトリ自身を出力先にすると、納品物 speakerA.wav の
    レンダリングが取込元（同名の original_file）を上書きして素材を破壊し、
    同梱バックアップも破壊後のバイト列を掴むため復元もできなくなる。
    """
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-selfout")
    pdir = storage.project_dir(project.id)
    before = (pdir / project.tracks["A"].original_file).read_bytes()

    with pytest.raises(ValueError, match="overwrite the source audio"):
        export_project(project, pdir)

    # 1バイトも壊れていない
    assert (pdir / project.tracks["A"].original_file).read_bytes() == before


def test_open_with_source_dir_only(tmp_path, monkeypatch, client):
    """source_dir だけで開ける（音源をアップロードしない経路）。

    実機フィードバック: UIから project.json だけを選ぶと音源が渡らず
    「音源ファイルが見つかりません」で開けなかった。60分素材の音源は
    223MB×2 になるためアップロードは現実的でなく、フォルダのパスを渡して
    サーバ側で直接読む経路を既定にする。
    """
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    folder = tmp_path / "exports"
    folder.mkdir()
    _write_wav(folder / "speakerA_source.wav", seconds=0.5)
    _write_wav(folder / "speakerB_source.wav", seconds=0.5)
    doc = {
        "id": "srcdironly",
        "name": "folder open",
        "tracks": {
            sp: {"speaker": sp, "original_file": "", "normalized_wav": f"speaker{sp}_source.wav"}
            for sp in ("A", "B")
        },
        "blocks": [],
        "transcripts": [],
        "overlaps": [],
    }
    (folder / "project.json").write_text(json.dumps(doc), encoding="utf-8")

    # project_json を一切送らない
    res = client.post("/api/projects/open", data={"source_dir": str(folder)})
    assert res.status_code == 200, res.text
    payload = res.json()["project"]
    assert payload["name"] == "folder open"
    pdir = storage.project_dir(payload["id"])
    for speaker in ("A", "B"):
        assert (pdir / payload["tracks"][speaker]["normalized_wav"]).is_file()


def test_open_with_source_dir_missing_project_json(tmp_path, monkeypatch, client):
    """フォルダに project.json が無ければ、そう言って 400。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    empty = tmp_path / "empty"
    empty.mkdir()
    res = client.post("/api/projects/open", data={"source_dir": str(empty)})
    assert res.status_code == 400
    assert "project.json がありません" in res.json()["detail"]


def test_open_without_anything_is_rejected(tmp_path, monkeypatch, client):
    """project.json もフォルダも無ければ 400（誘導メッセージ）。"""
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    res = client.post("/api/projects/open", data={})
    assert res.status_code == 400
    assert "フォルダのパスを指定" in res.json()["detail"]


def test_failed_open_leaves_no_empty_project_dir(tmp_path, monkeypatch, client):
    """解決に失敗した open が空のプロジェクトディレクトリを残さない。

    実機で `.podcast_prep/projects/` に中身ゼロのディレクトリが溜まっていた
    （音源が渡らず 400 になった回の残骸）。作成は解決成功後まで遅らせる。
    """
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    doc = {
        "id": "leftoverdir",
        "name": "x",
        "tracks": {
            sp: {"speaker": sp, "original_file": "", "normalized_wav": f"speaker{sp}_gone.wav"}
            for sp in ("A", "B")
        },
        "blocks": [],
        "transcripts": [],
        "overlaps": [],
    }
    res = client.post(
        "/api/projects/open",
        files={
            "project_json": ("project.json", json.dumps(doc).encode("utf-8"), "application/json")
        },
    )
    assert res.status_code == 400
    assert not (tmp_path / "data" / "projects" / "leftoverdir").exists()
