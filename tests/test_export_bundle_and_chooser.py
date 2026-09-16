"""中間生成物の整理（同梱モード）と OS のフォルダ選択ダイアログ（2026-08 実機フィードバック）。

- `export_project(bundle=...)` が同梱物を切り替えること
  （既定 "none" は成果物のみ。project.json / README.txt は同梱しない — Issue #28）
- transcript.srt は文字起こしが存在するときだけ生成されること（Issue #28）
- `_original` を同梱しなくなったこと（`_source` との重複解消）
- "reeditable" の README.txt が「何を消していいか」を説明すること
- `POST /api/system/choose_folder` の応答・キャンセル・未対応OS・プロンプト無害化
- ダイアログで選んだフォルダが書き出し先として通ること

フォルダ選択のテストは subprocess を monkeypatch し、実際のダイアログは開かない。
"""

from __future__ import annotations

import json
import shutil
import struct
import subprocess
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_prep import exporter, server, storage
from podcast_prep.exporter import export_project
from podcast_prep.models import Block, ProjectState, TranscriptSegment


@pytest.fixture()
def client():
    return TestClient(server.app)


@pytest.fixture(autouse=True)
def _clear_chosen_dirs():
    """プロセス内に積まれた「選ばれたフォルダ」をテスト間で漏らさない。"""
    server._chosen_dirs.clear()
    yield
    server._chosen_dirs.clear()


def _write_wav(path: Path, seconds: float = 1.0, rate: int = 48000) -> None:
    frames = int(seconds * rate)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(struct.pack("<h", 4096) * frames)


def _make_full_project(tmp_path, monkeypatch, pid="proj-bundle") -> ProjectState:
    monkeypatch.setenv("SEAM_DATA_DIR", str(tmp_path / "data"))
    project = ProjectState.new(pid, "bundle test")
    project.status = "ready"
    pdir = storage.project_dir(pid, create=True)
    for index, speaker in enumerate(("A", "B")):
        original = f"speaker{speaker}.mp3"
        normalized = f"speaker{speaker}_normalized.wav"
        (pdir / original).write_bytes(b"ID3fake-original-audio")
        _write_wav(pdir / normalized)
        track = project.tracks[speaker]
        track.original_file = original
        track.normalized_wav = normalized
        track.duration = 1.0
        project.blocks.append(
            Block(id=f"b{index}", speaker=speaker, start=0.0, source_start=0.0, source_end=0.5)
        )
    storage.save_project(project)
    return project


requires_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg not installed"
)


# ---------------------------------------------------------------- 同梱モード


@requires_ffmpeg
def test_default_bundle_contains_artifacts_only(tmp_path, monkeypatch):
    """既定（bundle 未指定）は成果物だけ。素材・project.json・README を同梱しない（Issue #28）。

    実機実測: 60分素材で出力 651MB のうち _source が 426MB、_original が 47MB。
    既定を軽くすることで「どれを消していいか分からない」状態自体を作らない。
    project.json / README.txt も同梱しない — 開けない project.json を成果物に
    混ぜるのが「どれが成果物か分からない」の核心だった。
    """
    project = _make_full_project(tmp_path, monkeypatch)
    outdir = tmp_path / "out"
    export_project(project, outdir)

    names = {p.name for p in outdir.iterdir()}
    # フィクスチャは未文字起こしなので transcript.srt も無い
    assert names == {"speakerA.wav", "speakerB.wav", "overlaps.csv"}


@requires_ffmpeg
def test_reexport_overwrites_in_place(tmp_path, monkeypatch):
    """同じ出力先への再エクスポートは上書きで、残骸も増やさない（回帰。Issue #28 後も不変）。"""
    import os as _os
    import time as _time

    project = _make_full_project(tmp_path, monkeypatch)
    outdir = tmp_path / "out"
    export_project(project, outdir)
    first = {p.name for p in outdir.iterdir()}
    stale = _time.time() - 3600
    _os.utime(outdir / "speakerA.wav", (stale, stale))

    export_project(project, outdir)
    assert {p.name for p in outdir.iterdir()} == first, "再エクスポートでファイル構成が変わった"
    assert (outdir / "speakerA.wav").stat().st_mtime > stale + 1800, "納品物が上書きされていない"


@requires_ffmpeg
def test_srt_generated_only_when_transcribed(tmp_path, monkeypatch):
    """transcript.srt は文字起こしが存在するときだけ生成される（Issue #28）。

    以前は未文字起こしでも空の SRT を必ず書いており、成果物フォルダに
    「中身の無いファイル」が混ざっていた。
    """
    project = _make_full_project(tmp_path, monkeypatch)
    without = tmp_path / "without-transcript"
    export_project(project, without)
    assert not (without / "transcript.srt").exists()

    project.transcripts.append(
        TranscriptSegment(id="t1", speaker="A", source_start=0.0, source_end=0.4, text="こんにちは")
    )
    with_srt = tmp_path / "with-transcript"
    export_project(project, with_srt)
    assert "こんにちは" in (with_srt / "transcript.srt").read_text(encoding="utf-8")


@requires_ffmpeg
def test_reeditable_bundle_is_self_contained(tmp_path, monkeypatch):
    """"reeditable" は _source + project.json + README.txt を同梱する（_original は入れない）。

    再編集バンドルの自己完結（フォルダ単体で「開く」に渡せる）は Issue #28 の
    整理後も不変。srt の条件付き生成は reeditable にも適用される。
    """
    project = _make_full_project(tmp_path, monkeypatch)
    outdir = tmp_path / "out"
    export_project(project, outdir, bundle="reeditable")

    for speaker in ("A", "B"):
        assert (outdir / f"speaker{speaker}_source.wav").is_file()
    assert not list(outdir.glob("*_original.*"))
    assert (outdir / "README.txt").is_file()
    assert not (outdir / "transcript.srt").exists(), "未文字起こしなら reeditable でも srt を作らない"
    doc = json.loads((outdir / "project.json").read_text(encoding="utf-8"))
    assert doc["exported_bundle_mode"] == "reeditable"


@requires_ffmpeg
def test_bundle_none_is_smaller_than_reeditable(tmp_path, monkeypatch):
    """既定モードが実際に小さいこと（削減の回帰検出）。"""
    project = _make_full_project(tmp_path, monkeypatch)
    light = tmp_path / "light"
    heavy = tmp_path / "heavy"
    export_project(project, light, bundle="none")
    export_project(project, heavy, bundle="reeditable")

    def total(path: Path) -> int:
        return sum(f.stat().st_size for f in path.iterdir() if f.is_file())

    assert total(light) < total(heavy)


def test_export_project_rejects_unknown_bundle(tmp_path, monkeypatch):
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-badbundle")
    with pytest.raises(ValueError, match="bundle must be one of"):
        export_project(project, tmp_path / "out", bundle="everything")


@requires_ffmpeg
def test_readme_explains_what_is_safe_to_delete(tmp_path, monkeypatch):
    """出力フォルダの README.txt が「消していいもの」を明示すること。"""
    project = _make_full_project(tmp_path, monkeypatch)
    outdir = tmp_path / "out"
    export_project(project, outdir, bundle="reeditable")
    text = (outdir / "README.txt").read_text(encoding="utf-8")
    assert "speakerA_source.wav" in text
    assert "削除して構いません" in text
    assert "納品物" in text


