from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

Speaker = Literal["A", "B"]
SPEAKERS: tuple[Speaker, Speaker] = ("A", "B")


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _float(value: Any, default: float = 0.0) -> float:
    if value is None:
        return default
    return float(value)


@dataclass(slots=True)
class Block:
    id: str
    speaker: Speaker
    source_start: float
    source_end: float
    start: float
    text: str = ""
    deleted: bool = False

    @property
    def duration(self) -> float:
        return max(0.0, self.source_end - self.source_start)

    @property
    def end(self) -> float:
        return self.start + self.duration

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["duration"] = self.duration
        data["end"] = self.end
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Block":
        return cls(
            id=str(data["id"]),
            speaker=data["speaker"],
            source_start=_float(data.get("source_start")),
            source_end=_float(data.get("source_end")),
            start=_float(data.get("start")),
            text=str(data.get("text", "")),
            deleted=bool(data.get("deleted", False)),
        )


def _word_from_dict(data: dict[str, Any]) -> dict[str, Any]:
    """単語エントリの正規化。end 欠損は start に落とす（中点計算を壊さない）。"""
    start = _float(data.get("start"))
    return {
        "start": start,
        "end": _float(data.get("end"), start),
        "text": str(data.get("text", "")),
    }


@dataclass(slots=True)
class TranscriptSegment:
    id: str
    speaker: Speaker
    source_start: float
    source_end: float
    text: str
    block_id: str | None = None
    # 単語タイムスタンプ [{start, end, text}]（source 時間軸）。
    # word_timestamps=True で文字起こしした場合のみ非空。旧データは欠損 → []（後方互換、
    # schema_version 1 のまま additive）。text は Whisper の生 word（先頭空白を含みうる）。
    words: list[dict[str, Any]] = field(default_factory=list)

    @property
    def duration(self) -> float:
        return max(0.0, self.source_end - self.source_start)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TranscriptSegment":
        return cls(
            id=str(data["id"]),
            speaker=data["speaker"],
            source_start=_float(data.get("source_start")),
            source_end=_float(data.get("source_end")),
            text=str(data.get("text", "")),
            block_id=data.get("block_id"),
            words=[
                _word_from_dict(w) for w in (data.get("words") or []) if isinstance(w, dict)
            ],
        )


@dataclass(slots=True)
class Overlap:
    # 旧フィールド `resolved` は削除（2026-08）。値を true にする経路がコード上に
    # 一切存在せず常に false の定数だったため、UIチップ・overlaps.csv 列ともに情報を
    # 持っていなかった。分類は応答生成時に導出する `category`（server._project_payload）が担う。
    # 後方互換: from_dict は未知キーを無視するので `"resolved": false` を含む旧 project.json も読める。
    start: float
    end: float
    duration: float
    block_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class TrackState:
    speaker: Speaker
    label: str
    original_file: str = ""
    normalized_wav: str = ""
    duration: float = 0.0
    gain_db: float = 0.0
    deesser: float = 0.0
    offset_seconds: float = 0.0
    loudness: dict[str, Any] = field(default_factory=dict)
    peaks: list[float] = field(default_factory=list)
    # normalized_wav が loudnorm 済みか（False = convert_to_pcm の素の形式変換のみ）。
    # 取込時のトグル（POST /api/projects の normalize）と後がけ
    # POST /api/projects/{id}/normalize が更新する。UI の現在状態表示用。
    # 旧 project.json は欠損 → loudness に計測値があれば True とみなす（from_dict）。
    loudness_normalized: bool = False

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        # ピークは project_dir/{speakerA|speakerB}_peaks.u8 サイドカーへ移行済み。
        # project.json には常に空で書く（フィールドは from_dict の欠損許容で後方互換）。
        data["peaks"] = []
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any], speaker: Speaker) -> "TrackState":
        loudness = dict(data.get("loudness", {}))
        if "loudness_normalized" in data:
            normalized = bool(data["loudness_normalized"])
        elif "loudness_normalized" in loudness:
            # audio.normalize_loudnorm / convert_to_pcm が結果 dict に埋めるマーカー
            normalized = bool(loudness["loudness_normalized"])
        else:
            # 旧 project.json（取込時は必ず loudnorm していた）: 計測値があれば正規化済み
            normalized = loudness.get("normalized") is not None
        return cls(
            speaker=speaker,
            label=str(data.get("label", speaker)),
            original_file=str(data.get("original_file", "")),
            normalized_wav=str(data.get("normalized_wav", "")),
            duration=_float(data.get("duration")),
            gain_db=_float(data.get("gain_db")),
            deesser=_float(data.get("deesser")),
            offset_seconds=_float(data.get("offset_seconds")),
            loudness=loudness,
            peaks=[float(v) for v in data.get("peaks", [])],
            loudness_normalized=normalized,
        )


# settings の既知数値キー（from_dict で型強制する。QA指摘: 非数値の settings が
# verbatim マージで永続化されると、以後の保存系が bare float()/int() で全て 500 になる）
FLOAT_SETTINGS_KEYS: tuple[str, ...] = (
    "target_lufs",
    "true_peak",
    "lra",
    "tolerance",
    "min_overlap_s",
    "crossfade_ms",
    "auto_edit_max_gap_s",
    "auto_edit_keep_gap_s",
    "auto_edit_max_overlap_s",
    "auto_edit_keep_overlap_s",
)
INT_SETTINGS_KEYS: tuple[str, ...] = (
    "sample_rate",
    "vad_aggressiveness",
    "peaks_bins_per_sec",
)


