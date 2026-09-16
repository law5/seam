# Implementation Notes

## 実装サマリー

- `uv` 管理の Python 3.12+ / FastAPI アプリ。既定は `127.0.0.1:4520`（`SEAM_HOST` / `SEAM_PORT` / `SEAM_DATA_DIR` で変更可能。旧 `PODCAST_PREP_*` も当面読む）。
- 取込: ffmpeg `loudnorm` 3パス正規化（計測 → linear適用 → 検証）（`-progress pipe:1` の実測進捗つき。linear 適用が dynamic へフォールバックした場合は `normalization_fallback` を記録）→ VAD（webrtcvad + エネルギー判定フォールバック）→ 波形ピーク生成。
- ピークは PPK1 形式（200 bins/秒・Uint8・自己記述ヘッダ）のサイドカーバイナリ `speaker{A,B}_peaks.u8` として保存し、`GET /peaks/{speaker}` はバイナリ配信。`project.json` にはピークを埋め込まない（旧プロジェクトは初回アクセス時に遅延生成）。
- フロントは wavesurfer.js を全廃し、素の ES modules（`static/js/`、ビルドなし・外部CDN依存なし）で再構築:
  - クリップ式波形描画 — 単一スクロールコンテナ + sticky canvas の仮想スクロール、ビューポートカリング、DPR対応
  - 自前再生エンジン — 正規化WAVを HTTP Range で PCM スライス取得（既存 FileResponse をそのまま利用）→ Int16 の 10秒チャンク LRU → `AudioBufferSourceNode` 先読みスケジューリング。A/B は同一 AudioContext クロックで同期
  - 被りのローカルスイープ再計算・文字起こしのタイムライン射影は `timeline.py` と同値（`tools/gen_js_fixtures.py` で生成するゴールデンフィクスチャで Python/JS の乖離を固定）
  - 編集は `edits.commitEdit` の1本に統一（履歴 → ミューテート → ローカル被り更新 → 保存デバウンス）。Undo/Redo 20段
- 自動編集エンジン「auto-tighten」: `timeline.py` の純関数（被り解消 → 無音詰めの固定順、prefix-sum + bisect の1パス）+ 同期 `POST /api/projects/{id}/auto_edit`（`dry_run` 既定 true・blocks digest による楽観ロック）。ブロックは出力座標 `start` のみ変更し、ソース座標は不変（文字起こし・SRT はブロックと平行移動）。
- ディエッサーはスライダー値 s を `i = 0.3 + 0.5s` / `m = max(0.1, 0.5 - 0.4s)` に再マッピング（合成音声の実測で特定したデッドゾーンの解消。s=0 は完全バイパス）。
- Whisper モデルは `scripts/fetch_whisper_model.sh` でセットアップ時に一度ダウンロードし、`<データディレクトリ>/models/faster-whisper-{name}` から解決する。未配置時はセットアップ手順へ誘導するエラーを返し、旧実装の暗黙ダウンロード経路は塞いだ。
- エクスポートはタイムライン末端（アクティブブロックの最大 end）ベースの尺で出力（詰めた分だけ WAV が短くなる）。両話者 WAV は等長（Premiere 整列要件）。アクティブブロック 0 件は明示エラー。既定の出力先は `exports/` 直下・毎回上書き（Issue #28 で `latest` サブフォルダを廃止。ラベル指定時は `exports/<label>`）。同梱物は bundle で決まる（既定 `none` = 納品物 + overlaps.csv + 文字起こし済みなら SRT のみ。`reeditable` = + `speakerX_source.wav` + project.json + README.txt。API 専用でフロントは bundle を送らず常に none、UI 未対応）。overlaps.csv は 2026-08 に `resolved` 列を廃止し `start,end,duration` の3列。

## 主要ファイル

- `src/podcast_prep/server.py`: FastAPI API、ジョブ管理、auto_edit エンドポイント、静的UI配信。
- `src/podcast_prep/audio.py`: loudnorm、deesser、ffmpeg 進捗パース、PPK1 ピーク生成、PCM 編集レンダリング（numpy 化済み）。
- `src/podcast_prep/vad.py`: webrtcvad ベースの発話検出とエネルギー判定フォールバック。
- `src/podcast_prep/timeline.py`: ブロック編集、被り検出（スイープ）、自動編集エンジン、SRT タイムスタンプ変換。
- `src/podcast_prep/transcribe.py`: faster-whisper ローカル文字起こしとモデル解決。
- `src/podcast_prep/exporter.py`: WAV/MP3/CSV 書き出し（SRT は文字起こし済み時、project.json / README.txt は bundle=reeditable 時のみ）。
- `src/podcast_prep/static/js/`: フロント本体（state / timelineModel / waveform / player / pcm / peaks / api / persistence / history ほか、素の ES modules）。
- `scripts/fetch_whisper_model.py` / `.sh`: Whisper モデルの事前ダウンロード。
- `tools/gen_js_fixtures.py`: timeline.py から JS テスト用ゴールデンフィクスチャを生成。
- `tests/`: pytest（timeline / auto-tighten / audio / transcribe 解決 / パストラバーサル）+ `tests/js/`（node --test）。