@requires_ffmpeg
def test_default_bundle_leaves_existing_readme_untouched(tmp_path, monkeypatch):
    """bundle=none は README を書かないので、出力先の既存 README にも一切触れない（Issue #28）。"""
    project = _make_full_project(tmp_path, monkeypatch)
    outdir = tmp_path / "deliver"
    outdir.mkdir()
    mine = "# ユーザーのメモ\n納品先。消すな。\n"
    (outdir / "README.txt").write_text(mine, encoding="utf-8")

    export_project(project, outdir)
    assert (outdir / "README.txt").read_text(encoding="utf-8") == mine
    assert not (outdir / "README_seam.txt").exists()


# ---------------------------------------------------------------- API: bundle の受け口


def _stub_export(monkeypatch) -> dict:
    captured: dict = {}

    def fake_export(project_arg, target, export_format="wav", progress=None, bundle="none"):
        captured["target"] = Path(target)
        captured["format"] = export_format
        captured["bundle"] = bundle
        Path(target).mkdir(parents=True, exist_ok=True)
        return {}

    monkeypatch.setattr(server, "export_project", fake_export)
    return captured


def test_start_export_defaults_to_light_bundle(tmp_path, monkeypatch, client):
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-api1")
    captured = _stub_export(monkeypatch)
    res = client.post(f"/api/projects/{project.id}/export", json={"format": "wav"})
    assert res.status_code == 200, res.text
    assert captured["bundle"] == "none"


def test_start_export_passes_bundle_through(tmp_path, monkeypatch, client):
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-api2")
    captured = _stub_export(monkeypatch)
    res = client.post(
        f"/api/projects/{project.id}/export",
        json={"format": "wav", "bundle": "reeditable"},
    )
    assert res.status_code == 200, res.text
    assert captured["bundle"] == "reeditable"


@pytest.mark.parametrize("bad", ["everything", "", 42])
def test_start_export_rejects_bad_bundle(tmp_path, monkeypatch, client, bad):
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-api3")
    res = client.post(
        f"/api/projects/{project.id}/export", json={"format": "wav", "bundle": bad}
    )
    assert res.status_code == 400


# ---------------------------------------------------------------- 書き出し形式（Issue #32）


def _fake_render_and_encode(monkeypatch) -> list[tuple[Path, int]]:
    """ffmpeg 不要で export_project を回すための差し替え。

    render_edited_track は極小 WAV を書き、encode_mp3 は (出力先, ビットレート) を
    記録して疑似 MP3 を書く。形式→ビットレートの対応（EXPORT_FORMATS）だけを
    実 ffmpeg なしで検証できる。
    """
    calls: list[tuple[Path, int]] = []

    def fake_render(*, source_wav, blocks, speaker, output_wav, **_kwargs):
        _write_wav(Path(output_wav), seconds=0.05)

    def fake_encode(input_wav, output_mp3, *, bitrate_kbps=320):
        calls.append((Path(output_mp3), bitrate_kbps))
        Path(output_mp3).write_bytes(b"ID3fake-encoded")

    monkeypatch.setattr(exporter, "render_edited_track", fake_render)
    monkeypatch.setattr(exporter, "encode_mp3", fake_encode)
    return calls


def test_export_format_mp3_192_encodes_at_192k(tmp_path, monkeypatch):
    """新値 "mp3_192" は 192kbps でエンコードし、成果物名は従来と同じ speakerX.mp3。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-fmt192")
    calls = _fake_render_and_encode(monkeypatch)
    outdir = tmp_path / "out192"
    files = export_project(project, outdir, export_format="mp3_192")
    assert sorted(n for n in files if n.startswith("speaker")) == [
        "speakerA.mp3",
        "speakerB.mp3",
    ]
    assert [bitrate for _, bitrate in calls] == [192, 192]
    assert not list(outdir.glob("*.wav"))  # 中間 WAV は残さない（既存挙動を維持）


def test_export_format_mp3_stays_320k(tmp_path, monkeypatch):
    """後方互換の固定: 既存値 "mp3" は 320kbps のまま（保存済み設定を変質させない）。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-fmt320")
    calls = _fake_render_and_encode(monkeypatch)
    export_project(project, tmp_path / "out320", export_format="mp3")
    assert [bitrate for _, bitrate in calls] == [320, 320]


def test_export_format_wav_never_encodes(tmp_path, monkeypatch):
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-fmtwav")
    calls = _fake_render_and_encode(monkeypatch)
    files = export_project(project, tmp_path / "outwav", export_format="wav")
    assert calls == []
    assert "speakerA.wav" in files


def test_export_rejects_unknown_format(tmp_path, monkeypatch):
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-fmtbad")
    _fake_render_and_encode(monkeypatch)
    with pytest.raises(ValueError, match="export format"):
        export_project(project, tmp_path / "outbad", export_format="ogg")


def test_start_export_accepts_mp3_192(tmp_path, monkeypatch, client):
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-fmt-api")
    captured = _stub_export(monkeypatch)
    res = client.post(f"/api/projects/{project.id}/export", json={"format": "mp3_192"})
    assert res.status_code == 200, res.text
    assert captured["format"] == "mp3_192"


