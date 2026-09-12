"""プロジェクトの作業フォルダを記録するレジストリ。

## なぜレジストリなのか

作業フォルダをユーザーが選べるようにすると、プロジェクトの実体が
`data_dir()/projects/{id}/` から任意の場所へ移る。この「ID → 実体の場所」の
対応をどこかに持つ必要がある。

選択肢は2つあった:

1. `ProjectState` に `root` フィールドを持たせて引き回す
2. `data_dir()/projects.json` にレジストリを置き、`project_dir(id)` の
   純関数性（引数だけで決まる）を保つ

**採ったのは 2**。理由は影響半径で、`project_dir()` は 17 箇所から呼ばれ、
`ProjectState.new(...)` を直接使うテストも多数ある。1 を採るとその全部が
シグネチャ変更に巻き込まれる。2 なら呼び出し側は 1 行も変わらない。

もう一つ、`root` を **project.json に書かない**のも意図的な判断。絶対パスを
文書に埋めるとフォルダごと移動した瞬間に参照が切れる。Issue #19 で確立した
「参照は必ず相対」の原則に反するので、場所の情報はレジストリ側にだけ持つ。

## スレッド安全性

取込・正規化・文字起こし・書き出しはバックグラウンドスレッドで走り、
`load_project(project_id)` を ID だけで呼ぶ。したがってレジストリは
プロセス全体から見えている必要がある。

`project_dir()` は高頻度で呼ばれる（`GET /peaks` のたび等）ので、毎回
JSON を読むのは避けてインメモリにキャッシュし、`projects.json` の mtime が
変わったときだけ再読込する。単一プロセス前提（uvicorn の --workers は
使っていない）なのでファイルロックは不要。

**`project_dir()` に副作用を持たせてはいけない。** last_opened_at の更新などを
そこでやると、読み取りのたびにレジストリが書かれて mtime が動き、キャッシュが
毎回無効化される。更新は明示的な呼び出し側で行う。
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from .config import data_dir

REGISTRY_FILENAME = "projects.json"
SCHEMA_VERSION = 1


class RegistryCorruptedError(RuntimeError):
    """projects.json 全体がパース不能な状態での書き込み要求。

    読み取りは空扱いで寛容に流す（起動を阻害しない・従来配置へフォールバック）が、
    その空を register/update/unregister が書き戻すと正規データごと上書きして
    しまうため、書き込み系だけはこの例外で拒否する。
    """


_CORRUPTED_DETAIL = (
    "レジストリ（projects.json）が破損しています。"
    "修復または退避してから再試行してください"
)

# キャッシュは data_dir ごとに持つ。テストは monkeypatch で
# PODCAST_PREP_DATA_DIR を差し替えるため、キーに含めないと前のテストの
# 内容を掴んだままになる（テスト間干渉の温床）。
# 値は (mtime_ns, entries, corrupted)。corrupted は「全体がパース不能」の印で、
# mtime と同じライフサイクルで更新される = ファイルが修復されれば自動で解除。
_lock = threading.RLock()
_cache: dict[Path, tuple[int, dict[str, dict[str, Any]], bool]] = {}


def registry_path() -> Path:
    return data_dir() / REGISTRY_FILENAME


def _mtime_ns(path: Path) -> int:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return -1


def _sanitize_entry(project_id: str, raw: Any) -> dict[str, Any] | None:
    """1エントリを検証して正規化する。壊れていれば None（そのエントリだけ捨てる）。

    レジストリ全体を落とさないのが要点。1エントリの破損でアプリが起動不能に
    なるのは割に合わない。改竄対策ではなく破損耐性のための検証。
    """
    if not isinstance(raw, dict):
        return None
    root = raw.get("root")
    if not isinstance(root, str) or not root or "\0" in root:
        return None
    root_path = Path(root)
    if not root_path.is_absolute():
        # 相対パスはサーバの cwd 依存で意味が定まらない
        return None
    entry = dict(raw)
    entry["id"] = project_id
    entry["root"] = str(root_path)
    return entry


def _load_locked() -> dict[str, dict[str, Any]]:
    """ロック取得済み前提の読み込み。mtime が変わっていなければキャッシュを返す。"""
    base = data_dir()
    path = base / REGISTRY_FILENAME
    mtime = _mtime_ns(path)
    cached = _cache.get(base)
    if cached is not None and cached[0] == mtime:
        return cached[1]

    entries: dict[str, dict[str, Any]] = {}
    corrupted = False
    if mtime != -1:
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            # 破損していても起動はできるべき。読み取りは空として扱う。
            # ただし書き込み系はこの印を見て拒否する（空を書き戻すと
            # 正規データごと消えるため）。「1エントリだけ破損」は
            # _sanitize_entry 側で落ちるだけなので、ここには来ない。
            doc = None
            corrupted = True
        if not corrupted:
            raw_projects = doc.get("projects") if isinstance(doc, dict) else None
            if not isinstance(raw_projects, dict):
                # パースは通ったが形状が不正（`[]` / `null` / `{"projects": []}` 等）。
                # パース不能と同じ扱い: 読み取りは空（起動を阻害しない）、書き込みは
                # 拒否する。ここを corrupted にしないと、次の register が「空」を
                # 正規の形で書き戻し、元ファイルの内容を静かに消してしまう。
                # 境界: 破損扱いは top-level と projects キーの**形状**まで。
                # projects 配下の個別エントリの破損は _sanitize_entry がその
                # エントリだけ捨てる（全体の書き込みは止めない）。
                corrupted = True
            else:
                for project_id, raw in raw_projects.items():
                    if not isinstance(project_id, str) or not project_id:
                        continue
                    entry = _sanitize_entry(project_id, raw)
                    if entry is not None:
                        entries[project_id] = entry

    _cache[base] = (mtime, entries, corrupted)
    return entries


def _ensure_writable_locked() -> None:
    """ロック取得済み前提。全体破損を検知していたら書き込みを拒否する。"""
    _load_locked()
    if _cache[data_dir()][2]:
        raise RegistryCorruptedError(_CORRUPTED_DETAIL)


def _save_locked(entries: dict[str, dict[str, Any]]) -> None:
    """ロック取得済み前提の書き込み。"""
    # 循環 import を避けるためここで import する
    # （storage が registry を使い、registry は storage の書き込みだけを使う）
    from .storage import atomic_write_text

    base = data_dir()
    base.mkdir(parents=True, exist_ok=True)
    path = base / REGISTRY_FILENAME
    doc = {"schema_version": SCHEMA_VERSION, "projects": entries}
    atomic_write_text(path, json.dumps(doc, ensure_ascii=False, indent=2))
    _cache[base] = (_mtime_ns(path), entries, False)


def all_entries() -> dict[str, dict[str, Any]]:
    """全エントリのコピーを返す（呼び出し側の変更がキャッシュを汚さない）。"""
    with _lock:
        return {k: dict(v) for k, v in _load_locked().items()}


def entry_for(project_id: str) -> dict[str, Any] | None:
    with _lock:
        found = _load_locked().get(project_id)
        return dict(found) if found is not None else None


def root_for(project_id: str) -> Path | None:
    """プロジェクトの作業フォルダ。未登録なら None（呼び出し側が従来配置へフォールバック）。"""
    entry = entry_for(project_id)
    if entry is None:
        return None
    return Path(entry["root"])


def register(project_id: str, root: Path, **fields: Any) -> dict[str, Any]:
    """作業フォルダを登録する（既存エントリがあればマージ更新）。

    `root` は呼び出し側で検証済みの絶対パスであること。ここは記録係で、
    「そのフォルダを使ってよいか」の判断はしない（workdir.py の責務）。
    """
    # 相対パスは resolve() で cwd 基準に絶対化されてしまうため、**resolve の前に**
    # 弾く。サーバの起動ディレクトリ次第で指す先が変わる値を記録してはいけない。
    expanded = Path(root).expanduser()
    if not expanded.is_absolute():
        raise ValueError(f"root must be an absolute path: {root}")
    resolved = expanded.resolve()
    with _lock:
        _ensure_writable_locked()
        entries = dict(_load_locked())
        entry = dict(entries.get(project_id) or {})
        entry.update(fields)
        entry["id"] = project_id
        entry["root"] = str(resolved)
        entries[project_id] = entry
        _save_locked(entries)
        return dict(entry)


def update(project_id: str, **fields: Any) -> dict[str, Any] | None:
    """登録済みエントリの一部を更新する。未登録なら None を返して何もしない。"""
    with _lock:
        _ensure_writable_locked()
        entries = dict(_load_locked())
        current = entries.get(project_id)
        if current is None:
            return None
        entry = dict(current)
        entry.update(fields)
        entry["id"] = project_id
        entries[project_id] = entry
        _save_locked(entries)
        return dict(entry)


def unregister(project_id: str) -> bool:
    """レジストリからエントリを消す。**ディスク上のファイルには触らない。**"""
    with _lock:
        _ensure_writable_locked()
        entries = dict(_load_locked())
        if project_id not in entries:
            return False
        del entries[project_id]
        _save_locked(entries)
        return True


def reset_cache() -> None:
    """キャッシュを捨てる。テストで data_dir を差し替えるときに使う。"""
    with _lock:
        _cache.clear()
