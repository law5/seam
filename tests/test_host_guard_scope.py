"""Host / Origin ガードが「何を防ぎ、何を防がないか」を固定する。

このガードはブラウザ経由の攻撃（DNS rebinding / CSRF）への緩和策であって、
アクセス制御ではない。非ブラウザ経路（curl・スクリプト）は Host を詐称でき、
Origin を送らないことで Origin 検証も素通りする——これは意図的な設計で、
SECURITY.md にそう明記している。

「Host 詐称が通る」テストが落ちたら、ガードが強化されたということ。
その場合は SECURITY.md の記述も併せて更新すること（文書だけが古くなると、
読者が実際より弱い前提で運用してしまう）。
"""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client_bound_to_all(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """SEAM_HOST=0.0.0.0（全インターフェースにバインド）した状態のクライアント。"""
    monkeypatch.setenv("SEAM_HOST", "0.0.0.0")
    import podcast_prep.config as config
    import podcast_prep.server as server

    importlib.reload(config)
    importlib.reload(server)
    return TestClient(server.app)


# ── 防げるもの ──


def test_DNS_rebinding_は拒否する(client_bound_to_all):
    r = client_bound_to_all.get("/api/health", headers={"Host": "evil.example.com"})
    assert r.status_code == 403


def test_LANの実IPを名乗るリクエストは拒否する(client_bound_to_all):
    r = client_bound_to_all.get("/api/health", headers={"Host": "192.168.1.10:4520"})
    assert r.status_code == 403


def test_他サイトからのクロスオリジン状態変更は拒否する(client_bound_to_all):
    r = client_bound_to_all.post(
        "/api/projects/nonexistent/settings",
        headers={"Host": "127.0.0.1:4520", "Origin": "https://evil.example.com"},
        json={},
    )
    assert r.status_code == 403


# ── 防げないもの（意図的。SECURITY.md に明記済み）──


@pytest.mark.parametrize("spoofed", ["127.0.0.1:4520", "localhost:4520"])
def test_ループバックを名乗るHost詐称は通過する(client_bound_to_all, spoofed):
    """curl 等は Host を自由に設定できる。だからループバック以外へバインド
    した時点で、認証のない API がそのネットワークに露出する。"""
    r = client_bound_to_all.get("/api/health", headers={"Host": spoofed})
    assert r.status_code == 200, (
        "Host 詐称が拒否されるようになった。ガードを強化したなら "
        "SECURITY.md の「何を防がないか」も更新すること"
    )


def test_Originなしの状態変更はHostガードを通過する(client_bound_to_all):
    """CLI 互換のため Origin なしは通す設計（server.py の方針コメント参照）。

    404 = Host/Origin ガードを抜けて「そんなプロジェクトはない」に到達した、
    つまりガードでは止まっていないということ。
    """
    r = client_bound_to_all.post(
        "/api/projects/nonexistent/settings",
        headers={"Host": "127.0.0.1:4520"},
        json={},
    )
    assert r.status_code != 403, (
        "Origin なしが拒否されるようになった。CLI 利用を壊していないか確認し、"
        "SECURITY.md も更新すること"
    )