@pytest.mark.parametrize("bad", ["ogg", "mp3-192", "mp3 192k"])
def test_start_export_rejects_unknown_format_before_job(tmp_path, monkeypatch, client, bad):
    """未知の形式はジョブを作る前に 400（bundle と同じ規律）。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-fmt-badapi")
    res = client.post(f"/api/projects/{project.id}/export", json={"format": bad})
    assert res.status_code == 400
    assert "format" in res.json()["detail"]


# ---------------------------------------------------------------- フォルダ選択ダイアログ


class _Completed:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


def _fake_run(monkeypatch, result, recorder=None):
    """subprocess.run を差し替える（実際のダイアログは開かない）。"""

    def runner(command, **kwargs):
        if recorder is not None:
            recorder["command"] = command
            recorder["kwargs"] = kwargs
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(server.subprocess, "run", runner)


def test_choose_folder_returns_selected_path(tmp_path, monkeypatch, client):
    monkeypatch.setattr(server.sys, "platform", "darwin")
    chosen = tmp_path / "Podcast"
    chosen.mkdir()
    _fake_run(monkeypatch, _Completed(stdout=f"{chosen}\n"))
    res = client.post("/api/system/choose_folder", json={"purpose": "export"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["cancelled"] is False
    assert body["path"] == str(chosen.resolve())


def test_choose_folder_cancel_is_not_an_error(tmp_path, monkeypatch, client):
    """キャンセルは 200 + cancelled=true（赤いエラーを出す筋合いはない）。"""
    monkeypatch.setattr(server.sys, "platform", "darwin")
    # osascript のキャンセルは exit 1 + stderr に -128、stdout は空
    _fake_run(monkeypatch, _Completed(stdout="", stderr="(-128)", returncode=1))
    res = client.post("/api/system/choose_folder", json={"purpose": "export"})
    assert res.status_code == 200
    assert res.json() == {"path": None, "cancelled": True}


def test_choose_folder_ignores_stderr_noise_when_stdout_has_path(tmp_path, monkeypatch, client):
    """stderr にノイズが出ていても stdout にパスがあれば成功（実機で発生する）。

    macOS の osascript は GUI セッションの状態次第で大量の警告を stderr に吐くが、
    選択自体は成功している。stderr の有無で失敗判定すると正常操作がエラーになる。
    """
    monkeypatch.setattr(server.sys, "platform", "darwin")
    chosen = tmp_path / "Podcast"
    chosen.mkdir()
    _fake_run(
        monkeypatch,
        _Completed(stdout=f"{chosen}\n", stderr="TISFileInterrogator ... Connection invalid"),
    )
    res = client.post("/api/system/choose_folder", json={"purpose": "export"})
    assert res.status_code == 200
    assert res.json()["path"] == str(chosen.resolve())


def test_choose_folder_uses_fixed_command_and_arg_array(tmp_path, monkeypatch, client):
    """コマンドは固定・引数は配列・shell=False・タイムアウトつき（reveal と同じ規律）。"""
    monkeypatch.setattr(server.sys, "platform", "darwin")
    chosen = tmp_path / "x"
    chosen.mkdir()
    recorder: dict = {}
    _fake_run(monkeypatch, _Completed(stdout=str(chosen)), recorder)
    client.post("/api/system/choose_folder", json={"purpose": "export"})
    assert isinstance(recorder["command"], list)
    assert recorder["command"][0] == "osascript"
    assert recorder["kwargs"]["shell"] is False
    assert recorder["kwargs"]["timeout"] == server.CHOOSE_FOLDER_TIMEOUT_S


def test_choose_folder_sanitizes_prompt(tmp_path, monkeypatch, client):
    """prompt はスクリプト文字列へ埋め込まれるので、引用符・改行を通さない。

    ここを素通しすると `" & (do shell script "…") & "` のような AppleScript
    インジェクションが成立する。win32 では PS 二重引用符リテラル内の `$`（変数展開・
    部分式）とバッククォート（エスケープ）が同種の穴になるため併せて落とす（#36）。
    """
    monkeypatch.setattr(server.sys, "platform", "darwin")
    chosen = tmp_path / "x"
    chosen.mkdir()
    recorder: dict = {}
    _fake_run(monkeypatch, _Completed(stdout=str(chosen)), recorder)
    # ASCII のインジェクション + Unicode スマートクォート版（U+201C/201D/201E）。
    # PowerShell のトークナイザはスマートクォートを通常のクォートと同一視するため、
    # ASCII だけ落としても “; Start-Process calc; $x=„ 相当でリテラルを破れる。
    evil = (
        '" & (do shell script "touch /tmp/pwned") & " $(Remove-Item x) `n'
        "“; Start-Process calc; ” „ ‘x’"
    )
    res = client.post(
        "/api/system/choose_folder", json={"purpose": "export", "prompt": evil}
    )
    assert res.status_code == 200
    script = recorder["command"][-1]
    # 引用符はリテラルを囲む2個だけ = 埋め込んだ文字列がリテラルを閉じていない。
    # AppleScript として見たとき prompt は単なる無害な文字列のままになる。
    assert script.count('"') == 2
    assert "\\" not in script and "\n" not in script
    # PowerShell メタ文字（$ とバッククォート）も残らない（#36）
    assert "$" not in script and "`" not in script
    # Unicode スマートクォート（U+2018〜U+201F）も残らない（#36 QA指摘）
    assert not any("‘" <= ch <= "‟" for ch in script)


def test_choose_folder_workdir_purpose_uses_default_prompt(tmp_path, monkeypatch, client):
    """purpose="workdir"（フェーズ3: プロジェクト作成時の作業フォルダ選択）が通る。"""
    monkeypatch.setattr(server.sys, "platform", "darwin")
    chosen = tmp_path / "EP31"
    chosen.mkdir()
    recorder: dict = {}
    _fake_run(monkeypatch, _Completed(stdout=str(chosen)), recorder)
    res = client.post("/api/system/choose_folder", json={"purpose": "workdir"})
    assert res.status_code == 200, res.text
    assert res.json() == {"path": str(chosen.resolve()), "cancelled": False}
    assert server._DEFAULT_PROMPTS["workdir"] in recorder["command"][-1]


def test_choose_folder_workdir_purpose_grants_no_export_access(tmp_path, monkeypatch, client):
    """workdir は _chosen_dirs（書き出し許可ベース）に**積まない**。

    作業フォルダの許可判断は registry + validate_workdir の責務で、ここで積むと
    「作業フォルダに選んだだけ」のフォルダへ任意の書き出しができてしまう。
    """
    monkeypatch.setattr(server.sys, "platform", "darwin")
    chosen = tmp_path / "EP31"
    chosen.mkdir()
    _fake_run(monkeypatch, _Completed(stdout=str(chosen)))
    res = client.post("/api/system/choose_folder", json={"purpose": "workdir"})
    assert res.status_code == 200
    assert server._chosen_dirs == []


def test_choose_folder_rejects_non_string_prompt(monkeypatch, client):
    monkeypatch.setattr(server.sys, "platform", "darwin")
    res = client.post("/api/system/choose_folder", json={"purpose": "export", "prompt": 42})
    assert res.status_code == 400


def test_choose_folder_rejects_bad_purpose(monkeypatch, client):
    monkeypatch.setattr(server.sys, "platform", "darwin")
    res = client.post("/api/system/choose_folder", json={"purpose": "delete"})
    assert res.status_code == 400


def test_choose_folder_unsupported_platform_returns_501(monkeypatch, client):
    monkeypatch.setattr(server.sys, "platform", "sunos5")
    res = client.post("/api/system/choose_folder", json={"purpose": "export"})
    assert res.status_code == 501


def test_choose_folder_linux_without_zenity_returns_501(monkeypatch, client):
    monkeypatch.setattr(server.sys, "platform", "linux")
    monkeypatch.setattr(server.shutil, "which", lambda name: None)
    res = client.post("/api/system/choose_folder", json={"purpose": "export"})
    assert res.status_code == 501


def test_choose_folder_linux_uses_zenity(tmp_path, monkeypatch, client):
    monkeypatch.setattr(server.sys, "platform", "linux")
    monkeypatch.setattr(server.shutil, "which", lambda name: f"/usr/bin/{name}")
    chosen = tmp_path / "x"
    chosen.mkdir()
    recorder: dict = {}
    _fake_run(monkeypatch, _Completed(stdout=str(chosen)), recorder)
    res = client.post("/api/system/choose_folder", json={"purpose": "export"})
    assert res.status_code == 200
    assert recorder["command"][0] == "zenity"
    assert "--directory" in recorder["command"]


def test_choose_folder_timeout_returns_504(monkeypatch, client):
    monkeypatch.setattr(server.sys, "platform", "darwin")
    _fake_run(monkeypatch, subprocess.TimeoutExpired(cmd="osascript", timeout=120))
    res = client.post("/api/system/choose_folder", json={"purpose": "export"})
    assert res.status_code == 504


def test_choose_folder_rejects_nonexistent_selection(tmp_path, monkeypatch, client):
    """ダイアログが実在しないパスを返したら通さない（想定外の入力）。"""
    monkeypatch.setattr(server.sys, "platform", "darwin")
    _fake_run(monkeypatch, _Completed(stdout=str(tmp_path / "nope")))
    res = client.post("/api/system/choose_folder", json={"purpose": "export"})
    assert res.status_code == 500


# ---------------------------------------------------------------- ファイル選択ダイアログ


def test_choose_file_returns_selected_path(tmp_path, monkeypatch, client):
    monkeypatch.setattr(server.sys, "platform", "darwin")
    chosen = tmp_path / "EP31" / "project.json"
    chosen.parent.mkdir()
    chosen.write_text("{}", encoding="utf-8")
    _fake_run(monkeypatch, _Completed(stdout=f"{chosen}\n"))
    res = client.post("/api/system/choose_file", json={"purpose": "project_json"})
    assert res.status_code == 200, res.text
    assert res.json() == {"path": str(chosen.resolve()), "cancelled": False}


def test_choose_file_cancel_is_not_an_error(monkeypatch, client):
    """キャンセルは 200 + cancelled=true（choose_folder と同じ契約）。"""
    monkeypatch.setattr(server.sys, "platform", "darwin")
    _fake_run(monkeypatch, _Completed(stdout="", stderr="(-128)", returncode=1))
    res = client.post("/api/system/choose_file", json={"purpose": "project_json"})
    assert res.status_code == 200
    assert res.json() == {"path": None, "cancelled": True}


def test_choose_file_uses_fixed_command_and_arg_array(tmp_path, monkeypatch, client):
    """コマンドは固定・引数は配列・shell=False・タイムアウトつき（choose_folder と同じ規律）。"""
    monkeypatch.setattr(server.sys, "platform", "darwin")
    chosen = tmp_path / "project.json"
    chosen.write_text("{}", encoding="utf-8")
    recorder: dict = {}
    _fake_run(monkeypatch, _Completed(stdout=str(chosen)), recorder)
    client.post("/api/system/choose_file", json={"purpose": "project_json"})
    assert isinstance(recorder["command"], list)
    assert recorder["command"][0] == "osascript"
    assert "choose file" in recorder["command"][-1]
    assert recorder["kwargs"]["shell"] is False
    assert recorder["kwargs"]["timeout"] == server.CHOOSE_FOLDER_TIMEOUT_S


def test_choose_file_sanitizes_prompt(tmp_path, monkeypatch, client):
    """prompt はスクリプト文字列へ埋め込まれるので、引用符・改行を通さない。

    win32 では PS 二重引用符リテラル内の `$` とバッククォートも展開されるため
    併せて落とす（#36）。
    """
    monkeypatch.setattr(server.sys, "platform", "darwin")
    chosen = tmp_path / "project.json"
    chosen.write_text("{}", encoding="utf-8")
    recorder: dict = {}
    _fake_run(monkeypatch, _Completed(stdout=str(chosen)), recorder)
    # ASCII のインジェクション + Unicode スマートクォート版（U+201C/201D/201E）。
    evil = (
        '" & (do shell script "touch /tmp/pwned") & " $(Remove-Item x) `n'
        "“; Start-Process calc; ” „ ‘x’"
    )
    res = client.post(
        "/api/system/choose_file", json={"purpose": "project_json", "prompt": evil}
    )
    assert res.status_code == 200
    script = recorder["command"][-1]
    # 引用符は prompt リテラルの2個 + of type の {"public.json"} の2個だけ
    # = 埋め込んだ文字列がリテラルを閉じていない。
    assert script.count('"') == 4
    assert "\\" not in script and "\n" not in script
    # PowerShell メタ文字（$ とバッククォート）も残らない（#36）
    assert "$" not in script and "`" not in script
    # Unicode スマートクォート（U+2018〜U+201F）も残らない（#36 QA指摘）
    assert not any("‘" <= ch <= "‟" for ch in script)


def test_choose_file_grants_no_export_access(tmp_path, monkeypatch, client):
    """選ばれたファイルの場所を許可ベース（_chosen_dirs）に**積まない**。

    開く経路の検証は /api/projects/open 側の責務で、ここで積むと
    「復元に選んだだけ」のフォルダへ任意の書き出しができてしまう。
    """
    monkeypatch.setattr(server.sys, "platform", "darwin")
    chosen = tmp_path / "project.json"
    chosen.write_text("{}", encoding="utf-8")
    _fake_run(monkeypatch, _Completed(stdout=str(chosen)))
    res = client.post("/api/system/choose_file", json={"purpose": "project_json"})
    assert res.status_code == 200
    assert server._chosen_dirs == []


@pytest.mark.parametrize("bad", ["open", "export", "workdir", "", None, 42])
def test_choose_file_rejects_bad_purpose(monkeypatch, client, bad):
    monkeypatch.setattr(server.sys, "platform", "darwin")
    res = client.post("/api/system/choose_file", json={"purpose": bad})
    assert res.status_code == 400


def test_choose_file_unsupported_platform_returns_501(monkeypatch, client):
    monkeypatch.setattr(server.sys, "platform", "sunos5")
    res = client.post("/api/system/choose_file", json={"purpose": "project_json"})
    assert res.status_code == 501


def test_choose_file_linux_uses_zenity_with_json_filter(tmp_path, monkeypatch, client):
    monkeypatch.setattr(server.sys, "platform", "linux")
    monkeypatch.setattr(server.shutil, "which", lambda name: f"/usr/bin/{name}")
    chosen = tmp_path / "project.json"
    chosen.write_text("{}", encoding="utf-8")
    recorder: dict = {}
    _fake_run(monkeypatch, _Completed(stdout=str(chosen)), recorder)
    res = client.post("/api/system/choose_file", json={"purpose": "project_json"})
    assert res.status_code == 200
    assert recorder["command"][0] == "zenity"
    assert "--directory" not in recorder["command"]
    assert "--file-filter=*.json" in recorder["command"]


def test_choose_file_rejects_directory_selection(tmp_path, monkeypatch, client):
    """ディレクトリや実在しないパスが返ってきたら通さない（想定外の入力）。"""
    monkeypatch.setattr(server.sys, "platform", "darwin")
    _fake_run(monkeypatch, _Completed(stdout=str(tmp_path)))
    res = client.post("/api/system/choose_file", json={"purpose": "project_json"})
    assert res.status_code == 500


# ---------------------------------------------------------------- 選んだフォルダへの書き出し


def test_chosen_export_dir_becomes_writable(tmp_path, monkeypatch, client):
    """ダイアログで選んだフォルダは書き出し先として通る（要望#1の本丸）。

    許可ベース外でも、**ユーザーがネイティブダイアログで明示的に選んだ**という
    同意の証跡があるため許可する。ブラウザ側からは偽装できない。
    """
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-chosen")
    chosen = tmp_path / "Users" / "law" / "Podcast"
    chosen.mkdir(parents=True)
    monkeypatch.setattr(server.sys, "platform", "darwin")
    _fake_run(monkeypatch, _Completed(stdout=str(chosen)))

    # 選ぶ前は許可ベース外なので 400
    res = client.post(
        f"/api/projects/{project.id}/export",
        json={"format": "wav", "output_dir": str(chosen / "ep1")},
    )
    assert res.status_code == 400

    # ダイアログで選ぶ
    res = client.post("/api/system/choose_folder", json={"purpose": "export"})
    assert res.status_code == 200

    # 選んだ後は通る
    captured = _stub_export(monkeypatch)
    res = client.post(
        f"/api/projects/{project.id}/export",
        json={"format": "wav", "output_dir": str(chosen / "ep1")},
    )
    assert res.status_code == 200, res.text
    assert captured["target"] == (chosen / "ep1").resolve()


def test_open_purpose_does_not_grant_write_access(tmp_path, monkeypatch, client):
    """purpose="open"（読み取り用の選択）は書き込み許可を与えない。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-openonly")
    chosen = tmp_path / "ReadOnlyPick"
    chosen.mkdir()
    monkeypatch.setattr(server.sys, "platform", "darwin")
    _fake_run(monkeypatch, _Completed(stdout=str(chosen)))

    res = client.post("/api/system/choose_folder", json={"purpose": "open"})
    assert res.status_code == 200

    res = client.post(
        f"/api/projects/{project.id}/export",
        json={"format": "wav", "output_dir": str(chosen / "ep1")},
    )
    assert res.status_code == 400


