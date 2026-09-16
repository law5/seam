from __future__ import annotations

import json
import shutil
from collections.abc import Callable
from copy import deepcopy
from pathlib import Path
from typing import Any

from .audio import encode_mp3, render_edited_track, write_overlaps_csv
from .models import ProjectState, SPEAKERS, Speaker
from .storage import project_json_path, resolve_project_file
from .timeline import segments_to_srt, timeline_end, timeline_transcript_segments


# 同梱モード（実機フィードバック: 中間生成物が多く、どれを消していいか分からない）。
# - "none":     成果物のみ（speakerX.wav|mp3 + overlaps.csv + 文字起こし済みなら
#               transcript.srt）。**既定**。project.json / README.txt は同梱しない —
#               このモードの project.json は音源参照が空で「開く」に使えず、
#               開けない内部ファイルを成果物に混ぜるのが混乱の元だった（Issue #28）
# - "reeditable": 成果物 + 再編集用の素材 speakerX_source.wav（= normalized_wav の複製）
#               + project.json + README.txt。フォルダ単体で「開く」に渡せる自己完結バンドル
#
# `_original`（取込元）の同梱は廃止した。normalized_wav があれば編集・再生・書き出しは
# 完結し、`_original` が要るのは「ラウドネスをかけ直す」ときだけ。その1機能のために
# 60分素材で +47MB（mp3）〜+数百MB（wav 取込）を毎回積むのは割に合わず、
# 「_source と _original の違いが分からない」混乱の主因でもあった。
# 開く側は original_file 欠損を許容する（server._adopt_track_audio が参照を落として開く）。
BUNDLE_MODES = ("none", "reeditable")
DEFAULT_BUNDLE_MODE = "none"

# 書き出し形式 → (拡張子, MP3ビットレート kbps。None は非MP3)。
# 値は API の format / project.json の settings.export_format / UI の <select> の
# 3層で共有する契約（Issue #32）。既存の "mp3" は **320kbps のまま**据え置く
# （保存済み project.json・API 呼び出しの後方互換）。192kbps は新値 "mp3_192"。
EXPORT_FORMATS: dict[str, tuple[str, int | None]] = {
    "wav": ("wav", None),
    "mp3": ("mp3", 320),
    "mp3_192": ("mp3", 192),
}

# エクスポートが出力先へ書き得る成果物のファイル名（上書き事前チェック用・Issue #32）。
# wav / mp3 の両方を挙げるのは、前回と違う形式で同じフォルダへ書き出し直すケースも
# 「前回のエクスポート成果物が既にある」として上書き確認の対象にするため。
# reeditable 専用の project.json / README.txt / speakerX_source.wav は含めない
# （単体では自アプリ産と識別できない名前で、誤検知の方が害が大きい。実在すれば
# どのみち成果物 speakerX.* も並んでいるのが通常形）。
EXPORT_ARTIFACT_NAMES: tuple[str, ...] = tuple(
    f"speaker{speaker}.{ext}" for speaker in SPEAKERS for ext in ("wav", "mp3")
) + ("transcript.srt", "overlaps.csv")
# README.txt の自動生成マーカー（1行目に置く）。書き出し先にはユーザーが選んだ任意の
# フォルダを指定できるようになったため、そこに元からある README.txt を無警告で
# 潰す可能性がある（QA指摘）。この行が無いファイルは他人のものとして退避する。
README_MARKER = "# seam がこのファイルを自動生成しました"
# 旧名 podcast-prep 時代に書き出した README も「自分のもの」として認識する。
# これが無いと、過去の書き出しフォルダへ再書き出ししたときに自作 README を
# 他人のものと誤認して退避し続ける（README が積み上がる）。
_LEGACY_README_MARKERS = ("# podcast-prep がこのファイルを自動生成しました",)


