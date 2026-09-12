"""作業フォルダ判定（workdir.validate_workdir）の契約テスト。

レジストリは記録係、妥当性判断は workdir.py という責務分担を固定する。
ここで守るのは主に3つ:

- 正常なフォルダは resolve 済み絶対 Path で返る（`~` 展開・シンボリックリンク解決込み）
- ルート直下・クラウド同期フォルダは日本語メッセージ付きで拒否される
- クラウド判定は「配下」であって「名前の前方一致」ではない（兄弟フォルダは許可）
"""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_prep import workdir
from podcast_prep.workdir import WorkdirError, validate_workdir


# ---------------------------------------------------------------- 正常系


def test_existing_directory_is_returned_resolved(tmp_path):
    target = tmp_path / "Podcast" / "EP31"
    target.mkdir(parents=True)

    result = validate_workdir(str(target))

    assert result == target.resolve()
    assert result.is_absolute()


def test_tilde_is_expanded(tmp_path, monkeypatch):
    """`~/...` はホーム基準で展開される（実ホームに依存させず HOME を差し替え）。"""
    monkeypatch.setenv("HOME", str(tmp_path))
    target = tmp_path / "Podcast"
    target.mkdir()

    assert validate_workdir("~/Podcast") == target.resolve()


def test_symlink_is_resolved_to_real_path(tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)

    assert validate_workdir(str(link)) == real.resolve()


def test_surrounding_whitespace_is_ignored(tmp_path):
    target = tmp_path / "wd"
    target.mkdir()
    assert validate_workdir(f"  {target}  ") == target.resolve()


# ---------------------------------------------------------------- 不正値


@pytest.mark.parametrize("empty", ["", "   ", "\t\n"])
def test_rejects_empty_or_whitespace(empty):
    with pytest.raises(WorkdirError, match="指定されていません"):
        validate_workdir(empty)


@pytest.mark.parametrize("relative", ["relative/path", "./here", "..", "wd"])
def test_rejects_relative_paths(relative):
    with pytest.raises(WorkdirError, match="絶対パス"):
        validate_workdir(relative)


def test_rejects_missing_directory_with_guidance(tmp_path):
    missing = tmp_path / "not-created-yet"
    with pytest.raises(WorkdirError, match="見つかりません") as exc_info:
        validate_workdir(str(missing))
    # どのパスが無かったか・次に何をすべきかがメッセージだけで分かること
    assert str(missing) in str(exc_info.value)
    assert "作成" in str(exc_info.value)


def test_rejects_file_path(tmp_path):
    file_path = tmp_path / "audio.wav"
    file_path.write_bytes(b"RIFF")
    with pytest.raises(WorkdirError, match="フォルダではありません"):
        validate_workdir(str(file_path))


def test_rejects_filesystem_root():
    with pytest.raises(WorkdirError, match="ルート直下"):
        validate_workdir("/")


def test_rejects_direct_child_of_root():
    # 実在チェックが先に走るため、実際にルート直下にある（シンボリックリンクで
    # 別所へ resolve されない）ディレクトリを動的に選ぶ
    candidate = next(
        p for p in sorted(Path("/").iterdir()) if p.is_dir() and not p.is_symlink()
    )
    with pytest.raises(WorkdirError, match="ルート直下"):
        validate_workdir(str(candidate))


# ---------------------------------------------------------------- クラウド同期フォルダ


@pytest.fixture()
def cloud_root(tmp_path, monkeypatch):
    """クラウドルートを tmp_path 配下に差し替える（実ホームに依存しない）。"""
    root = tmp_path / "CloudStorage"
    root.mkdir()
    monkeypatch.setattr(workdir, "_cloud_roots", lambda: [root])
    return root


def test_rejects_cloud_root_itself(cloud_root):
    with pytest.raises(WorkdirError, match="クラウド同期"):
        validate_workdir(str(cloud_root))


def test_rejects_directory_under_cloud_root(cloud_root):
    nested = cloud_root / "Dropbox" / "Podcast"
    nested.mkdir(parents=True)
    with pytest.raises(WorkdirError, match="クラウド同期"):
        validate_workdir(str(nested))


def test_rejects_symlink_that_resolves_into_cloud_root(cloud_root, tmp_path):
    """判定は resolve 後のパスに対して行う（リンク経由の迂回を許さない）。"""
    inside = cloud_root / "Podcast"
    inside.mkdir()
    link = tmp_path / "innocent-looking"
    link.symlink_to(inside, target_is_directory=True)
    with pytest.raises(WorkdirError, match="クラウド同期"):
        validate_workdir(str(link))


def test_allows_sibling_of_cloud_root(cloud_root, tmp_path):
    """境界テスト: クラウドルートの兄弟フォルダは許可される。

    素朴な文字列前方一致（startswith）だと "CloudStorage2" も誤って弾く。
    「配下」判定であることの担保。
    """
    sibling = tmp_path / "CloudStorage2"
    sibling.mkdir()
    assert validate_workdir(str(sibling)) == sibling.resolve()


def test_default_cloud_roots_cover_known_services(tmp_path, monkeypatch):
    """既定のクラウドルート一覧が主要サービスの配置を含むこと（HOME 差し替えで検証）。"""
    monkeypatch.setenv("HOME", str(tmp_path))
    roots = workdir._cloud_roots()
    assert tmp_path / "Library" / "Mobile Documents" in roots  # iCloud
    assert tmp_path / "Library" / "CloudStorage" in roots  # File Provider 系一括
    assert tmp_path / "Dropbox" in roots
    assert tmp_path / "Google Drive" in roots