def test_chosen_dir_allows_reveal(tmp_path, monkeypatch, client):
    """選んだフォルダは「Finderで開く」も通る（書き出せる場所は開けるべき）。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-revealchosen")
    chosen = tmp_path / "Chosen"
    chosen.mkdir()
    monkeypatch.setattr(server.sys, "platform", "darwin")
    _fake_run(monkeypatch, _Completed(stdout=str(chosen)))
    client.post("/api/system/choose_folder", json={"purpose": "export"})

    _fake_run(monkeypatch, _Completed(stdout=""))
    res = client.post(
        f"/api/projects/{project.id}/reveal", json={"path": str(chosen)}
    )
    assert res.status_code == 200, res.text


def test_chosen_dirs_are_capped(tmp_path, monkeypatch):
    """記憶するフォルダ数に上限があること（無制限に許可ベースを増やさない）。"""
    for index in range(server.CHOSEN_DIR_MAX + 5):
        directory = tmp_path / f"d{index}"
        directory.mkdir()
        server._remember_chosen_dir(directory)
    assert len(server._chosen_dirs) == server.CHOSEN_DIR_MAX


def test_export_still_rejects_arbitrary_absolute_path(tmp_path, monkeypatch, client):
    """回帰: ダイアログを経ていない任意の絶対パスは従来どおり 400。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-stillsafe")
    res = client.post(
        f"/api/projects/{project.id}/export",
        json={"format": "wav", "output_dir": "/etc/podcast-out"},
    )
    assert res.status_code == 400


