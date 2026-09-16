"""POST /api/projects/{id}/auto_edit の API テスト。

FastAPI TestClient + SEAM_DATA_DIR monkeypatch（test_security.py の方式）。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_prep import server, storage
from podcast_prep.models import Block, ProjectState


def _blk(bid, speaker, start, dur, *, src=None, deleted=False, text=""):
    src_start = src if src is not None else start
    return Block(
        id=bid,
        speaker=speaker,
        source_start=src_start,
        source_end=src_start + dur,
        start=start,
        text=text,
        deleted=deleted,
    )


def _standard_blocks():
    """tail 型被り1件 + 詰め対象ギャップ1件の標準データ。

    元座標:  a1 [0, 2] / b1 [1.5, 3.5]（被り [1.5, 2.0]）/ a2 [8, 10]
    resolve: b1 → start 2.0、a2 → start 8.5（delta 0.5）
    close:   解消後ギャップ [4, 8.5]（4.5s）→ keep 0.5s → a2 → start 4.5
    元blocksのギャップ（preview 用）: [3.5, 8.0]（4.5s）
    """
    return [
        _blk("a1", "A", 0.0, 2.0),
        _blk("b1", "B", 1.5, 2.0),
        _blk("a2", "A", 8.0, 2.0, src=10.0),
    ]


def _make_project(tmp_path, monkeypatch, blocks, pid="proj-auto"):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    project = ProjectState.new(pid, "auto-edit test")
    project.status = "ready"
    project.blocks = blocks
    storage.save_project(project)
    return project


def _project_json_bytes(pid):
    return storage.project_json_path(pid).read_bytes()


@pytest.fixture
def client():
    return TestClient(server.app)


# ---------------------------------------------------------------- dry_run


def test_dry_run_does_not_touch_disk_and_has_no_project_key(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _standard_blocks())
    before = _project_json_bytes(project.id)
    res = client.post(f"/api/projects/{project.id}/auto_edit", json={})
    assert res.status_code == 200
    data = res.json()
    assert data["dry_run"] is True
    assert data["applied"] is False
    assert "project" not in data
    assert re.fullmatch(r"[0-9a-f]{16}", data["blocks_digest"])
    assert data["summary"]["would_change"] is True
    assert data["summary"]["overlaps_resolved"] == 1
    assert data["summary"]["gaps_closed"] == 1
    # project.json はバイト単位で不変（保存もスタンプもされない）
    assert _project_json_bytes(project.id) == before


def test_dry_run_preview_uses_pre_apply_coordinates(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _standard_blocks())
    data = client.post(f"/api/projects/{project.id}/auto_edit", json={}).json()
    # overlaps = resolve アクションの (start, end) そのまま（元座標）
    assert data["preview"]["overlaps"] == [{"start": 1.5, "end": 2.0}]
    # gaps = detect_silence_gaps(元blocks, min_gap_s=max_gap) の詰め対象
    # （close_gap アクションの座標 [4, 8.5]（解消後）ではなく元座標 [3.5, 8]）
    assert data["preview"]["gaps"] == [{"start": 3.5, "end": 8.0}]
    close_actions = [a for a in data["actions"] if a["kind"] == "close_gap"]
    assert [(a["start"], a["end"]) for a in close_actions] == [(4.0, 8.5)]


def test_default_post_without_body_is_dry_run(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _standard_blocks())
    before = _project_json_bytes(project.id)
    res = client.post(f"/api/projects/{project.id}/auto_edit")
    assert res.status_code == 200
    assert res.json()["dry_run"] is True
    assert _project_json_bytes(project.id) == before


# ---------------------------------------------------------------- apply


def test_apply_saves_recomputes_and_returns_project(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _standard_blocks())
    updated_before = storage.load_project_dict(project.id)["updated_at"]
    res = client.post(f"/api/projects/{project.id}/auto_edit", json={"dry_run": False})
    assert res.status_code == 200
    data = res.json()
    assert data["dry_run"] is False
    assert data["applied"] is True
    assert "preview" in data  # apply 応答にも preview を含める（契約§A）
    saved = storage.load_project(project.id)
    starts = {b.id: b.start for b in saved.blocks}
    assert starts == {"a1": 0.0, "b1": 2.0, "a2": 4.5}
    # 解消後は被りゼロ → recompute 済み overlaps は空
    assert saved.overlaps == []
    # 応答の project はディスクと同じブロック配置
    assert {b["id"]: b["start"] for b in data["project"]["blocks"]} == starts
    # 保存時に updated_at がスタンプされる
    assert storage.load_project_dict(project.id)["updated_at"] != updated_before
    # source 座標・deleted は不変
    for blk in saved.blocks:
        original = {b.id: b for b in _standard_blocks()}[blk.id]
        assert blk.source_start == original.source_start
        assert blk.source_end == original.source_end
        assert blk.deleted == original.deleted


def test_apply_without_change_skips_save(tmp_path, monkeypatch, client):
    # 既に詰まっているデータ: ギャップ 0.5s / 被りなし
    blocks = [_blk("a1", "A", 0.0, 2.0), _blk("b1", "B", 2.5, 2.0)]
    project = _make_project(tmp_path, monkeypatch, blocks)
    before = _project_json_bytes(project.id)
    res = client.post(f"/api/projects/{project.id}/auto_edit", json={"dry_run": False})
    assert res.status_code == 200
    data = res.json()
    assert data["applied"] is False
    assert data["summary"]["would_change"] is False
    assert "project" in data  # 無変化 apply でも現状の project は返す
    assert _project_json_bytes(project.id) == before  # 保存スキップ（updated_at 含め不変）


def test_apply_is_idempotent(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _standard_blocks())
    first = client.post(f"/api/projects/{project.id}/auto_edit", json={"dry_run": False}).json()
    assert first["applied"] is True
    after_first = _project_json_bytes(project.id)
    second = client.post(f"/api/projects/{project.id}/auto_edit", json={"dry_run": False}).json()
    assert second["applied"] is False
    assert second["summary"]["would_change"] is False
    assert _project_json_bytes(project.id) == after_first


# ---------------------------------------------------------------- エラー系


def test_unknown_project_returns_404(tmp_path, monkeypatch, client):
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path))
    res = client.post("/api/projects/no-such-project/auto_edit", json={})
    assert res.status_code == 404


@pytest.mark.parametrize(
    "payload",
    [
        {"keep_gap_s": 2.0, "max_gap_s": 1.0},   # keep > max
        {"keep_gap_s": -0.1},                     # 負値
        {"max_overlap_s": 0.1},                   # max_ov < min_overlap_s(0.3)
        {"keep_overlap_s": 0.3},                  # keep_ov >= min_overlap_s
        {"max_gap_s": "abc"},                     # 数値変換不能
    ],
)
def test_invalid_thresholds_return_400(tmp_path, monkeypatch, client, payload):
    project = _make_project(tmp_path, monkeypatch, _standard_blocks())
    before = _project_json_bytes(project.id)
    res = client.post(f"/api/projects/{project.id}/auto_edit", json={**payload, "dry_run": False})
    assert res.status_code == 400
    assert _project_json_bytes(project.id) == before


def test_digest_mismatch_returns_409_and_fresh_digest_succeeds(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _standard_blocks())
    stale = client.post(f"/api/projects/{project.id}/auto_edit", json={}).json()["blocks_digest"]
    # プレビュー後にプロジェクトが変わる（a2 を移動して保存）
    project.blocks[2].start = 9.0
    storage.save_project(project)
    res = client.post(
        f"/api/projects/{project.id}/auto_edit",
        json={"dry_run": False, "if_blocks_digest": stale},
    )
    assert res.status_code == 409
    # 再プレビューで得た digest なら適用できる
    fresh = client.post(f"/api/projects/{project.id}/auto_edit", json={}).json()["blocks_digest"]
    assert fresh != stale
    res = client.post(
        f"/api/projects/{project.id}/auto_edit",
        json={"dry_run": False, "if_blocks_digest": fresh},
    )
    assert res.status_code == 200
    assert res.json()["applied"] is True


# ---------------------------------------------------------------- フラグ個別 ON/OFF


def test_gaps_only_flag(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _standard_blocks())
    res = client.post(
        f"/api/projects/{project.id}/auto_edit",
        json={"tighten_overlaps": False, "dry_run": False},
    )
    data = res.json()
    assert [a["kind"] for a in data["actions"]] == ["close_gap"]
    assert data["preview"]["overlaps"] == []
    assert data["preview"]["gaps"] == [{"start": 3.5, "end": 8.0}]
    saved = storage.load_project(project.id)
    starts = {b.id: b.start for b in saved.blocks}
    # 被りは残る（b1 不動）、ギャップ [3.5, 8] のみ 0.5s 残して詰め → a2 = 8 - 4 = 4
    assert starts == {"a1": 0.0, "b1": 1.5, "a2": 4.0}
    assert len(saved.overlaps) == 1  # 被りは recompute でも残存


def test_overlaps_only_flag(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _standard_blocks())
    res = client.post(
        f"/api/projects/{project.id}/auto_edit",
        json={"tighten_gaps": False, "dry_run": False},
    )
    data = res.json()
    assert [a["kind"] for a in data["actions"]] == ["resolve_overlap"]
    assert data["preview"]["gaps"] == []
    assert data["preview"]["overlaps"] == [{"start": 1.5, "end": 2.0}]
    starts = {b.id: b.start for b in storage.load_project(project.id).blocks}
    # 解消のみ: b1 → 2.0、a2 は +0.5 シフト。ギャップは詰めない
    assert starts == {"a1": 0.0, "b1": 2.0, "a2": 8.5}


def test_both_flags_off_is_noop(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _standard_blocks())
    before = _project_json_bytes(project.id)
    res = client.post(
        f"/api/projects/{project.id}/auto_edit",
        json={"tighten_gaps": False, "tighten_overlaps": False, "dry_run": False},
    )
    data = res.json()
    assert data["applied"] is False
    assert data["actions"] == []
    assert data["preview"] == {"gaps": [], "overlaps": []}
    assert _project_json_bytes(project.id) == before


# ---------------------------------------------------------------- 閾値の優先順と settings 不変


def test_payload_thresholds_override_settings_and_settings_unchanged(
    tmp_path, monkeypatch, client
):
    project = _make_project(tmp_path, monkeypatch, _standard_blocks())
    # settings 既定（max_gap 1.5）なら詰まるギャップ 4.5s が、payload の 10.0 では対象外
    res = client.post(
        f"/api/projects/{project.id}/auto_edit",
        json={"tighten_overlaps": False, "max_gap_s": 10.0, "dry_run": False},
    )
    data = res.json()
    assert data["summary"]["gaps_closed"] == 0
    assert data["preview"]["gaps"] == []
    # settings 自体は書き換えない（閾値の永続化はフロントの PUT 経路）
    saved = storage.load_project(project.id)
    assert saved.settings["auto_edit_max_gap_s"] == 1.5
    assert saved.settings["auto_edit_keep_gap_s"] == 0.5


def test_settings_thresholds_used_when_payload_omits(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _standard_blocks())
    project.settings["auto_edit_max_gap_s"] = 10.0  # ギャップ 4.5s を対象外にする
    storage.save_project(project)
    data = client.post(
        f"/api/projects/{project.id}/auto_edit", json={"tighten_overlaps": False}
    ).json()
    assert data["summary"]["gaps_closed"] == 0
    assert data["preview"]["gaps"] == []


# ------------------------------------------------- レビュー2-C GET の overlaps.category


def _classified_blocks():
    """4分類が1件ずつ出るデータ（被り一覧のチップ表示用）。"""
    return [
        _blk("a1", "A", 0.0, 2.0),
        _blk("b1", "B", 1.0, 2.0),    # resolvable
        _blk("a2", "A", 20.0, 5.0),
        _blk("b2", "B", 21.0, 1.0),   # contained（相槌）
        _blk("a3", "A", 40.0, 5.0),
        _blk("b3", "B", 41.0, 9.0),   # too_long（長尺）
        _blk("a4", "A", 60.0, 2.0),
        _blk("b4", "B", 60.0, 3.0),   # same_start（同時）
    ]


def _categories_of(payload):
    return {tuple(o["block_ids"]): o.get("category") for o in payload["overlaps"]}


def test_get_project_overlaps_carry_category(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _classified_blocks())
    project.overlaps = server.recompute_overlaps(project.blocks)
    storage.save_project(project)
    data = client.get(f"/api/projects/{project.id}").json()
    assert _categories_of(data) == {
        ("a1", "b1"): "resolvable",
        ("a2", "b2"): "contained",
        ("a3", "b3"): "too_long",
        ("a4", "b4"): "same_start",
    }


def test_category_is_derived_not_persisted(tmp_path, monkeypatch, client):
    """category は応答生成時の導出。project.json には書かない
    （保存すると閾値変更・ブロック移動で陳腐化するため）。"""
    project = _make_project(tmp_path, monkeypatch, _classified_blocks())
    project.overlaps = server.recompute_overlaps(project.blocks)
    storage.save_project(project)
    client.get(f"/api/projects/{project.id}")
    saved = storage.load_project_dict(project.id)
    assert all("category" not in o for o in saved["overlaps"])


def test_category_follows_max_overlap_setting(tmp_path, monkeypatch, client):
    # 閾値を上げると too_long が resolvable に変わる（導出方式の効能）
    project = _make_project(tmp_path, monkeypatch, _classified_blocks())
    project.overlaps = server.recompute_overlaps(project.blocks)
    project.settings["auto_edit_max_overlap_s"] = 10.0
    storage.save_project(project)
    data = client.get(f"/api/projects/{project.id}").json()
    assert _categories_of(data)[("a3", "b3")] == "resolvable"


def test_put_response_also_carries_category(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _classified_blocks())
    payload = project.to_dict()
    res = client.put(f"/api/projects/{project.id}", json=payload)
    assert res.status_code == 200
    assert _categories_of(res.json()["project"]) == {
        ("a1", "b1"): "resolvable",
        ("a2", "b2"): "contained",
        ("a3", "b3"): "too_long",
        ("a4", "b4"): "same_start",
    }


def test_apply_response_project_carries_category(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _classified_blocks())
    data = client.post(
        f"/api/projects/{project.id}/auto_edit", json={"dry_run": False}
    ).json()
    # 適用後も残る skip 被りには分類が付く
    categories = _categories_of(data["project"])
    assert categories[("a2", "b2")] == "contained"
    assert categories[("a4", "b4")] == "same_start"


# ------------------------------------------------- レビュー2-D target_pairs


def _multi_overlap_blocks():
    """独立した tail 被り3件（相互に干渉しない距離）。ギャップは詰めない設定で使う。"""
    return [
        _blk("a1", "A", 0.0, 2.0),
        _blk("b1", "B", 1.0, 2.0),
        _blk("a2", "A", 20.0, 2.0),
        _blk("b2", "B", 21.0, 2.0),
        _blk("a3", "A", 40.0, 2.0),
        _blk("b3", "B", 41.0, 2.0),
    ]


def test_target_pairs_applies_only_selected(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _multi_overlap_blocks())
    res = client.post(
        f"/api/projects/{project.id}/auto_edit",
        json={
            "dry_run": False,
            "tighten_gaps": False,
            "target_pairs": [["a2", "b2"]],
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["summary"]["overlaps_resolved"] == 1
    assert [a["block_ids"] for a in data["actions"]] == [["a2", "b2"]]
    starts = {b.id: b.start for b in storage.load_project(project.id).blocks}
    assert starts == {"a1": 0.0, "b1": 1.0, "a2": 20.0, "b2": 22.0, "a3": 41.0, "b3": 42.0}


def test_target_pairs_filters_dry_run_preview(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _multi_overlap_blocks())
    full = client.post(
        f"/api/projects/{project.id}/auto_edit", json={"tighten_gaps": False}
    ).json()
    assert full["preview"]["overlaps"] == [
        {"start": 1.0, "end": 2.0}, {"start": 21.0, "end": 22.0}, {"start": 41.0, "end": 42.0},
    ]
    filtered = client.post(
        f"/api/projects/{project.id}/auto_edit",
        json={"tighten_gaps": False, "target_pairs": [["b3", "a3"]]},  # 順不同
    ).json()
    assert filtered["preview"]["overlaps"] == [{"start": 41.0, "end": 42.0}]
    assert filtered["summary"]["overlaps_resolved"] == 1


def test_target_pairs_omitted_is_full_run(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _multi_overlap_blocks())
    data = client.post(
        f"/api/projects/{project.id}/auto_edit", json={"tighten_gaps": False}
    ).json()
    assert data["summary"]["overlaps_resolved"] == 3
    explicit_null = client.post(
        f"/api/projects/{project.id}/auto_edit",
        json={"tighten_gaps": False, "target_pairs": None},
    ).json()
    assert explicit_null["summary"] == data["summary"]


def test_target_pairs_empty_list_resolves_nothing(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _multi_overlap_blocks())
    before = _project_json_bytes(project.id)
    data = client.post(
        f"/api/projects/{project.id}/auto_edit",
        json={"dry_run": False, "tighten_gaps": False, "target_pairs": []},
    ).json()
    assert data["summary"]["overlaps_resolved"] == 0
    assert data["preview"]["overlaps"] == []
    assert data["applied"] is False
    assert _project_json_bytes(project.id) == before  # 無変化なので保存スキップ


def test_target_pairs_unknown_pair_is_ignored(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _multi_overlap_blocks())
    data = client.post(
        f"/api/projects/{project.id}/auto_edit",
        json={"tighten_gaps": False, "target_pairs": [["ghost-a", "ghost-b"]]},
    ).json()
    assert data["summary"]["overlaps_resolved"] == 0
    assert data["preview"]["overlaps"] == []


def test_target_pairs_does_not_block_gap_pass(tmp_path, monkeypatch, client):
    # 被り選択が空でも無音詰めは走る（選択はあくまで被りパスのみ）
    project = _make_project(tmp_path, monkeypatch, _standard_blocks())
    data = client.post(
        f"/api/projects/{project.id}/auto_edit",
        json={"dry_run": False, "target_pairs": []},
    ).json()
    assert data["summary"]["overlaps_resolved"] == 0
    assert data["summary"]["gaps_closed"] == 1
    assert data["preview"]["gaps"] == [{"start": 3.5, "end": 8.0}]


def test_target_pairs_apply_is_idempotent(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _multi_overlap_blocks())
    body = {"dry_run": False, "tighten_gaps": False, "target_pairs": [["a1", "b1"]]}
    first = client.post(f"/api/projects/{project.id}/auto_edit", json=body).json()
    assert first["applied"] is True
    after_first = _project_json_bytes(project.id)
    second = client.post(f"/api/projects/{project.id}/auto_edit", json=body).json()
    assert second["applied"] is False
    assert second["summary"]["would_change"] is False
    assert _project_json_bytes(project.id) == after_first


def test_target_pairs_respects_digest_lock(tmp_path, monkeypatch, client):
    project = _make_project(tmp_path, monkeypatch, _multi_overlap_blocks())
    stale = client.post(f"/api/projects/{project.id}/auto_edit", json={}).json()["blocks_digest"]
    project.blocks[4].start = 45.0
    storage.save_project(project)
    res = client.post(
        f"/api/projects/{project.id}/auto_edit",
        json={"dry_run": False, "if_blocks_digest": stale, "target_pairs": [["a1", "b1"]]},
    )
    assert res.status_code == 409


@pytest.mark.parametrize(
    "target_pairs",
    [
        "a1,b1",                 # リストでない
        [["a1"]],                # 2要素でない
        [["a1", "b1", "c1"]],    # 3要素
        [["a1", 5]],             # 非文字列
        [["a1", ""]],            # 空文字
        [None],                  # 要素が非リスト
    ],
)
def test_invalid_target_pairs_return_400(tmp_path, monkeypatch, client, target_pairs):
    project = _make_project(tmp_path, monkeypatch, _multi_overlap_blocks())
    before = _project_json_bytes(project.id)
    res = client.post(
        f"/api/projects/{project.id}/auto_edit",
        json={"dry_run": False, "target_pairs": target_pairs},
    )
    assert res.status_code == 400
    assert _project_json_bytes(project.id) == before


def test_open_response_carries_category(tmp_path, monkeypatch, client):
    """POST /open（project.json から復元）の応答にも category が載る。

    回帰: 「開く」はUIの主要導線なのに _project_payload を通しておらず、
    復元直後の被り一覧が全件「不明」になっていた（2026-08 実機で発見）。
    """
    project = _make_project(tmp_path, monkeypatch, _classified_blocks())
    project.overlaps = server.recompute_overlaps(project.blocks)
    # 「編集済み(blocks あり)なのに音源が無い」文書は素材を抜いた書き出しとみなして
    # 400 で断る仕様になったため、音源を持たせる（このテストの主題は category 表示で、
    # 音源の有無ではない）。実体も要る — _adopt_track_audio が実在しない参照を落とすため。
    import wave

    pdir = storage.project_dir(project.id, create=True)
    for speaker in ("A", "B"):
        name = f"speaker{speaker}_normalized.wav"
        with wave.open(str(pdir / name), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(48000)
            wf.writeframes(b"\x00\x10" * 48000)
        project.tracks[speaker].normalized_wav = name
    storage.save_project(project)
    document = json.dumps(project.to_dict()).encode("utf-8")
    response = client.post(
        "/api/projects/open",
        files={"project_json": ("project.json", document, "application/json")},
    )
    assert response.status_code == 200
    assert _categories_of(response.json()["project"]) == {
        ("a1", "b1"): "resolvable",
        ("a2", "b2"): "contained",
        ("a3", "b3"): "too_long",
        ("a4", "b4"): "same_start",
    }


def test_job_result_project_carries_category(tmp_path, monkeypatch, client):
    """ジョブ完了 result の project にも category が載る。

    フロントは取込/正規化/文字起こしの完了 result をそのまま採用するため、
    ここが欠けると完了直後の一覧が「不明」になる（open と同根の回帰）。
    """
    project = _make_project(tmp_path, monkeypatch, _classified_blocks())
    project.overlaps = server.recompute_overlaps(project.blocks)
    storage.save_project(project)
    payload = server._project_payload(project)
    assert _categories_of(payload) == {
        ("a1", "b1"): "resolvable",
        ("a2", "b2"): "contained",
        ("a3", "b3"): "too_long",
        ("a4", "b4"): "same_start",
    }
    # ジョブ result を組み立てる全経路が _project_payload を通ることを構造で保証する
    source = Path(server.__file__).read_text(encoding="utf-8")
    assert 'result={"project": project.to_dict()}' not in source
    assert 'return {"project": project.to_dict(), "job": job}' not in source
