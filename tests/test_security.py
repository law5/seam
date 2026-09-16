"""パストラバーサル・ディレクトリ脱出のガードテスト（QA #133 修正分）"""

import os
import tempfile
from pathlib import Path

import pytest

from podcast_prep import config, storage
from podcast_prep.server import ALLOWED_AUDIO_EXTS, _resolve_export_target, _safe_audio_name


def _use_tmp_data_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    # config.data_dir() が環境変数を読む実装を前提。storageはそれ経由でprojects_rootを得る
    return tmp_path


def test_project_dir_rejects_parent_escape(monkeypatch, tmp_path):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    with pytest.raises(ValueError):
        storage.project_dir("../escape")


def test_project_dir_read_path_does_not_mkdir(monkeypatch, tmp_path):
    """QA回帰: 読み取り経路の project_dir が mkdir し、404 probe ごとに空ディレクトリが増えた。"""
    _use_tmp_data_dir(monkeypatch, tmp_path)
    path = storage.project_dir("probe-only")
    assert not path.exists()
    with pytest.raises(FileNotFoundError):
        storage.load_project("probe-only")
    assert not path.exists()


def test_project_dir_create_flag_mkdirs(monkeypatch, tmp_path):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    path = storage.project_dir("write-path", create=True)
    assert path.is_dir()


def test_resolve_project_file_rejects_absolute_outside(monkeypatch, tmp_path):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    pid = "proj1"
    storage.project_dir(pid)
    with pytest.raises(ValueError):
        storage.resolve_project_file(pid, "/etc/passwd")


def test_resolve_project_file_rejects_dotdot(monkeypatch, tmp_path):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    pid = "proj1"
    storage.project_dir(pid)
    with pytest.raises(ValueError):
        storage.resolve_project_file(pid, "../../secret.txt")


def test_resolve_project_file_allows_inside(monkeypatch, tmp_path):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    pid = "proj1"
    pdir = storage.project_dir(pid)
    resolved = storage.resolve_project_file(pid, "speakerA.wav")
    assert resolved == (pdir / "speakerA.wav").resolve()


def test_export_target_strips_path_separators(monkeypatch, tmp_path):
    _use_tmp_data_dir(monkeypatch, tmp_path)
    pid = "proj1"
    storage.project_dir(pid)
    # '../../tmp/evil' を渡してもラベル名(evil)だけ採用され exports 配下に収まる
    target = _resolve_export_target(pid, "../../tmp/evil")
    exports_base = (storage.project_dir(pid) / "exports").resolve()
    assert exports_base in target.parents
    assert target.name == "evil"


def test_export_target_absolute_path_outside_allowed_bases_rejected(monkeypatch, tmp_path):
    """Issue #18: 絶対パスは許可ベース配下のみ。外は ValueError（旧: ラベル化して封じ込め）。

    緩和したのは「許可ベース配下の絶対パスを通す」ところだけで、
    未設定の環境では絶対パスは一切通らない。
    """
    _use_tmp_data_dir(monkeypatch, tmp_path)
    monkeypatch.delenv("SEAM_EXPORT_DIR", raising=False)
    pid = "proj1"
    storage.project_dir(pid)
    with pytest.raises(ValueError):
        _resolve_export_target(pid, "/etc")


def test_export_target_default_is_exports_root(monkeypatch, tmp_path):
    """未指定の書き出し先は exports 直下（Issue #28 で latest サブフォルダを廃止）。"""
    _use_tmp_data_dir(monkeypatch, tmp_path)
    pid = "proj1"
    storage.project_dir(pid)
    target = _resolve_export_target(pid, None)
    assert target == (storage.project_dir(pid) / "exports").resolve()


# ── Issue #18: SEAM_EXPORT_DIR を許可ベースに追加したときの境界 ──


def _use_export_base(monkeypatch, tmp_path):
    base = tmp_path / "Podcast" / "exports"
    base.mkdir(parents=True)
    monkeypatch.setenv("SEAM_EXPORT_DIR", str(base))
    return base.resolve()


def test_export_base_dir_unset_is_none(monkeypatch):
    monkeypatch.delenv("SEAM_EXPORT_DIR", raising=False)
    assert config.export_base_dir() is None


def test_export_base_dir_blank_is_none(monkeypatch):
    monkeypatch.setenv("SEAM_EXPORT_DIR", "   ")
    assert config.export_base_dir() is None


def test_export_target_accepts_absolute_inside_configured_base(monkeypatch, tmp_path):
    _use_tmp_data_dir(monkeypatch, tmp_path / "data")
    base = _use_export_base(monkeypatch, tmp_path)
    storage.project_dir("proj1")
    target = _resolve_export_target("proj1", str(base / "ep12"))
    assert target == base / "ep12"


def test_export_target_accepts_configured_base_itself(monkeypatch, tmp_path):
    _use_tmp_data_dir(monkeypatch, tmp_path / "data")
    base = _use_export_base(monkeypatch, tmp_path)
    storage.project_dir("proj1")
    assert _resolve_export_target("proj1", str(base)) == base


