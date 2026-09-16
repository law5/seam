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
- **再現パラメータの記録（恒久対処済み）**: 正規化・変換の実行時に、使用した実パラメータ（target_i / true_peak / lra / sample_rate）を audio.normalize_loudnorm / convert_to_pcm の結果 dict に含め、`track.loudness` として永続化する（取込 `_run_import`・後がけ `_run_normalize` の両経路とも `_prepare_track_audio` 経由で届く）。アーカイブ時の `archived.tracks[X].params` は**この実パラメータ記録を優先**し（`params_source: "loudness"`）、記録の無い既存プロジェクト（この記録の導入前に正規化されたもの）のみ settings へフォールバックして `params_source: "settings_fallback"` を記録する。これにより「正規化実行 → 設定だけ変更（再正規化せず）→ アーカイブ → 復元」でも復元は正規化実行時の値で loudnorm し、settings ドリフトで静かに音が変わる事故（loudnorm は尺不変ゆえサンプル数照合をすり抜ける）を塞いだ。フォールバック時のみ従来の限界が残る。
- **サンプル数照合**: アーカイブ時に wave の data チャンクのフレーム数を記録し、復元後に照合。不一致（ffmpeg のバージョン差等）は normalized_wav を削除してジョブ失敗（明示的な日本語エラー）。ブロック座標はサンプル位置に依存するため、黙って別の音声で開かせない。
- **記録 → 保存 → 削除の順序**: `archived` 記録と normalized_wav 参照のクリアを先に永続化してから os.remove。途中クラッシュで「記録あり + 実体あり」になっても、復元ジョブの上書き再生成で自己修復する。
- **整合**: 幽霊プロジェクト判定は original_file が残るため素通り。エクスポートは normalized_wav 欠損時に `project.archived` を見て「アーカイブ済み。開いて復元」の誘導メッセージに切り替える（exporter.py）。

## 再生ヘッドの2クロック設計（Issue #31）

- **問題**: 再生ヘッドは `posAtStart + (ctx.currentTime - ctxT0)` = 「エンジンに送った時刻」を指しており、`AudioContext.outputLatency`（Bluetooth で 150〜500ms・負荷やデバイス切替で動的に変わる）を補正していなかった。波形上のヘッドと聞こえている声がズレて見える。
- **設計**: 聴感位置（audiblePosition = エンジン位置 − outputLatency、[0, timelineEnd] クランプ）とエンジン位置（enginePosition = 従来式）の2クロックに分離。`outputLatency` は**都度読む**（キャッシュしない）。undefined/非有限/負は 0 フォールバック。`baseLatency` は含めない（出力経路の遅延の正は outputLatency）。
- **使い分け**: 公開クロック `getCurrentTime()` は聴感位置（再生ヘッド描画・時刻表示・分割 S・±5s・無音の挿入/削除の基準 — すべてユーザーの耳基準）。エンジン位置は `schedulePass` の先読み窓の起点だけが使う（聴感で取ると実効ルックアヘッドがレイテンシ分縮む）。終了判定（schedulePass / ticker）は聴感位置 — エンジン位置で止めるとレイテンシ分の末尾が尻切れになる。
- **pause / resume**: `pausedAt` は聴感位置（⏸ でヘッドが指す場所 = 聞こえていた場所）。resume はその値を `posAtStart` にして新規スケジュールするため**エンジン位置への逆変換は不要** — 送信済み・未再生だったレイテンシ分は聞こえていた位置から鳴り直される。編集中の再スケジュール（notifyBlocksChanged）も同じ判断で聴感位置起点。
- **スコープ**: 表示クロックのみ。fetch 遅延の先頭トリム（scheduleSegment の offsetS）は従来どおり正しく、エクスポート・サーバには影響しない。シーク（絶対時刻指定）にはエンジン/聴感の区別が生じない。

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