## VAD選定

`webrtcvad` を採用。silero-vad は精度面の利点がある一方で torch 依存が重いため、ローカルWebアプリの導入負荷と90分素材の実用速度を優先した。検出・可視化と人間による調整が主目的（自動調整は opt-in の補助）なので、軽量な `webrtcvad` が適切と判断した。

## アーカイブ / 自動復元（Issue #22）の設計判断

- **方式**: 「アーカイブ（中間WAV削除）→ 開くとき復元」。元ファイル直読み化（Issue #15）はスコープ外。
- **_run_normalize の性質を再利用**: 後がけ正規化が確立した不変条件「元音源 → 中間WAV再生成は時間軸不変・blocks/transcripts/overlaps は保持」をそのまま使う。復元ジョブ（`server._run_restore`）は normalized_wav の実体だけを作り直し、VAD・文字起こし・ピーク生成は再実行しない（peaks.u8 は約1MBなので削除対象外 = 開いた瞬間の波形表示に使う）。保存も `_run_normalize` と同じ「最新文書へのマージ」で lost update を防ぐ。
- **正規化適用有無の記録**: 正は既存の `track.loudness_normalized`（audio.normalize_loudnorm / convert_to_pcm の結果 dict から取込・後がけの両経路で更新される）。ただし tolerance によるスキップ（`loudness["normalization_skipped"]`）は `loudness_normalized=True` でも実体はフィルタなし変換なので、アーカイブ記録の `mode` は "converted" に倒す。復元時は mode="normalized" なら `tolerance=0.0` で必ず loudnorm を適用（スキップ判定に再依存しない）、"converted" なら `convert_to_pcm`。
- **再現パラメータのスナップショット**: `archived.tracks[X].params` に target_lufs / true_peak / lra / sample_rate をアーカイブ時点の settings から記録し、復元はこれだけを読む（settings は後から変更され得るため）。既知の限界: 最後の正規化実行**後**に設定パネルでラウドネス値だけ変更して再正規化せずにアーカイブした場合、スナップショットが「WAVを作った条件」とずれ得る。この乖離はサンプル数照合では捕まらない（loudnorm linear は尺を変えない）が、通常フロー（設定変更 → 後がけ正規化 → settings 更新）では一致する。
- **サンプル数照合**: アーカイブ時に wave の data チャンクのフレーム数を記録し、復元後に照合。不一致（ffmpeg のバージョン差等）は normalized_wav を削除してジョブ失敗（明示的な日本語エラー）。ブロック座標はサンプル位置に依存するため、黙って別の音声で開かせない。
- **記録 → 保存 → 削除の順序**: `archived` 記録と normalized_wav 参照のクリアを先に永続化してから os.remove。途中クラッシュで「記録あり + 実体あり」になっても、復元ジョブの上書き再生成で自己修復する。
- **整合**: 幽霊プロジェクト判定は original_file が残るため素通り。エクスポートは normalized_wav 欠損時に `project.archived` を見て「アーカイブ済み。開いて復元」の誘導メッセージに切り替える（exporter.py）。

## 検証

CI（`.github/workflows/ci.yml`）と同じ手順をローカルで実行できる:

```bash
uv run pytest -q
uv run python -m compileall -q src tests scripts tools
for f in src/podcast_prep/static/js/*.js; do node --check "$f"; done
node --test tests/js/*.test.mjs
```

- JS テストの実行は Node.js 22.7 以降（`.js` の ES modules 構文検出に必要）。`node --test tests/js/`（ディレクトリ引数）は新しめの Node で失敗するため、グロブでファイルを明示する。
- 実機の受け入れ確認（55分素材での取込→編集→自動調整→エクスポート通し、Premiere 読み込み）は自動テストの対象外で、手動で行う。

## コード内の「契約 §X」表記について

`src/podcast_prep/static/js/` などのコメントに出てくる `契約 §A` 等の節番号は、
開発時に使っていたフロント/バックエンド間の API 取り決めメモを指す（配布物には含めていない）。
各コメントは節番号を引かなくても内容が読めるように書いてあるので、番号自体は無視してよい。