def _points_at_same_file(material: Path, target: Path) -> bool:
    """`material` と `target` が同じ実体を指すか。

    パス文字列の一致では不十分（QA指摘・Critical）:
    - macOS / Windows の既定FSは **大文字小文字を区別しない**。素材が `SPEAKERA.WAV`
      でレンダリング先が `speakerA.wav` だと文字列は一致しないのに書き込み先は同じ実体。
      録音機材が大文字の名前を吐くのは珍しくないため、実運用で踏み得る。
    - ハードリンクは `resolve()` では解けない（別名・別パスだが同一 inode）。

    どちらも `(st_dev, st_ino)` の一致で捕まる。`target` は未作成のことが多いので、
    実体が無ければ resolve 済みパスの比較にフォールバックする（作成前は同一FSの
    同一パスでしか衝突し得ないため、これで十分）。
    """
    try:
        material_stat = material.stat()
        target_stat = target.stat()
    except OSError:
        return material == target
    return (material_stat.st_dev, material_stat.st_ino) == (
        target_stat.st_dev,
        target_stat.st_ino,
    )


def _export_source_audio(
    project_id: str, value: str, output_dir: Path, dest_stem: str
) -> str:
    """素材音源を出力先へコピーし、project.json に書く**相対参照（ファイル名）**を返す。

    可搬性の要件は「フォルダごと移動しても開ける」なので、参照は必ず
    project.json と同階層のファイル名にする（Issue #19）。

    - value が空（未取込トラック）ならコピーせず空文字のまま返す
    - 解決に失敗する値（トラバーサル混入した永続化文書）もコピーせず素通しする。
      ここで例外を投げるとエクスポート全体が落ちるため、可搬化を諦めるだけに留める
      （開く側の解決で 400 になる）
    - コピー元と先が同一ファイルなら何もしない（出力先がプロジェクト配下のとき）
    """
    if not value:
        return ""
    try:
        source = resolve_project_file(project_id, value)
    except ValueError:
        return value
    if not source.is_file():
        return value
    dest = output_dir / f"{dest_stem}{source.suffix}"
    if dest.resolve() != source.resolve():
        shutil.copyfile(source, dest)
    return dest.name


def _is_own_readme(path: Path) -> bool:
    """`path` が seam 自身が書いた README か（= 上書きしてよいか。旧名時代のものも含む）。

    先頭の BOM も剥がす。自動生成した README をエディタが BOM 付きで保存し直すと、
    次回から自分のファイルを他人と誤認して退避が積み上がる（QA指摘）。
    """
    try:
        head = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    head = head.lstrip("﻿").lstrip()
    return head.startswith(README_MARKER) or head.startswith(_LEGACY_README_MARKERS)