# ---------------------------------------------------------------- 上書き事前チェック（Issue #32）


def test_precheck_initial_target_has_no_artifacts(tmp_path, monkeypatch, client):
    """初回（exports/ 未作成）は exists=false — UI は無確認でエクスポートに進む。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-pre1")
    res = client.post(f"/api/projects/{project.id}/export/precheck", json={})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["exists"] is False
    assert body["files"] == []
    assert body["output_dir"].endswith("exports")


def test_precheck_detects_previous_artifacts(tmp_path, monkeypatch, client):
    """前回の成果物（形式が違っても）があれば exists=true + 該当ファイル名を返す。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-pre2")
    exports = storage.project_dir(project.id) / "exports"
    exports.mkdir(parents=True, exist_ok=True)
    (exports / "speakerA.mp3").write_bytes(b"ID3prev")  # 今回 wav 予定でも mp3 残骸は対象
    (exports / "overlaps.csv").write_text("start,end,duration\n", encoding="utf-8")
    res = client.post(
        f"/api/projects/{project.id}/export/precheck", json={"output_dir": None}
    )
    body = res.json()
    assert body["exists"] is True
    assert body["files"] == ["speakerA.mp3", "overlaps.csv"]


def test_precheck_ignores_unrelated_files(tmp_path, monkeypatch, client):
    """成果物名以外のファイルでは確認を出させない（エクスポートはそれらに触らない）。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-pre3")
    exports = storage.project_dir(project.id) / "exports"
    exports.mkdir(parents=True, exist_ok=True)
    (exports / "納品メモ.txt").write_text("note", encoding="utf-8")
    res = client.post(f"/api/projects/{project.id}/export/precheck", json={})
    assert res.json()["exists"] is False


def test_precheck_rejects_path_outside_allowed_bases(tmp_path, monkeypatch, client):
    """許可ベース検証を迂回しない: /export と同じ解決ロジックで 400。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-pre4")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "speakerA.wav").write_bytes(b"x")
    res = client.post(
        f"/api/projects/{project.id}/export/precheck",
        json={"output_dir": str(outside)},
    )
    assert res.status_code == 400


def test_precheck_sees_chosen_dir(tmp_path, monkeypatch, client):
    """ダイアログで選んだフォルダは precheck でも見える（/export と同じ許可ベース）。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-pre5")
    chosen = tmp_path / "chosen"
    chosen.mkdir()
    (chosen / "speakerB.wav").write_bytes(b"prev")
    monkeypatch.setattr(server.sys, "platform", "darwin")
    _fake_run(monkeypatch, _Completed(stdout=str(chosen)))
    res = client.post("/api/system/choose_folder", json={"purpose": "export"})
    assert res.status_code == 200
    res = client.post(
        f"/api/projects/{project.id}/export/precheck", json={"output_dir": str(chosen)}
    )
    assert res.status_code == 200, res.text
    assert res.json()["files"] == ["speakerB.wav"]


def test_precheck_rejects_non_string_output_dir(tmp_path, monkeypatch, client):
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-pre6")
    res = client.post(
        f"/api/projects/{project.id}/export/precheck", json={"output_dir": 42}
    )
    assert res.status_code == 400


# ------------------------------------------------ QA: 素材を上書きさせない


@requires_ffmpeg
def test_guard_catches_case_insensitive_material_name(tmp_path, monkeypatch):
    """大文字の素材名でも上書きガードが発火する（QA Critical の回帰）。

    macOS / Windows の既定FSは大小を区別しないため、素材 `SPEAKERA.WAV` と
    レンダリング先 `speakerA.wav` は**同じ実体**を指す。ガードがパス文字列の
    一致で判定していた頃はここをすり抜け、録り直せない収録データが無警告で
    破壊されていた。録音機材が大文字名を吐くのは珍しくなく、実運用で踏み得る。
    """
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-upper")
    pdir = storage.project_dir(project.id)
    # 素材を大文字名に置き換える（レンダリング先 speakerA.wav と同一実体になる）
    upper = pdir / "SPEAKERA.WAV"
    (pdir / "speakerA_normalized.wav").rename(upper)
    project.tracks["A"].normalized_wav = upper.name
    storage.save_project(project)

    before = upper.read_bytes()
    with pytest.raises(ValueError, match="overwrite the source audio"):
        export_project(project, output_dir=pdir, export_format="wav")
    assert upper.read_bytes() == before, "素材が破壊された"


@requires_ffmpeg
def test_guard_catches_hardlinked_material(tmp_path, monkeypatch):
    """ハードリンク経由でも上書きガードが発火する（QA High の回帰）。

    `Path.resolve()` はハードリンクを解決しない（別名・別パスだが同一 inode）。
    inode 比較にしたことで捕まる。
    """
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-hardlink")
    pdir = storage.project_dir(project.id)
    alias = pdir / "speakerA.wav"  # レンダリング先と同名のハードリンク
    import os as _os

    _os.link(pdir / "speakerA_normalized.wav", alias)
    project.tracks["A"].normalized_wav = alias.name
    storage.save_project(project)

    before = alias.read_bytes()
    with pytest.raises(ValueError, match="overwrite the source audio"):
        export_project(project, output_dir=pdir, export_format="wav")
    assert alias.read_bytes() == before, "素材が破壊された"


@requires_ffmpeg
def test_guard_does_not_false_positive_on_distinct_files(tmp_path, monkeypatch):
    """別実体への書き出しはガードに掛からない（過剰検知の回帰）。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-ok")
    out = tmp_path / "out"
    out.mkdir()
    files = export_project(project, output_dir=out, export_format="wav")
    assert (out / "speakerA.wav").exists()
    assert "overlaps.csv" in files


# ------------------------------------------------ QA: 既存ファイルを潰さない


@requires_ffmpeg
def test_existing_foreign_readme_is_not_clobbered(tmp_path, monkeypatch):
    """書き出し先の既存 README.txt がユーザーのものなら退避する（QA Medium の回帰）。

    任意フォルダを出力先に選べるようになったため、納品フォルダ等に元からある
    README.txt を無警告で潰す経路があった。README を書くのは reeditable のみ（#28）。
    """
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-readme")
    out = tmp_path / "deliver"
    out.mkdir()
    mine = "# ユーザーのメモ\n納品先。消すな。\n"
    (out / "README.txt").write_text(mine, encoding="utf-8")

    export_project(project, output_dir=out, export_format="wav", bundle="reeditable")
    assert (out / "README.txt").read_text(encoding="utf-8") == mine
    assert (out / "README_seam.txt").is_file()