@pytest.mark.parametrize(
    "evil",
    [
        "/etc",
        "/tmp/not-allowed",
        "{base}/../../escape",  # '..' は resolve で潰れ、ベース外に出るので拒否
    ],
)
def test_export_target_rejects_absolute_outside_configured_base(monkeypatch, tmp_path, evil):
    _use_tmp_data_dir(monkeypatch, tmp_path / "data")
    base = _use_export_base(monkeypatch, tmp_path)
    storage.project_dir("proj1")
    with pytest.raises(ValueError):
        _resolve_export_target("proj1", evil.format(base=base))


def test_export_target_rejects_symlink_escape_from_configured_base(monkeypatch, tmp_path):
    """許可ベース内に外部を指すシンボリックリンクを置いても脱出できない。"""
    _use_tmp_data_dir(monkeypatch, tmp_path / "data")
    base = _use_export_base(monkeypatch, tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (base / "link").symlink_to(outside, target_is_directory=True)
    storage.project_dir("proj1")
    with pytest.raises(ValueError):
        _resolve_export_target("proj1", str(base / "link" / "sub"))


def test_export_target_label_still_contained_when_base_configured(monkeypatch, tmp_path):
    """後方互換: 環境変数を設定してもラベル指定は従来どおり exports 配下。"""
    _use_tmp_data_dir(monkeypatch, tmp_path / "data")
    _use_export_base(monkeypatch, tmp_path)
    exports_base = (storage.project_dir("proj1") / "exports").resolve()
    target = _resolve_export_target("proj1", "../../evil")
    assert exports_base in target.parents
    assert target.name == "evil"


# ── Issue #19: 相対解決（resolve_sibling_file）の封じ込め ──


def test_resolve_sibling_file_allows_inside(tmp_path):
    (tmp_path / "speakerA_source.wav").write_bytes(b"x")
    resolved = storage.resolve_sibling_file(tmp_path, "speakerA_source.wav")
    assert resolved == (tmp_path / "speakerA_source.wav").resolve()


@pytest.mark.parametrize("evil", ["../secret.txt", "../../etc/passwd", "sub/../../secret.txt"])
def test_resolve_sibling_file_rejects_dotdot(tmp_path, evil):
    base = tmp_path / "exportdir"
    base.mkdir()
    (tmp_path / "secret.txt").write_text("secret")
    with pytest.raises(ValueError):
        storage.resolve_sibling_file(base, evil)


def test_resolve_sibling_file_rejects_absolute_outside(tmp_path):
    base = tmp_path / "exportdir"
    base.mkdir()
    with pytest.raises(ValueError):
        storage.resolve_sibling_file(base, "/etc/passwd")


def test_resolve_sibling_file_rejects_symlink_escape(tmp_path):
    """base 内のシンボリックリンク経由で外部ファイルを掴めない。"""
    base = tmp_path / "exportdir"
    base.mkdir()
    secret = tmp_path / "secret.txt"
    secret.write_text("secret")
    (base / "innocent.wav").symlink_to(secret)
    with pytest.raises(ValueError):
        storage.resolve_sibling_file(base, "innocent.wav")


def test_resolve_sibling_file_negative_control(tmp_path):
    """ネガティブコントロール: 封じ込め検証を外すと脱出できてしまうことを示す。

    `_ensure_within` を通さない素朴な実装（base / value を resolve するだけ）は
    '..' もシンボリックリンクも素通しする。上の3テストが「実装が効いている」ことを
    見ているのであって、たまたま通っているのではないことの対照実験。
    """
    base = tmp_path / "exportdir"
    base.mkdir()
    secret = tmp_path / "secret.txt"
    secret.write_text("secret")
    (base / "innocent.wav").symlink_to(secret)

    def naive(base_dir: Path, value: str) -> Path:
        return (base_dir / value).resolve()

    assert naive(base, "../secret.txt") == secret.resolve()      # 検証なしなら脱出できる
    assert naive(base, "innocent.wav") == secret.resolve()       # リンクも素通し
    # 実装は同じ入力を拒否する
    with pytest.raises(ValueError):
        storage.resolve_sibling_file(base, "../secret.txt")
    with pytest.raises(ValueError):
        storage.resolve_sibling_file(base, "innocent.wav")


# ── アップロード音声のファイル名サニタイズ + 拡張子許可リスト（wav 取込対応, 2026-08） ──


@pytest.mark.parametrize(
    "raw,expected",
    [
        # 正常系: 許可拡張子はそのまま尊重する（mp3 固定をやめた）
        ("episode.wav", "episode.wav"),
        ("episode.mp3", "episode.mp3"),
        ("episode.WAV", "episode.WAV"),  # 拡張子判定は大小無視、名前は保つ
        ("track.m4a", "track.m4a"),
        ("track.flac", "track.flac"),
        ("track.aiff", "track.aiff"),
        # パストラバーサル: ディレクトリ成分は Path().name で消える
        ("../../etc/passwd.wav", "passwd.wav"),
        ("/etc/shadow.wav", "shadow.wav"),
        ("..%2f..%2fx.wav", ".._2f.._2fx.wav"),  # % と / は許可文字外 → _
        ("a/b/c/evil.mp3", "evil.mp3"),
        # 許可文字以外は _ に潰す（日本語・空白・記号）
        ("収録 A.wav", "_A.wav"),
        ("my file$.wav", "my_file_.wav"),
        # 未知拡張子・拡張子なし・拡張子だけ → 話者既定名へ倒す
        ("payload.exe", "speakerA.wav"),
        ("script.sh", "speakerA.wav"),
        ("noext", "speakerA.wav"),
        (".wav", "speakerA.wav"),  # suffix が空 → 許可されない
        ("", "speakerA.wav"),
        ("...", "speakerA.wav"),
        ("archive.wav.exe", "speakerA.wav"),  # 二重拡張子は最後だけ見る
        ("evil.exe.wav", "evil.exe.wav"),  # 逆は許可（ffmpeg は中身で判定する）
    ],
)
def test_safe_audio_name_sanitizes_and_enforces_extension_allowlist(raw, expected):
    assert _safe_audio_name(raw, "speakerA.wav") == expected


def test_safe_audio_name_never_escapes_project_dir(monkeypatch, tmp_path):
    """サニタイズ後の名前をプロジェクト配下に連結しても脱出しないこと。"""
    _use_tmp_data_dir(monkeypatch, tmp_path)
    pdir = storage.project_dir("proj-upload", create=True)
    for raw in ("../../../etc/passwd.wav", "/etc/shadow.mp3", "..\\..\\win.wav", "....//x.wav"):
        name = _safe_audio_name(raw, "speakerA.wav")
        assert "/" not in name and "\\" not in name
        resolved = (pdir / name).resolve()
        assert pdir.resolve() in resolved.parents


def test_allowed_audio_exts_excludes_executables_and_scripts():
    """許可リストが音声形式だけであること（実行可能・スクリプト拡張子の混入防止）。"""
    for bad in (".exe", ".sh", ".py", ".js", ".html", ".json", ".dylib", ".so", ""):
        assert bad not in ALLOWED_AUDIO_EXTS


# ---------------------------------------------------------------- _prepare_track_audio


def test_prepare_track_audio_rejects_traversal_in_original_file(monkeypatch, tmp_path):
    """永続化文書の original_file がプロジェクト外を指したら音声処理に渡さない。

    `_prepare_track_audio` が `pdir / track.original_file` を直結していたため、
    `PUT /api/projects/{id}/raw` で `"../../secret.wav"` を書き込むと ffmpeg が
    プロジェクト外のファイルを読んで WAV に変換し、`GET /audio` から取り出せた
    （実証済み）。取込経路は `_safe_audio_name` を通るが raw 更新は通らない。

    ここでは音声処理まで行かず、解決の時点で弾かれることを固定する。
    """
    from podcast_prep.server import _prepare_track_audio
    from podcast_prep.audio import AudioProcessingError
    from podcast_prep.models import ProjectState

    data_dir = _use_tmp_data_dir(monkeypatch, tmp_path / "data")
    outside = tmp_path / "secret.wav"
    outside.write_bytes(b"RIFF----WAVEfake")

    project = ProjectState.new("proj-traversal", "t")
    storage.project_dir(project.id, create=True)
    project.tracks["A"].original_file = "../../secret.wav"
    storage.save_project(project)

    with pytest.raises(AudioProcessingError, match="参照が不正"):
        _prepare_track_audio(
            project, "A", "job-test",
            normalize=False, progress_base=0.0, progress_span=1.0,
            message_base="test",
        )
    assert outside.read_bytes() == b"RIFF----WAVEfake", "外部ファイルが触られた"
    assert data_dir.is_dir()


def test_prepare_track_audio_negative_control(monkeypatch, tmp_path):
    """封じ込めを通さない素朴実装なら脱出できることの対照実験。

    「たまたま通っている」のではなく resolve_project_file が効いていることを示す。
    """
    _use_tmp_data_dir(monkeypatch, tmp_path / "data")
    project_id = "proj-nc"
    pdir = storage.project_dir(project_id, create=True)
    outside = tmp_path / "data" / "secret.wav"  # projects/ の外・data_dir 直下
    outside.write_bytes(b"SECRET")

    value = "../../secret.wav"
    naive = (pdir / value).resolve()  # 旧実装と同じ組み立て
    assert naive == outside.resolve(), "素朴実装は脱出できる（対照実験の前提）"
    assert naive.is_file()

    with pytest.raises(ValueError):
        storage.resolve_project_file(project_id, value)  # 実装は拒否する