def _is_own_project_json(path: Path) -> bool:
    """`path` が本アプリの書き出した project.json か（= 掃除してよいか）。

    `exported_bundle_mode` キーは exporter だけが書く（models.ProjectState.to_dict
    は出力せず、開き直し時の save_project でも落ちる）ため、これを識別子にする。
    パース不能・キー無しはユーザーの作業ファイルの可能性があるので触らない（安全側）。
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and "exported_bundle_mode" in data


def _cleanup_stale_export_files(
    project: ProjectState, output_dir: Path, *, will_write_srt: bool
) -> None:
    """前回エクスポートの残骸のうち**自アプリ産と識別できるものだけ**を掃除する。

    同じ出力先へ bundle="reeditable" → "none" と書き出し直すと、旧 project.json /
    README.txt / speakerX_source.wav が残って「既定=成果物のみ」の保証が破れていた
    （QA指摘・Issue #28）。文字起こしあり→なしの再エクスポートでも旧 transcript.srt
    が残る。エクスポート冒頭でこれらを片付けてから書き出す。

    識別基準（ユーザー自身のファイルは絶対に消さない）:
    - README*.txt: 1行目の README_MARKER を持つものだけ（既存の退避採番と同じ判定）
    - project.json: `exported_bundle_mode` キーを持つものだけ（_is_own_project_json）
    - speakerX_source.wav / transcript.srt: 単体では識別できないため、
      **マーカー付き project.json が同フォルダに在ったときだけ** reeditable セットの
      一部とみなして消す。識別できないものは残す（安全側）
    - 掃除は出力ディレクトリ直下のみ・ファイルのみ（再帰しない）

    さらに、生きているプロジェクトの実体は識別マーカーがあっても消さない:
    作業フォルダ（開き直した reeditable バンドル等）を出力先に選ぶと、
    output_dir/project.json や speakerX_source.wav が**現役の**プロジェクト文書・
    素材そのものになり得る。ここで消すと素材の復旧困難な破壊になるため、
    live project.json と各トラックの参照先は inode 比較（_points_at_same_file）で
    除外する。
    """
    protected: list[Path] = [project_json_path(project.id)]
    for speaker in SPEAKERS:
        track = project.tracks[speaker]
        for value in (track.normalized_wav, track.original_file):
            if not value:
                continue
            try:
                protected.append(resolve_project_file(project.id, value))
            except (ValueError, OSError):
                continue

    def _deletable(candidate: Path) -> bool:
        return candidate.is_file() and not any(
            _points_at_same_file(live, candidate) for live in protected
        )

    for readme in sorted(output_dir.glob("README*.txt")):
        if _deletable(readme) and _is_own_readme(readme):
            readme.unlink(missing_ok=True)

    marker = output_dir / "project.json"
    if not (_deletable(marker) and _is_own_project_json(marker)):
        # 自アプリ産と識別できない（or 現役ファイル）なら、_source / srt も
        # reeditable セットの一部と断定できないので何も消さない
        return
    marker.unlink(missing_ok=True)
    for speaker in SPEAKERS:
        source = output_dir / f"speaker{speaker}_source.wav"
        if _deletable(source):
            source.unlink(missing_ok=True)
    if not will_write_srt:
        srt = output_dir / "transcript.srt"
        if _deletable(srt):
            srt.unlink(missing_ok=True)


def _readme_destination(output_dir: Path) -> Path:
    """README の書き込み先。他人のファイルは決して潰さない。

    書き出し先にはユーザーが選んだ任意のフォルダ（納品フォルダ等）を指定できるため、
    そこに元からある README.txt を無警告で上書きしない。退避先が既に埋まっている
    場合も同じ判定を繰り返して採番する（退避先だけ無防備だと、守ろうとした性質が
    そこで破れる — QA指摘）。
    """
    primary = output_dir / "README.txt"
    if not primary.exists() or _is_own_readme(primary):
        return primary
    for suffix in ("", *(f"-{n}" for n in range(2, 100))):
        candidate = output_dir / f"README_seam{suffix}.txt"
        if not candidate.exists() or _is_own_readme(candidate):
            return candidate
    # 100個埋まっているのは異常。README のために書き出し全体を落とす筋合いはないので
    # 最後の候補を使う（この状況では何を選んでも誰かの README を潰す）。
    return output_dir / "README_seam-99.txt"


def _readme_text(project: ProjectState, fmt: str, has_srt: bool) -> str:
    """再編集バンドル（bundle="reeditable"）の出力フォルダに置く説明書き。

    実機フィードバック「どれを削除していいのかも分かりづらい」への直接の回答。
    ファイルごとに『納品用 / 再編集用 / 消してよい』を明示する。

    bundle="none" では README 自体を書かない（Issue #28）: 成果物だけのフォルダに
    説明が要るファイルは無く、README を混ぜること自体が「内部ファイルと成果物の
    区別がつかない」の一因だった。
    """
    lines = [
        README_MARKER,
        f"{project.name} — seam 書き出し",
        "",
        "■ このフォルダの中身",
        "",
        f"  speakerA.{fmt} / speakerB.{fmt}",
        "      納品物。編集後の音声です。2トラックは同じ長さなので、",
        "      Premiere 等に並べてそのまま整列します。",
        "",
    ]
    if has_srt:
        lines.append("  transcript.srt      字幕（編集後のタイムライン基準）")
    lines += [
        "  overlaps.csv        話者の被り一覧",
        "  project.json        編集内容（カット位置・文字起こし）",
        "",
        "  speakerA_source.wav / speakerB_source.wav",
        "      再編集用の素材（編集前・正規化済み）。",
        "      これがあると、このフォルダを seam の「開く」に渡して",
        "      続きから編集できます。フォルダごと移動しても大丈夫です。",
        "",
        "■ 容量を減らしたいとき",
        "",
        "  納品だけが目的で、もう編集し直さないなら",
        "  speakerA_source.wav と speakerB_source.wav は削除して構いません",
        "  （このフォルダから「開く」ことはできなくなります）。",
        "  それ以外のファイルは消さないでください。",
        "",
        "(このファイルは書き出しのたびに自動生成されます)",
        "",
    ]
    return "\n".join(lines)


def export_project(
    project: ProjectState,
    output_dir: Path,
    export_format: str = "wav",
    progress: Callable[[Speaker, float], None] | None = None,
    bundle: str = DEFAULT_BUNDLE_MODE,
) -> dict[str, str]:
    """編集結果を output_dir へ書き出す。

    `bundle` が同梱ポリシー（BUNDLE_MODES）:
    - "none"（既定）: 成果物のみ = 納品物 + overlaps.csv（+ 文字起こし済みなら
      transcript.srt）。project.json / README.txt は同梱しない（Issue #28 —
      開けない project.json を成果物に混ぜない）。**保存するデータ量が最小**
    - "reeditable": 成果物 + speakerX_source.wav + project.json + README.txt。
      フォルダごと移動して開ける（Issue #19 の可搬性要件はこのモードが担保する）

    transcript.srt は両モードとも文字起こしが存在するときだけ生成する
    （未文字起こしの空 SRT を成果物に混ぜない — Issue #28）。
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    fmt = export_format.lower()
    if fmt not in EXPORT_FORMATS:
        raise ValueError(
            "export format must be one of " + ", ".join(EXPORT_FORMATS)
        )
    # ext は成果物の拡張子（"mp3_192" でも speakerX.mp3）。mp3_bitrate は
    # None = WAV のまま / 数値 = その CBR ビットレートでエンコード。
    ext, mp3_bitrate = EXPORT_FORMATS[fmt]
    bundle_mode = (bundle or DEFAULT_BUNDLE_MODE).lower()
    if bundle_mode not in BUNDLE_MODES:
        raise ValueError(f"bundle must be one of {', '.join(BUNDLE_MODES)}")

    files: dict[str, str] = {}
    crossfade_ms = float(project.settings.get("crossfade_ms", 10.0))
    # 編集後タイムラインの末端が出力尺（元素材フル尺の下限は撤廃 — WYSIWYG）。
    # 両話者に同一の minimum_duration を渡す2トラック等長（Premiere 整列要件）は維持。
    timeline_duration = timeline_end(project.blocks)
    if timeline_duration <= 0:
        raise ValueError("nothing to export: no active blocks")

    # 音源参照が空のまま書き出そうとすると `resolve_project_file(id, "")` が
    # プロジェクトディレクトリ自身を返し、生の `IsADirectoryError` が漏れていた。
    # open 側でも幽霊プロジェクトを断っているが、そこは文書由来の値で判定するため
    # 「参照はあるが実体が無い」文書は通り、開いた後にこの状態になり得る。
    # 原因の分かるメッセージをここで出す（QA指摘）。
    missing = [s for s in SPEAKERS if not project.tracks[s].normalized_wav]
    if missing:
        raise ValueError(
            "話者 " + " / ".join(missing) + " の音源がありません。"
            "取込をやり直すか、素材を同梱した書き出しから開き直してください"
        )

    # 出力先が素材そのものを指す場合は書き出さない（QA指摘）。
    # 例: 出力先にプロジェクトディレクトリ自身を指定すると、納品物 speakerX.wav の
    # レンダリングが取込元（同名の original_file）を上書きし、素材が破壊される。
    # 同梱バックアップも破壊後のバイト列を掴むため、後から復元もできない。
    out_resolved = output_dir.resolve()
    for speaker in SPEAKERS:
        track = project.tracks[speaker]
        rendered = (out_resolved / f"speaker{speaker}.{ext}").resolve()
        rendered_wav = (out_resolved / f"speaker{speaker}.wav").resolve()
        for value in (track.original_file, track.normalized_wav):
            if not value:
                continue
            try:
                material = resolve_project_file(project.id, value).resolve()
            except (ValueError, OSError):
                continue
            if _points_at_same_file(material, rendered) or _points_at_same_file(
                material, rendered_wav
            ):
                raise ValueError(
                    "export target would overwrite the source audio "
                    f"({material.name}) — 別のフォルダを指定してください"
                )

    # 前回エクスポートの残骸を掃除してから書き出す（QA指摘・Issue #28）。
    # 全バリデーション通過後・書き出し開始前に行う（拒否されるエクスポートは
    # 1バイトも消さない・書くファイルは掃除後の上書きで常に最新になる）。
    _cleanup_stale_export_files(
        project, output_dir, will_write_srt=bool(project.transcripts)
    )

    for speaker in SPEAKERS:
        track = project.tracks[speaker]
        source_wav = resolve_project_file(project.id, track.normalized_wav)
        wav_name = f"speaker{speaker}.wav"
        wav_path = output_dir / wav_name
        # progress は render_edited_track のブロック進捗(0..1)を (speaker, fraction) で中継。
        # 未指定時は kwargs に含めない（render_edited_track のシグネチャ互換を保つ）。
        render_kwargs: dict[str, Any] = {}
        if progress is not None:
            render_kwargs["progress"] = (
                lambda fraction, _speaker=speaker: progress(_speaker, fraction)
            )
        render_edited_track(
            source_wav=source_wav,
            blocks=project.blocks,
            speaker=speaker,
            output_wav=wav_path,
            gain_db=track.gain_db,
            deesser=track.deesser,
            crossfade_ms=crossfade_ms,
            minimum_duration=timeline_duration,
            **render_kwargs,
        )
        if mp3_bitrate is None:
            files[wav_name] = str(wav_path)
        else:
            mp3_name = f"speaker{speaker}.mp3"
            mp3_path = output_dir / mp3_name
            encode_mp3(wav_path, mp3_path, bitrate_kbps=mp3_bitrate)
            wav_path.unlink(missing_ok=True)
            files[mp3_name] = str(mp3_path)

    # transcript.srt は文字起こしが存在するときだけ生成する（Issue #28）。
    # 以前は未文字起こしでも空の SRT を必ず書いており、成果物フォルダに
    # 「中身の無いファイル」が混ざる混乱の一因だった。
    if project.transcripts:
        srt_path = output_dir / "transcript.srt"
        srt = segments_to_srt(timeline_transcript_segments(project.blocks, project.transcripts))
        srt_path.write_text(srt, encoding="utf-8")
        files["transcript.srt"] = str(srt_path)

    overlaps_path = output_dir / "overlaps.csv"
    write_overlaps_csv(project.overlaps, overlaps_path)
    files["overlaps.csv"] = str(overlaps_path)

    # project.json / README.txt は再編集バンドルにだけ同梱する（Issue #28）。
    # bundle="none" の project.json は音源参照が空で「開く」に使えず、開けない
    # 内部ファイルを成果物に混ぜるのが「どれが成果物か分からない」の核心だった。
    if bundle_mode == "reeditable":
        project_path = output_dir / "project.json"
        export_data = deepcopy(project.to_dict())
        for speaker in SPEAKERS:
            track = project.tracks[speaker]
            # 取込元（_original）は同梱しない。用途が「ラウドネスのかけ直し」だけで、
            # 素材としては normalized_wav が上位互換だったため（BUNDLE_MODES のコメント参照）。
            # 参照も落とす: 同梱していないファイル名を書き残すと、開く側が探しに行って
            # 「音源ファイルが見つかりません」の原因になる。
            export_data["tracks"][speaker]["original_file"] = ""
            # Issue #19: 音源は project.json 自身からの相対（= ファイル名のみ）で参照する。
            # 絶対パスで書くと「フォルダごと別の場所へ移動」した時点で参照が切れる。
            #
            # 参照先は同ディレクトリへコピーした素材本体 speakerX_source.wav であって、
            # 隣にある speakerX.wav（= 編集後レンダリング）ではない。両者を混同すると
            # 開き直したときにブロック座標が「既にカット済みの音声」へ適用され、
            # 二重編集になる（speakerX.wav は納品物、_source.wav は再編集用の素材）。
            export_data["tracks"][speaker]["normalized_wav"] = _export_source_audio(
                project.id, track.normalized_wav, output_dir, f"speaker{speaker}_source"
            )
        # 開く側が「素材を抜いた書き出しか」を推測せず判定できるようにする。
        # 音源の有無だけで見ると、音源未設定の新規プロジェクトと区別がつかない。
        export_data["exported_bundle_mode"] = bundle_mode
        project_path.write_text(
            json.dumps(export_data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        files["project.json"] = str(project_path)

        readme_path = _readme_destination(output_dir)
        readme_path.write_text(
            _readme_text(project, ext, has_srt="transcript.srt" in files),
            encoding="utf-8",
        )
        files[readme_path.name] = str(readme_path)
    return files