@requires_ffmpeg
def test_own_readme_is_overwritten_in_place(tmp_path, monkeypatch):
    """自分が前回書いた README.txt は退避せず素直に更新する。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-readme2")
    out = tmp_path / "deliver2"
    out.mkdir()
    export_project(project, output_dir=out, export_format="wav", bundle="reeditable")
    assert (out / "README.txt").is_file()

    export_project(project, output_dir=out, export_format="wav", bundle="reeditable")  # 2回目
    assert not (out / "README_seam.txt").exists(), "自前のREADMEを退避してしまった"


# ------------------------------------------------ QA: 幽霊プロジェクトを作らない


def _legacy_none_export(folder: Path, project: ProjectState) -> dict:
    """Issue #28 以前の bundle="none" 書き出しフォルダを再現する。

    旧形式は project.json を必ず同梱していた（音源参照は空・exported_bundle_mode
    付き）。現行の "none" は project.json 自体を同梱しないが、ユーザーの手元には
    旧形式のフォルダが残り得るため、開く側の拒否はこの形に対して働き続ける必要がある。
    """
    folder.mkdir(parents=True, exist_ok=True)
    doc = json.loads(json.dumps(project.to_dict(), ensure_ascii=False))
    for speaker in ("A", "B"):
        _write_wav(folder / f"speaker{speaker}.wav")  # 納品物
        doc["tracks"][speaker]["original_file"] = ""
        doc["tracks"][speaker]["normalized_wav"] = ""
    doc["exported_bundle_mode"] = "none"
    (folder / "project.json").write_text(
        json.dumps(doc, ensure_ascii=False), encoding="utf-8"
    )
    return doc


def test_open_rejects_legacy_bundle_none_export(tmp_path, monkeypatch, client):
    """素材同梱なしの旧形式書き出しを開こうとしたら理由付きで断る（QA Medium の回帰）。

    以前は 200 で status=ready のプロジェクトが出来上がり、再生も波形も 404、
    書き出しは `Errno 21 Is a directory` が生で漏れる「幽霊」になっていた。
    """
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-ghost")
    doc = _legacy_none_export(tmp_path / "light", project)
    assert doc["exported_bundle_mode"] == "none"

    res = client.post(
        "/api/projects/open",
        files={"project_json": ("project.json", json.dumps(doc).encode(), "application/json")},
    )
    assert res.status_code == 400
    assert "編集用の音源が設定されていない" in res.json()["detail"]


@requires_ffmpeg
def test_open_accepts_reeditable_export(tmp_path, monkeypatch, client):
    """素材同梱ありの書き出しは開けて、音源も波形も引ける（対の正常系）。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-portable")
    out = tmp_path / "portable"
    out.mkdir()
    export_project(project, output_dir=out, export_format="wav", bundle="reeditable")

    res = client.post("/api/projects/open", data={"source_dir": str(out)})
    assert res.status_code == 200, res.json()
    opened = res.json()["project"]
    assert opened["status"] == "ready"
    new_id = opened["id"]
    assert client.get(f"/api/projects/{new_id}/audio/A").status_code == 200
    assert client.get(f"/api/projects/{new_id}/peaks/A").status_code == 200


@requires_ffmpeg
def test_readme_fallback_does_not_clobber_either_file(tmp_path, monkeypatch):
    """退避先 README_seam.txt も他人のものなら潰さず採番する（QA再指摘）。

    「ユーザーのファイルを潰さない」という修正の目的が、退避先だけ無防備だと
    そこで破れる。
    """
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-readme3")
    out = tmp_path / "deliver3"
    out.mkdir()
    mine_a = "# ユーザーのメモA\n消すな\n"
    mine_b = "# ユーザーのメモB\nこれも消すな\n"
    (out / "README.txt").write_text(mine_a, encoding="utf-8")
    (out / "README_seam.txt").write_text(mine_b, encoding="utf-8")

    export_project(project, output_dir=out, export_format="wav", bundle="reeditable")
    assert (out / "README.txt").read_text(encoding="utf-8") == mine_a
    assert (out / "README_seam.txt").read_text(encoding="utf-8") == mine_b
    assert (out / "README_seam-2.txt").is_file()


@requires_ffmpeg
def test_readme_marker_survives_bom(tmp_path, monkeypatch):
    """BOM 付きで保存し直された自前の README を他人扱いしない（QA再指摘）。

    `lstrip()` は U+FEFF を落とさないため、エディタが BOM を付けて保存すると
    書き出しのたびに退避ファイルが増え、README.txt は古い内容のまま残っていた。
    """
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-bom")
    out = tmp_path / "bom"
    out.mkdir()
    export_project(project, output_dir=out, export_format="wav", bundle="reeditable")
    body = (out / "README.txt").read_text(encoding="utf-8")
    (out / "README.txt").write_text("﻿" + body, encoding="utf-8")

    export_project(project, output_dir=out, export_format="wav", bundle="reeditable")
    names = sorted(p.name for p in out.iterdir() if p.name.startswith("README"))
    assert names == ["README.txt"], f"BOM で退避が増殖した: {names}"


def test_open_rejects_legacy_export_without_marker(tmp_path, monkeypatch, client):
    """マーカーを持たない既存の書き出しも幽霊にせず断る（QA再指摘）。

    判定を `exported_bundle_mode` の一致だけに頼ると、この機能より前に作られた
    書き出しフォルダ（この機能より前に作られたもの）が素通しして修正前と同じ幽霊になる。
    実体（音源が1つも無い）で判定していることを固定する。
    """
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-legacy")
    doc = _legacy_none_export(tmp_path / "legacy", project)
    doc.pop("exported_bundle_mode", None)  # マーカー導入前の旧形式を再現
    assert doc["blocks"], "この回帰テストは blocks を持つ文書が前提"

    res = client.post(
        "/api/projects/open",
        files={"project_json": ("project.json", json.dumps(doc).encode(), "application/json")},
    )
    assert res.status_code == 400
    assert "編集用の音源が設定されていない" in res.json()["detail"]


@pytest.mark.parametrize("forged", ["reeditable", None, 123, [], "NONE"])
def test_open_rejection_ignores_forged_bundle_marker(tmp_path, monkeypatch, client, forged):
    """マーカーを書き換えても実体判定は覆らない（値に依存しないことの固定）。"""
    project = _make_full_project(
        tmp_path, monkeypatch, pid=f"proj-forge-{abs(hash(str(forged))) % 1000}"
    )
    doc = _legacy_none_export(tmp_path / "forged", project)
    doc["exported_bundle_mode"] = forged
    res = client.post(
        "/api/projects/open",
        files={"project_json": ("project.json", json.dumps(doc).encode(), "application/json")},
    )
    assert res.status_code == 400


