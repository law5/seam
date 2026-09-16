"""プロジェクトレジストリ（作業フォルダの記録）の契約テスト。

レジストリは「ID → 実体の場所」だけを持ち、`project_dir()` の純関数性を保つ。
ここで固定するのは主に3つ:

- 未登録なら従来配置へフォールバックする（既存プロジェクトが無変更で開ける）
- 登録済みならその作業フォルダを指し、実体もそこに置かれる
- 作業フォルダが可変になっても封じ込め（_ensure_within）の強度は落ちない
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_prep import registry, storage
from podcast_prep.config import data_dir
from podcast_prep.models import ProjectState


@pytest.fixture()
def tmp_data(monkeypatch, tmp_path):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    registry.reset_cache()
    return tmp_path


# ---------------------------------------------------------------- フォールバック


def test_unregistered_project_falls_back_to_legacy_layout(tmp_data):
    """レジストリに無い ID は従来配置 data_dir()/projects/{id} を指す。

    レジストリ導入前に作られたプロジェクトが無変更で開けることの担保。
    """
    path = storage.project_dir("proj-legacy")
    assert data_dir().resolve() in path.resolve().parents
    assert path.name == "proj-legacy"


def test_legacy_layout_still_blocks_id_traversal(tmp_data):
    """従来配置では ID に '..' が混ざっても projects_root の外へ出ない。"""
    with pytest.raises(ValueError):
        storage.project_dir("../escape")


# ---------------------------------------------------------------- 登録


def test_registered_root_is_used_as_project_dir(tmp_data):
    workdir = tmp_data / "Podcast" / "EP31"
    workdir.mkdir(parents=True)
    registry.register("proj-ext", workdir)

    assert storage.project_dir("proj-ext").resolve() == workdir.resolve()


def test_save_writes_into_registered_root(tmp_data):
    """保存先が作業フォルダになり、従来配置には何も作られない。"""
    workdir = tmp_data / "Podcast" / "EP31"
    workdir.mkdir(parents=True)
    registry.register("proj-ext", workdir)

    storage.save_project(ProjectState.new("proj-ext", "EP31"))

    assert (workdir / "project.json").is_file()
    assert not (data_dir() / "projects" / "proj-ext").exists()
    assert storage.load_project("proj-ext").name == "EP31"


def test_project_json_does_not_contain_absolute_root(tmp_data):
    """project.json に作業フォルダの絶対パスを書かない（可搬性・Issue #19 の原則）。

    絶対パスを文書に埋めると、フォルダごと移動した瞬間に参照が切れる。
    場所の情報はレジストリ側にだけ持つ。
    """
    workdir = tmp_data / "Podcast" / "EP31"
    workdir.mkdir(parents=True)
    registry.register("proj-ext", workdir)
    storage.save_project(ProjectState.new("proj-ext", "EP31"))

    doc = json.loads((workdir / "project.json").read_text(encoding="utf-8"))
    assert "root" not in doc
    assert str(workdir) not in json.dumps(doc, ensure_ascii=False)


def test_register_requires_absolute_path(tmp_data):
    with pytest.raises(ValueError, match="absolute"):
        registry.register("proj-rel", Path("relative/dir"))


def test_register_merges_fields_and_update_partially_edits(tmp_data):
    workdir = tmp_data / "wd"
    workdir.mkdir()
    registry.register("p", workdir, name="EP1", root_chosen_via="dialog")
    registry.register("p", workdir, last_opened_at="2026-08-06T00:00:00Z")

    entry = registry.entry_for("p")
    assert entry["name"] == "EP1"  # 既存フィールドは維持
    assert entry["root_chosen_via"] == "dialog"
    assert entry["last_opened_at"] == "2026-08-06T00:00:00Z"

    assert registry.update("p", name="EP1 改")["name"] == "EP1 改"
    assert registry.update("missing", name="x") is None


def test_unregister_removes_entry_but_not_files(tmp_data):
    """レジストリから外してもディスク上のファイルは消さない。

    外付けドライブのアンマウント等で一時的に見えないだけの可能性があるため、
    実体の削除はユーザーの明示操作に限る。
    """
    workdir = tmp_data / "wd"
    workdir.mkdir()
    (workdir / "project.json").write_text("{}", encoding="utf-8")
    registry.register("p", workdir)

    assert registry.unregister("p") is True
    assert registry.unregister("p") is False
    assert (workdir / "project.json").is_file()
    # 登録が消えたので従来配置へ戻る
    assert data_dir().resolve() in storage.project_dir("p").resolve().parents


# ---------------------------------------------------------------- 封じ込め


def test_containment_holds_for_registered_root(tmp_data):
    """作業フォルダが可変になっても、その外へは出られない。"""
    workdir = tmp_data / "Podcast" / "EP31"
    workdir.mkdir(parents=True)
    secret = tmp_data / "secret.wav"
    secret.write_bytes(b"SECRET")
    registry.register("proj-ext", workdir)

    with pytest.raises(ValueError):
        storage.resolve_project_file("proj-ext", "../../secret.wav")
    with pytest.raises(ValueError):
        storage.resolve_project_file("proj-ext", str(secret))

    inside = storage.resolve_project_file("proj-ext", "speakerA.wav")
    assert inside.parent.resolve() == workdir.resolve()


def test_containment_negative_control_for_registered_root(tmp_data):
    """封じ込めを通さない素朴実装なら脱出できることの対照実験。

    「たまたま通っている」のではなく _ensure_within が効いていることを示す。
    可変 root でも強度が落ちていないことの証明。
    """
    workdir = tmp_data / "Podcast" / "EP31"
    workdir.mkdir(parents=True)
    secret = tmp_data / "secret.wav"
    secret.write_bytes(b"SECRET")
    registry.register("proj-ext", workdir)

    naive = (workdir / "../../secret.wav").resolve()
    assert naive == secret.resolve(), "素朴実装は脱出できる（対照実験の前提）"
    assert naive.is_file()

    with pytest.raises(ValueError):
        storage.resolve_project_file("proj-ext", "../../secret.wav")


# ---------------------------------------------------------------- 破損耐性


def test_broken_registry_json_does_not_break_startup(tmp_data):
    """レジストリが壊れていても起動でき、従来配置へ落ちる。"""
    data_dir().mkdir(parents=True, exist_ok=True)
    (data_dir() / registry.REGISTRY_FILENAME).write_text("{ not json", encoding="utf-8")
    registry.reset_cache()

    assert registry.all_entries() == {}
    assert data_dir().resolve() in storage.project_dir("p").resolve().parents


@pytest.mark.parametrize(
    "bad_root",
    [None, 123, "", "relative/path", "with\0null", [], {}],
)
def test_invalid_entries_are_ignored_individually(tmp_data, bad_root):
    """壊れたエントリはそれだけ捨て、他のエントリは生かす。

    1エントリの破損でアプリ全体が使えなくなるのは割に合わない。
    """
    good = tmp_data / "good"
    good.mkdir()
    data_dir().mkdir(parents=True, exist_ok=True)
    doc = {
        "schema_version": 1,
        "projects": {
            "bad": {"root": bad_root},
            "good": {"root": str(good)},
        },
    }
    (data_dir() / registry.REGISTRY_FILENAME).write_text(
        json.dumps(doc, ensure_ascii=False), encoding="utf-8"
    )
    registry.reset_cache()

    entries = registry.all_entries()
    assert "bad" not in entries
    assert entries["good"]["root"] == str(good)
    # 捨てられた側は従来配置へフォールバックする
    assert data_dir().resolve() in storage.project_dir("bad").resolve().parents


def test_corrupted_registry_rejects_writes_until_repaired(tmp_data):
    """全体がパース不能なら書き込み系は拒否する（空を書き戻すと正規データが消える）。

    読み取りは従来どおり寛容（test_broken_registry_json_does_not_break_startup）。
    ファイルが修復されたら mtime 追随で自動的に書けるようになる。
    """
    wd = tmp_data / "wd"
    wd.mkdir()
    data_dir().mkdir(parents=True, exist_ok=True)
    path = data_dir() / registry.REGISTRY_FILENAME
    corrupted = "{ not json"
    path.write_text(corrupted, encoding="utf-8")
    registry.reset_cache()

    with pytest.raises(registry.RegistryCorruptedError):
        registry.register("p", wd)
    with pytest.raises(registry.RegistryCorruptedError):
        registry.update("p", name="x")
    with pytest.raises(registry.RegistryCorruptedError):
        registry.unregister("p")
    # 破損したファイルには1バイトも触れていない
    assert path.read_text(encoding="utf-8") == corrupted

    # 修復（退避 → 空レジストリ）したら自動的に書き込み可能へ戻る
    path.write_text(
        json.dumps({"schema_version": 1, "projects": {}}), encoding="utf-8"
    )
    entry = registry.register("p", wd)
    assert entry["root"] == str(wd.resolve())
    assert registry.entry_for("p") is not None


# ---------------------------------------------------------------- 純関数性


@pytest.mark.parametrize("payload", ["[]", "null", '{"projects": []}'])
def test_wrong_shape_registry_rejects_writes_until_repaired(tmp_data, payload):
    """有効な JSON でも形状不正（top-level 非 dict / projects 非 dict）は破損扱い。

    corrupted=False のまま空扱いにすると、次の register が「空」を正規の形で
    書き戻して元ファイルを静かに消す。読み取りは従来どおり空で寛容
    （起動を阻害しない）、書き込みだけ拒否する。
    """
    wd = tmp_data / "wd"
    wd.mkdir()
    data_dir().mkdir(parents=True, exist_ok=True)
    path = data_dir() / registry.REGISTRY_FILENAME
    path.write_text(payload, encoding="utf-8")
    registry.reset_cache()

    # 読み取りは空扱い（起動を阻害しない）
    assert registry.all_entries() == {}
    with pytest.raises(registry.RegistryCorruptedError):
        registry.register("p", wd)
    with pytest.raises(registry.RegistryCorruptedError):
        registry.update("p", name="x")
    with pytest.raises(registry.RegistryCorruptedError):
        registry.unregister("p")
    # 形状不正のファイルには1バイトも触れていない
    assert path.read_text(encoding="utf-8") == payload

    # 正規形状へ修復したら自動的に書き込み可能へ戻る
    path.write_text(
        json.dumps({"schema_version": 1, "projects": {}}), encoding="utf-8"
    )
    entry = registry.register("p", wd)
    assert entry["root"] == str(wd.resolve())
    assert registry.entry_for("p") is not None


def test_project_dir_has_no_side_effects_on_registry(tmp_data):
    """`project_dir()` はレジストリを書き換えない。

    ここに last_opened_at 更新などの副作用を入れると、読み取りのたびに
    mtime が動いてキャッシュが毎回無効化される。
    """
    workdir = tmp_data / "wd"
    workdir.mkdir()
    registry.register("p", workdir)
    path = data_dir() / registry.REGISTRY_FILENAME
    before = path.stat().st_mtime_ns

    for _ in range(20):
        storage.project_dir("p")

    assert path.stat().st_mtime_ns == before


def test_project_dir_does_not_create_directories_when_reading(tmp_data):
    """読み取り経路は mkdir しない（既存の QA 指摘の維持）。"""
    workdir = tmp_data / "not-created-yet"
    registry.register("p", workdir)

    storage.project_dir("p")
    assert not workdir.exists()

    storage.project_dir("p", create=True)
    assert workdir.is_dir()


def test_registry_cache_follows_external_rewrite(tmp_data):
    """外部から projects.json が書き換わったらキャッシュが追随する。"""
    a = tmp_data / "a"
    a.mkdir()
    b = tmp_data / "b"
    b.mkdir()
    registry.register("p", a)
    assert storage.project_dir("p").resolve() == a.resolve()

    path = data_dir() / registry.REGISTRY_FILENAME
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc["projects"]["p"]["root"] = str(b)
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")

    assert storage.project_dir("p").resolve() == b.resolve()
