"""Origin/Host 検証ミドルウェア（Issue #29）のテスト。

固定するのは4点:

- Origin なしの状態変更は通る（curl / CLI / API 互換）
- 正規オリジン（127.0.0.1 / localhost + 実ポート）の状態変更は通る（フロント互換）
- 外部 Origin の状態変更は 403 で、**副作用ゼロ**（プロジェクト未作成・未登録）
- GET は Origin があっても通り（応答は SOP で読めないため対象外）、
  不正 Host は GET を含む全メソッドで 403（DNS rebinding は応答が読める攻撃）

conftest の `_allow_testclient_host` が PODCAST_PREP_HOST=testserver を入れるので、
Host 検証を試すテストは monkeypatch で明示的に上書き・削除してから行う。
"""

from __future__ import annotations

import io
import struct
import wave

import pytest
from fastapi.testclient import TestClient

from podcast_prep import registry, server
from podcast_prep.config import data_dir

EVIL_ORIGIN = "http://evil.example"


@pytest.fixture
def client():
    return TestClient(server.app)


@pytest.fixture(autouse=True)
def _tmp_data(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_PREP_DATA_DIR", str(tmp_path / "data"))


@pytest.fixture(autouse=True)
def _fixed_port(monkeypatch):
    """開発者シェルの PODCAST_PREP_PORT に依存しないよう既定 4520 に固定する。"""
    monkeypatch.delenv("PODCAST_PREP_PORT", raising=False)


@pytest.fixture(autouse=True)
def _stub_import(monkeypatch):
    """ffmpeg 依存の取込ジョブを止める。テストが見るのはガードの通過/遮断だけ。"""
    monkeypatch.setattr(server, "_run_import", lambda pid, jid, normalize=True: None)


def _wav_bytes(seconds: float = 0.1, rate: int = 8000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(struct.pack("<h", 1000) * int(seconds * rate))
    return buf.getvalue()


def _post_project(client, headers=None, workdir=None):
    data = {"name": "EP31"}
    if workdir is not None:
        data["workdir"] = workdir
    return client.post(
        "/api/projects",
        data=data,
        files={
            "speaker_a": ("a.wav", _wav_bytes(), "audio/wav"),
            "speaker_b": ("b.wav", _wav_bytes(), "audio/wav"),
        },
        headers=headers or {},
    )


# ---------------------------------------------------------------- Origin 検証


def test_post_without_origin_passes(client):
    """Origin なし = curl / CLI / API クライアント。従来どおり通る。"""
    res = _post_project(client)
    assert res.status_code == 200


@pytest.mark.parametrize("hostname", ["127.0.0.1", "localhost"])
def test_post_with_own_origin_passes(client, hostname):
    """正規オリジン（実バインドポート付き）はフロントの fetch が付けてくる形。"""
    res = _post_project(client, headers={"Origin": f"http://{hostname}:4520"})
    assert res.status_code == 200


def test_post_with_foreign_origin_is_403_and_no_side_effects(client, tmp_path):
    """悪意あるページからの simple request（本 Issue の本丸）。

    403 で断り、プロジェクトはどこにも作られない（レジストリ未登録・
    指定フォルダ無傷・従来配置にも何も落ちない = 副作用ゼロ）。
    """
    wd = tmp_path / "victim-folder"
    wd.mkdir()

    res = _post_project(client, headers={"Origin": EVIL_ORIGIN}, workdir=str(wd))

    assert res.status_code == 403
    assert "別のサイト" in res.json()["detail"]
    assert registry.all_entries() == {}
    assert list(wd.iterdir()) == []
    projects = data_dir() / "projects"
    assert not projects.exists() or list(projects.iterdir()) == []


@pytest.mark.parametrize(
    "origin",
    [
        "null",  # サンドボックス iframe / data: URL
        "http://127.0.0.1:9999",  # ホストは合っているがポートが違う
        "http://127.0.0.1",  # ポート省略（既定80扱い）は 4520 と別オリジン
        "https://127.0.0.1:4520",  # スキーム違いも別オリジン
        "http://evil.example:4520",
    ],
)
def test_post_with_non_own_origin_variants_are_403(client, origin):
    res = _post_project(client, headers={"Origin": origin})
    assert res.status_code == 403


@pytest.mark.parametrize("method", ["put", "delete"])
def test_other_state_changing_methods_are_guarded(client, method):
    """対象は POST に限らず非安全メソッド全部。"""
    res = getattr(client, method)(
        "/api/projects/whatever", headers={"Origin": EVIL_ORIGIN}
    )
    assert res.status_code == 403


def test_get_with_foreign_origin_passes(client):
    """読み取りは対象外（クロスオリジンでも応答は SOP で読めない）。"""
    res = client.get("/api/system/paths", headers={"Origin": EVIL_ORIGIN})
    assert res.status_code == 200


def test_custom_bound_host_origin_is_allowed(client, monkeypatch):
    """PODCAST_PREP_HOST で別バインドしている場合はそのオリジンも正規扱い。"""
    monkeypatch.setenv("PODCAST_PREP_HOST", "192.168.10.5")
    # Host も同じバインド先で来る想定
    res = _post_project(
        client,
        headers={"Origin": "http://192.168.10.5:4520", "Host": "192.168.10.5:4520"},
    )
    assert res.status_code == 200


# ---------------------------------------------------------------- Host 検証


@pytest.fixture
def _real_host_guard(monkeypatch):
    """conftest の testserver 許可を外し、本番同等（127.0.0.1 バインド）にする。"""
    monkeypatch.delenv("PODCAST_PREP_HOST", raising=False)


@pytest.mark.usefixtures("_real_host_guard")
@pytest.mark.parametrize(
    "host",
    [
        "evil.example",  # DNS rebinding: 攻撃者ドメインが 127.0.0.1 を指す
        "evil.example:4520",
        "127.0.0.1:9999",  # ポート偽装
        "127.0.0.1.evil.example",  # プレフィックス偽装
        "0.0.0.0",  # バインド指定であって正規のクライアント Host ではない
        "",  # 空 Host
        "::1:4520",  # ブラケット無しの生 IPv6 は不正形式
    ],
)
def test_bad_host_is_403_even_for_get(client, host):
    res = client.get("/api/system/paths", headers={"Host": host})
    assert res.status_code == 403
    assert "Host" in res.json()["detail"]


@pytest.mark.usefixtures("_real_host_guard")
@pytest.mark.parametrize(
    "host",
    [
        "127.0.0.1:4520",
        "localhost:4520",
        "LocalHost:4520",  # ホスト名は大文字小文字を区別しない
        "127.0.0.1",  # ポート省略は許容（ホスト名が合っていれば十分）
        "[::1]:4520",
    ],
)
def test_loopback_host_passes(client, host):
    res = client.get("/api/system/paths", headers={"Host": host})
    assert res.status_code == 200


@pytest.mark.usefixtures("_real_host_guard")
def test_bad_host_blocks_state_change_too(client, tmp_path):
    wd = tmp_path / "victim"
    wd.mkdir()
    res = _post_project(client, headers={"Host": "evil.example:4520"}, workdir=str(wd))
    assert res.status_code == 403
    assert registry.all_entries() == {}
    assert list(wd.iterdir()) == []


def test_bind_all_still_allows_loopback_but_not_wildcard(client, monkeypatch):
    """PODCAST_PREP_HOST=0.0.0.0（全バインド）でも 0.0.0.0 という Host は許可しない。"""
    monkeypatch.setenv("PODCAST_PREP_HOST", "0.0.0.0")
    ok = client.get("/api/system/paths", headers={"Host": "127.0.0.1:4520"})
    assert ok.status_code == 200
    ng = client.get("/api/system/paths", headers={"Host": "0.0.0.0:4520"})
    assert ng.status_code == 403


# ---------------------------------------------------------------- ヘルパ単体


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("127.0.0.1:4520", ("127.0.0.1", "4520")),
        ("localhost", ("localhost", None)),
        ("[::1]:4520", ("::1", "4520")),
        ("[::1]", ("::1", None)),
        ("127.0.0.1:", None),  # 空ポート
        ("127.0.0.1:abc", None),  # 数字でないポート
        ("::1:4520", None),  # ブラケット無し IPv6
        ("[::1", None),  # 閉じブラケット無し
        ("", None),
        (":4520", None),  # ホスト名なし
    ],
)
def test_split_host_header(value, expected):
    assert server._split_host_header(value) == expected