@requires_ffmpeg
def test_rejected_open_leaves_no_orphan_directory(tmp_path, monkeypatch, client):
    """拒否された open は1バイトも書かない（fbb0890 の不変条件・QA再指摘）。

    判定を `_adopt_track_audio` の後ろに置くと、拒否したのに音源コピーだけが
    プロジェクトディレクトリに残る。project.json が無いので一覧にも出ず、
    ユーザーからは見えないまま堆積する（60分素材なら1回 450MB、リトライで増加）。

    フィクスチャは「素材を同梱せずに書き出したフォルダ」— 拒否が正しい唯一の形。
    取込元が残っている中断プロジェクトは /normalize で復旧できるので拒否しない
    （test_open_allows_recoverable_project_without_normalized_wav が担保）。
    音源ファイルは実在させる: 実在しないと adopt がコピーを試みず、
    「コピーが残らないこと」の検証にならない。
    """
    data_dir = tmp_path / "data"
    monkeypatch.setenv("SEAM_DATA_DIR", str(data_dir))
    folder = tmp_path / "interrupted"
    folder.mkdir()
    monkeypatch.setenv("SEAM_EXPORT_DIR", str(folder))

    project = ProjectState.new("interrupted", "中断")
    project.status = "ready"
    for index, speaker in enumerate(("A", "B")):
        _write_wav(folder / f"speaker{speaker}.wav")
        project.tracks[speaker].original_file = ""  # 書き出しは取込元参照を落とす
        project.tracks[speaker].normalized_wav = ""  # 素材も同梱していない
        project.blocks.append(
            Block(id=f"b{index}", speaker=speaker, start=0.0, source_start=0.0, source_end=0.5)
        )
    (folder / "project.json").write_text(
        json.dumps(project.to_dict(), ensure_ascii=False), encoding="utf-8"
    )

    # 判定位置そのものを固定する。残骸の有無だけを見ると検証力が参照値に依存し、
    # 「参照が空 → adopt がコピーしない → 判定が後ろでも残骸が出ない」で空振りする
    # （QA指摘）。書き込みを行う _adopt_track_audio が拒否時に**呼ばれない**ことを
    # 直接アサートすれば、フィクスチャの中身に関わらず位置の回帰を捕まえられる。
    calls: list[tuple] = []
    real_adopt = server._adopt_track_audio
    monkeypatch.setattr(
        server,
        "_adopt_track_audio",
        lambda *args, **kwargs: (calls.append(args), real_adopt(*args, **kwargs))[1],
    )

    projects_root = data_dir / "projects"
    before = {p.name for p in projects_root.iterdir()} if projects_root.is_dir() else set()
    for _ in range(3):  # リトライで累積しないことも見る
        res = client.post("/api/projects/open", data={"source_dir": str(folder)})
        assert res.status_code == 400
    assert not calls, "拒否される open が音源コピー(_adopt_track_audio)まで到達した"
    after = {p.name for p in projects_root.iterdir()} if projects_root.is_dir() else set()
    assert after == before, f"拒否した open が残骸を残した: {after - before}"


@requires_ffmpeg
def test_open_allows_recoverable_project_without_normalized_wav(tmp_path, monkeypatch, client):
    """取込元が残っていれば normalized_wav が空でも開ける（QA指摘・誤検知の回帰）。

    取込中にサーバが落ちた / normalize=false で取り込んだ / 元音源と project.json
    だけを別マシンへ持ち出した、はいずれも正当な状態で、`POST /normalize` で
    完全に復旧できる。ここを拒否すると UI の「このトラックを正規化」に永久に
    到達できなくなり、元音源が目の前にあるのに開けない状況になる。

    幽霊（素材を同梱しない書き出し）と区別できるのは、exporter が original_file を
    必ず空にするため。
    """
    data_dir = tmp_path / "data"
    monkeypatch.setenv("SEAM_DATA_DIR", str(data_dir))
    folder = tmp_path / "interrupted"
    folder.mkdir()
    monkeypatch.setenv("SEAM_EXPORT_DIR", str(folder))

    project = ProjectState.new("interrupted", "中断")
    project.status = "ready"
    for index, speaker in enumerate(("A", "B")):
        _write_wav(folder / f"speaker{speaker}.wav")
        project.tracks[speaker].original_file = f"speaker{speaker}.wav"
        project.tracks[speaker].normalized_wav = ""  # 正規化前で中断
        project.blocks.append(
            Block(id=f"b{index}", speaker=speaker, start=0.0, source_start=0.0, source_end=0.5)
        )
    (folder / "project.json").write_text(
        json.dumps(project.to_dict(), ensure_ascii=False), encoding="utf-8"
    )

    res = client.post("/api/projects/open", data={"source_dir": str(folder)})
    assert res.status_code == 200, res.json()
    opened = res.json()["project"]
    assert len(opened["blocks"]) == 2, "ブロックが失われた"
    assert opened["tracks"]["A"]["original_file"], "取込元の参照が落ちた"


def test_export_rejects_missing_audio_with_clear_message(tmp_path, monkeypatch):
    """音源参照が空の書き出しは原因の分かる ValueError にする（QA指摘）。

    `resolve_project_file(id, "")` はプロジェクトディレクトリ自身を返すため、
    そのままだと生の `IsADirectoryError: [Errno 21]` が漏れていた。

    open 側でも幽霊プロジェクトを断っているが、そこは**文書由来の値**で判定する。
    「参照はあるが実体が無い」文書は通り、`_adopt_track_audio` が参照を落とした
    結果この状態になり得るので、書き出し側にも防御を置く。
    """
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-noaudio")
    for speaker in ("A", "B"):
        project.tracks[speaker].normalized_wav = ""
    storage.save_project(project)

    with pytest.raises(ValueError, match="音源がありません") as excinfo:
        export_project(project, tmp_path / "out", export_format="wav")
    assert "Errno 21" not in str(excinfo.value)
    assert "Is a directory" not in str(excinfo.value)


@requires_ffmpeg
def test_partial_resolution_failure_writes_nothing(tmp_path, monkeypatch, client):
    """1件でも解決できない音源があれば1バイトも書かない（フェーズ分離の不変条件）。

    `_adopt_track_audio` は「全部解決してからコピー」の2フェーズ構成で、途中で
    400 になっても部分的な書き込みを残さない。孤児テストは拒否が判定側で起きる
    ケースを見ているが、こちらは**コピー対象が実際に存在する**入力で
    フェーズ分離そのものを固定する（QA指摘: 両者は別の性質）。
    """
    data_dir = tmp_path / "data"
    monkeypatch.setenv("SEAM_DATA_DIR", str(data_dir))
    folder = tmp_path / "half"
    folder.mkdir()
    monkeypatch.setenv("SEAM_EXPORT_DIR", str(folder))

    project = ProjectState.new("half", "片方だけ実在")
    project.status = "ready"
    _write_wav(folder / "speakerA_normalized.wav")  # A は実在
    project.tracks["A"].normalized_wav = "speakerA_normalized.wav"
    project.tracks["B"].normalized_wav = "speakerB_normalized.wav"  # B は実体なし
    for index, speaker in enumerate(("A", "B")):
        project.blocks.append(
            Block(id=f"b{index}", speaker=speaker, start=0.0, source_start=0.0, source_end=0.5)
        )
    (folder / "project.json").write_text(
        json.dumps(project.to_dict(), ensure_ascii=False), encoding="utf-8"
    )

    projects_root = data_dir / "projects"
    before = {p.name for p in projects_root.iterdir()} if projects_root.is_dir() else set()
    res = client.post("/api/projects/open", data={"source_dir": str(folder)})
    assert res.status_code == 400, res.json()
    after = {p.name for p in projects_root.iterdir()} if projects_root.is_dir() else set()
    assert after == before, f"解決に失敗した open が A の音源をコピーして残した: {after - before}"


# ------------------------------------------------ QA: モード遷移時の残骸掃除（Issue #28）


