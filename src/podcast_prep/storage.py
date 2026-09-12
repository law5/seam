from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from . import registry
from .config import data_dir
from .models import ProjectState, utc_now_iso


def projects_root() -> Path:
    root = data_dir() / "projects"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _ensure_within(base: Path, candidate: Path) -> Path:
    """candidate が base 配下に収まることを保証する（パストラバーサル防止）"""
    base_resolved = base.resolve()
    resolved = candidate.resolve()
    if resolved != base_resolved and base_resolved not in resolved.parents:
        raise ValueError(f"path escapes allowed directory: {candidate}")
    return resolved


def project_dir(project_id: str, *, create: bool = False) -> Path:
    """プロジェクトディレクトリのパスを返す。

    create=True の書き込み経路（保存・取込）でのみ mkdir する。読み取り経路は
    パス解決だけ行う（QA指摘: 404 probe のたびに空ディレクトリが生成されていた）。

    解決順:
    1. レジストリに作業フォルダが登録されていればそれを返す
    2. 無ければ従来配置 `data_dir()/projects/{id}` にフォールバックする

    2 があるので、レジストリ導入前に作られたプロジェクトは無変更で開ける。

    **レジストリ経路では `_ensure_within` を掛けてはいけない。** 従来配置での
    `_ensure_within(projects_root(), root/id)` は「id に `..` が混ざっても
    projects_root の外へ出さない」ためのもので、base と candidate が親子関係に
    ある前提で成り立つ。レジストリの root はそれ自体が基準点なので、
    `_ensure_within(projects_root(), root)` は必ず失敗する。root の妥当性は
    登録時とロード時に検証済み（registry._sanitize_entry / workdir の判定）。

    この関数は**純関数に保つ**こと。last_opened_at の更新などの副作用をここに
    入れると、読み取りのたびにレジストリが書かれて mtime が動き、キャッシュが
    毎回無効化される（registry モジュールの docstring 参照）。
    """
    registered = registry.root_for(project_id)
    if registered is not None:
        path = registered
    else:
        root = projects_root()
        # project_id に '..' やスラッシュが混ざっても projects_root の外に出さない
        path = _ensure_within(root, root / project_id)
    if create:
        path.mkdir(parents=True, exist_ok=True)
    return path


def project_json_path(project_id: str) -> Path:
    return project_dir(project_id) / "project.json"


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """同ディレクトリの一時ファイル + os.replace でアトミックに書き込む。

    途中失敗（ディスクフル・プロセス中断）で部分ファイルが最終パスに残らない
    （QA指摘: 破損ピークサイドカー・project.json 全損の防止）。
    """
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def atomic_write_text(path: Path, text: str) -> None:
    atomic_write_bytes(path, text.encode("utf-8"))


def save_project(project: ProjectState) -> None:
    """project.json へ全量書き出し。updated_at は書き込み直前にここでスタンプする
    （to_dict は再スタンプしない — GET 等の読み取りで値が変わらないようにするため）。"""
    path = project_dir(project.id, create=True) / "project.json"
    project.updated_at = utc_now_iso()
    atomic_write_text(path, json.dumps(project.to_dict(), ensure_ascii=False, indent=2))


def save_project_dict(project: dict[str, Any]) -> None:
    """raw dict の書き出し。updated_at を書き込み直前にスタンプする
    （呼び出し元の dict を直接更新するので、レスポンスにも保存値が反映される）。"""
    project_id = str(project["id"])
    path = project_dir(project_id, create=True) / "project.json"
    project["updated_at"] = utc_now_iso()
    atomic_write_text(path, json.dumps(project, ensure_ascii=False, indent=2))


def load_project(project_id: str) -> ProjectState:
    path = project_json_path(project_id)
    return ProjectState.from_dict(json.loads(path.read_text(encoding="utf-8")))


def load_project_dict(project_id: str) -> dict[str, Any]:
    path = project_json_path(project_id)
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_project_file(project_id: str, value: str) -> Path:
    """プロジェクトディレクトリ配下のファイルのみ解決する。

    絶対パス・'..' によるディレクトリ外参照は拒否（任意ファイル読み取り防止）。
    """
    pdir = project_dir(project_id)
    path = Path(value)
    if path.is_absolute():
        # 絶対パスでもプロジェクトディレクトリ配下なら許可、外なら拒否
        return _ensure_within(pdir, path)
    return _ensure_within(pdir, pdir / path)


def resolve_sibling_file(base_dir: Path, value: str) -> Path:
    """`base_dir` 配下のファイルとして `value` を解決する（Issue #19 の相対解決）。

    エクスポートされた project.json を「フォルダごと移動」しても開けるようにするため、
    project.json と同階層（= base_dir）からの相対参照を解決する経路。

    セキュリティ境界は resolve_project_file と同一の `_ensure_within` を使う:
    - `..` を含む値は resolve() 後に base_dir の外へ出るため ValueError
    - シンボリックリンクも resolve() が実体まで潰したうえで包含判定するので、
      リンク経由の脱出も ValueError
    - 絶対パスも base_dir 配下でなければ ValueError
    ここを緩めると「開く」経由で任意ファイルをプロジェクトへ取り込めてしまう。
    """
    base_resolved = base_dir.resolve()
    path = Path(value)
    if path.is_absolute():
        return _ensure_within(base_resolved, path)
    return _ensure_within(base_resolved, base_resolved / path)


def copy_into_project(project_id: str, src: Path, dest_name: str) -> str:
    dest = project_dir(project_id, create=True) / dest_name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dest)
    return dest.name