def coerce_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """既知の数値 settings キーを float/int に型強制する（in-place で返す）。

    変換不能（None・非数値文字列など）は ValueError に正規化する。呼び出し元の
    open / raw PUT ハンドラは ValueError を 400 に変換する。未知キーは触らない。
    """
    for key in FLOAT_SETTINGS_KEYS:
        if key in settings:
            try:
                settings[key] = float(settings[key])
            except (TypeError, ValueError):
                raise ValueError(f"settings.{key} must be a number") from None
    for key in INT_SETTINGS_KEYS:
        if key in settings:
            try:
                settings[key] = int(settings[key])
            except (TypeError, ValueError):
                raise ValueError(f"settings.{key} must be an integer") from None
    return settings


def default_settings() -> dict[str, Any]:
    # target_lufs / true_peak / tolerance はフロントの既定値定数
    # static/js/utils.js LOUDNORM_DEFAULTS（リセットボタンが使う）と対応。
    # 変更時は両方を揃えること（Issue #37）。
    return {
        "target_lufs": -16.0,
        "true_peak": -1.5,
        "lra": 11.0,
        # 許容量(LU): 計測パスの input_i が 目標±この値 以内なら loudnorm 適用を
        # スキップする（0 = 常に正規化。audio.should_skip_loudnorm。Issue #37）
        "tolerance": 0.5,
        "min_overlap_s": 0.3,
        "crossfade_ms": 10.0,
        "sample_rate": 48000,
        "vad_aggressiveness": 2,
        "whisper_model": "medium",
        # 計算精度・デバイス（Issue #12）。"auto" 以外を明示設定すると環境変数
        # （SEAM_WHISPER_COMPUTE_TYPE / _DEVICE）より優先される
        # （transcribe.resolve_whisper_runtime）。旧 project.json は from_dict の
        # デフォルトマージで "auto" に補完される（後方互換）。
        "whisper_compute_type": "auto",
        "whisper_device": "auto",
        "export_format": "wav",
        "peaks_bins_per_sec": 200,
        "auto_edit_max_gap_s": 1.5,      # これ超（strict >）の両話者無音を詰める
        "auto_edit_keep_gap_s": 0.5,     # 詰め後に残す呼吸ギャップ
        "auto_edit_max_overlap_s": 3.0,  # これ超の被りは自動解消しない（意図的クロストーク想定）
        "auto_edit_keep_overlap_s": 0.0, # 解消後に残す被り（0=完全直列。min_overlap_s 未満必須）
    }


@dataclass(slots=True)
class ProjectState:
    id: str
    name: str
    created_at: str
    updated_at: str
    status: str
    settings: dict[str, Any]
    tracks: dict[Speaker, TrackState]
    blocks: list[Block] = field(default_factory=list)
    transcripts: list[TranscriptSegment] = field(default_factory=list)
    overlaps: list[Overlap] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "id": self.id,
            "name": self.name,
            "created_at": self.created_at,
            # 再スタンプしない: updated_at のスタンプは storage.save_project /
            # save_project_dict が書き込み直前に行う（GET が読み取りだけで値を変えない）
            "updated_at": self.updated_at,
            "status": self.status,
            "settings": self.settings,
            "tracks": {speaker: track.to_dict() for speaker, track in self.tracks.items()},
            "blocks": [block.to_dict() for block in self.blocks],
            "transcripts": [segment.to_dict() for segment in self.transcripts],
            "overlaps": [overlap.to_dict() for overlap in self.overlaps],
        }

    @classmethod
    def new(cls, project_id: str, name: str) -> "ProjectState":
        now = utc_now_iso()
        return cls(
            id=project_id,
            name=name,
            created_at=now,
            updated_at=now,
            status="created",
            settings=default_settings(),
            tracks={
                "A": TrackState(speaker="A", label="Speaker A"),
                "B": TrackState(speaker="B", label="Speaker B"),
            },
        )

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ProjectState":
        settings = default_settings()
        settings.update(dict(data.get("settings", {})))
        # 欠損キーは上のデフォルトマージで補完済み。存在するキーだけ型強制する
        # （非数値は ValueError → open / raw PUT が 400 化）
        coerce_settings(settings)
        tracks_raw = data.get("tracks", {})
        tracks = {
            speaker: TrackState.from_dict(tracks_raw.get(speaker, {}), speaker)
            for speaker in SPEAKERS
        }
        return cls(
            id=str(data["id"]),
            name=str(data.get("name", data["id"])),
            created_at=str(data.get("created_at", utc_now_iso())),
            updated_at=str(data.get("updated_at", utc_now_iso())),
            status=str(data.get("status", "ready")),
            settings=settings,
            tracks=tracks,
            blocks=[Block.from_dict(item) for item in data.get("blocks", [])],
            transcripts=[
                TranscriptSegment.from_dict(item) for item in data.get("transcripts", [])
            ],
            overlaps=[
                Overlap(
                    start=_float(item.get("start")),
                    end=_float(item.get("end")),
                    duration=_float(item.get("duration")),
                    # 旧 project.json の "resolved" は読み捨てる（常に false の定数だった）
                    block_ids=[str(v) for v in item.get("block_ids", [])],
                )
                for item in data.get("overlaps", [])
            ],
        )