@requires_ffmpeg
def test_reexport_none_after_reeditable_leaves_artifacts_only(tmp_path, monkeypatch):
    """reeditable → none の再エクスポートで同梱物の残骸が消える（QA指摘の本丸）。

    掃除が無いと旧 project.json / README.txt / speakerX_source.wav が残留し、
    「既定=成果物のみ」の保証が最初の1回しか成立しなかった。
    """
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-trans1")
    out = tmp_path / "out"
    export_project(project, out, bundle="reeditable")
    assert (out / "project.json").is_file(), "前提: reeditable が同梱物を書いている"

    export_project(project, out, bundle="none")
    names = {p.name for p in out.iterdir()}
    assert names == {"speakerA.wav", "speakerB.wav", "overlaps.csv"}


@requires_ffmpeg
def test_reexport_reeditable_after_none_is_self_contained(tmp_path, monkeypatch):
    """逆順（none → reeditable）でも自己完結セットが揃う（遷移の対称性）。"""
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-trans2")
    out = tmp_path / "out"
    export_project(project, out, bundle="none")
    export_project(project, out, bundle="reeditable")

    names = {p.name for p in out.iterdir()}
    assert names == {
        "speakerA.wav",
        "speakerB.wav",
        "overlaps.csv",
        "project.json",
        "README.txt",
        "speakerA_source.wav",
        "speakerB_source.wav",
    }
    doc = json.loads((out / "project.json").read_text(encoding="utf-8"))
    assert doc["exported_bundle_mode"] == "reeditable"


@requires_ffmpeg
def test_stale_srt_removed_when_transcript_gone(tmp_path, monkeypatch):
    """文字起こしあり→なしの再エクスポートで旧 transcript.srt が残らない。

    プロジェクトを reeditable 書き出しから開き直すと transcripts を持たない状態が
    正当に起きる。srt 単体では自アプリ産と識別できないため、削除は
    「マーカー付き project.json が同フォルダに在った」ときに限る（識別基準の固定は
    test_cleanup_leaves_unidentifiable_user_files 側）。
    """
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-srtstale")
    project.transcripts.append(
        TranscriptSegment(id="t1", speaker="A", source_start=0.0, source_end=0.4, text="古い字幕")
    )
    out = tmp_path / "out"
    export_project(project, out, bundle="reeditable")
    assert (out / "transcript.srt").is_file()

    project.transcripts.clear()  # 開き直し等で文字起こしが無い状態を再現
    export_project(project, out, bundle="none")
    assert not (out / "transcript.srt").exists(), "旧字幕が成果物フォルダに残った"
    assert {p.name for p in out.iterdir()} == {"speakerA.wav", "speakerB.wav", "overlaps.csv"}


def test_cleanup_leaves_unidentifiable_user_files(tmp_path, monkeypatch):
    """自アプリ産と識別できないファイルは掃除しない（ユーザーファイル絶対保護）。

    識別基準:
    - project.json は `exported_bundle_mode` キーを持つものだけ（無ければユーザーの
      作業ファイルかもしれない）
    - README*.txt は README_MARKER を持つものだけ
    - transcript.srt / speakerX_source.wav は単体で識別できないため、マーカー付き
      project.json が同フォルダに**無い**限り触らない
    掃除ロジックを直接呼ぶ（ffmpeg 不要でどの環境でも走る）。
    """
    from podcast_prep.exporter import _cleanup_stale_export_files

    project = _make_full_project(tmp_path, monkeypatch, pid="proj-userfiles")
    out = tmp_path / "deliver"
    out.mkdir()
    user_doc = {"name": "ユーザーの作業ファイル"}  # exported_bundle_mode 無し
    (out / "project.json").write_text(json.dumps(user_doc, ensure_ascii=False), encoding="utf-8")
    (out / "README.txt").write_text("# ユーザーのメモ\n消すな\n", encoding="utf-8")
    (out / "transcript.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\n手作業の字幕\n", encoding="utf-8")
    (out / "speakerA_source.wav").write_bytes(b"user-owned-bytes")

    _cleanup_stale_export_files(project, out, will_write_srt=False)

    assert json.loads((out / "project.json").read_text(encoding="utf-8")) == user_doc
    assert (out / "README.txt").read_text(encoding="utf-8") == "# ユーザーのメモ\n消すな\n"
    assert "手作業の字幕" in (out / "transcript.srt").read_text(encoding="utf-8")
    assert (out / "speakerA_source.wav").read_bytes() == b"user-owned-bytes"


def test_cleanup_leaves_unparseable_project_json(tmp_path, monkeypatch):
    """パース不能な project.json は識別不能としてスキップし、セット削除も発火しない。"""
    from podcast_prep.exporter import _cleanup_stale_export_files

    project = _make_full_project(tmp_path, monkeypatch, pid="proj-brokenjson")
    out = tmp_path / "deliver"
    out.mkdir()
    (out / "project.json").write_text("{broken json", encoding="utf-8")
    (out / "speakerA_source.wav").write_bytes(b"maybe-user-data")
    (out / "transcript.srt").write_text("壊れたjsonの隣の字幕", encoding="utf-8")

    _cleanup_stale_export_files(project, out, will_write_srt=False)

    assert (out / "project.json").read_text(encoding="utf-8") == "{broken json"
    assert (out / "speakerA_source.wav").is_file()
    assert (out / "transcript.srt").is_file()


def test_cleanup_does_not_recurse_into_subdirectories(tmp_path, monkeypatch):
    """掃除は出力ディレクトリ直下のみ（サブフォルダの成果物・バンドルには触らない）。"""
    from podcast_prep.exporter import _cleanup_stale_export_files

    project = _make_full_project(tmp_path, monkeypatch, pid="proj-norecurse")
    out = tmp_path / "deliver"
    sub = out / "ep12"
    sub.mkdir(parents=True)
    (sub / "project.json").write_text(
        json.dumps({"exported_bundle_mode": "reeditable"}), encoding="utf-8"
    )
    (sub / "README.txt").write_text(
        "# podcast-prep がこのファイルを自動生成しました\n", encoding="utf-8"
    )
    (sub / "speakerA_source.wav").write_bytes(b"nested")

    _cleanup_stale_export_files(project, out, will_write_srt=False)

    assert (sub / "project.json").is_file()
    assert (sub / "README.txt").is_file()
    assert (sub / "speakerA_source.wav").is_file()


@requires_ffmpeg
def test_cleanup_never_deletes_live_project_files(tmp_path, monkeypatch):
    """識別マーカーが在っても**現役の**プロジェクト実体は消さない（復旧困難な破壊の防止）。

    reeditable バンドルを作業フォルダとして開き直すと、そのフォルダの project.json に
    マーカーが残ったまま・素材が speakerX_source.wav という名前で**現役**という状態が
    正当に作れる。そこを出力先に選んで bundle="none" で書き出しても、現役文書と
    素材は生き残らなければならない（inode 比較の保護の固定）。
    """
    project = _make_full_project(tmp_path, monkeypatch, pid="proj-live")
    pdir = storage.project_dir(project.id)
    for speaker in ("A", "B"):
        (pdir / f"speaker{speaker}_normalized.wav").rename(pdir / f"speaker{speaker}_source.wav")
        project.tracks[speaker].normalized_wav = f"speaker{speaker}_source.wav"
    storage.save_project(project)
    # 開き直した reeditable バンドル相当: 現役 project.json にマーカーが残った状態
    doc = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    doc["exported_bundle_mode"] = "reeditable"
    (pdir / "project.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")

    export_project(project, output_dir=pdir, export_format="wav", bundle="none")

    assert (pdir / "project.json").is_file(), "現役の project.json が消された"
    for speaker in ("A", "B"):
        assert (pdir / f"speaker{speaker}_source.wav").is_file(), "現役の素材が消された"
        assert (pdir / f"speaker{speaker}.wav").is_file(), "納品物が出力されていない"
