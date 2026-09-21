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

## 被り一覧の「touched」分離と分類スナップショット（Issue #36）

被り一覧（`static/js/panels.js`）は永続化しないフロントの一時状態を持つ。実機フィードバックで
「閾値を変えると分類は変わるのにチェックが残る」「秒数を打った瞬間に結果が出てプレビューの
意味がない」の2点が出たため、状態の持ち方を次のように設計し直した。

- **`touchedPairs`（意思と既定の分離）**: 旧実装は `seenPairs`（= 一度でも描画して既定チェックの
  判断を確定したペア）を持ち、「既知なら選択集合を尊重」していた。これは**ユーザーが手で操作した**
  ことと**既定チェックを注入した**ことを同一視しており、分類が「解消可 → 長尺」に変わっても
  既定で入れた ON が意思として残り続けた（保護対象が自動編集の対象に混ざる）。
  新実装は `touchedPairs`（`setRowChecked` / `setAllChecked` / キーボードの toggle が刻む）だけを
  意思として扱い、**touched でない行は描画のたびに `defaultChecked(overlap)` で再評価する**。
  `seenPairs` と `selectionSeeded` は廃止した — 「判断が確定済みか」という概念は
  「ユーザーが触ったか」に吸収され、Issue #45 が守っていた性質（一時消滅ペアの記録保持 /
  分類未導出の行をユーザーが触ったときの意思保護）はすべて `touchedPairs` 側で成立する。
  `carryOverlapSelection`（分割等で block_id が変わったペアへの引き継ぎ）も **touched な旧ペア
  からだけ**引き継ぐ。既定チェックは意思ではないので、新ペアの分類から導出し直すのが正しい。
- **`categorySnapshot`（プレビュー起点の確定）**: 閾値入力 → `saveSoon()` の 350ms デバウンス PUT →
  サーバが新閾値で `classify_overlaps` → echo で `state.project.overlaps` 総入れ替え、という経路が
  あるため、キーストロークのたびに分類チップが書き換わっていた。**分類ラベル（`category`）だけ**を
  `pairKey → category` の Map で確定値として保持し、描画時に `applyCategorySnapshot` でかぶせる。
  - 固定するのは分類だけ。**被り区間そのもの（start/end/block_ids による行の増減）は即時反映**する
    （区間は編集の結果であって閾値の関数ではないため、止めると一覧が実データと乖離する）。
  - スナップショットに無いペア（編集で新しく現れた被り）はサーバの分類をそのまま採用する。
  - 確定のトリガはプレビュー成功・適用成功（`autoEdit` が `confirmOverlapCategories()` を呼ぶ）。
  - **`project-set` 時点の分類でシードする**（`freshOverlapState(state.project?.overlaps)`）。
    空 Map で始めると、プロジェクトを開いて一度もプレビューせずに閾値を触った場合に限り
    echo の新分類が素通りし、「プレビューを押すまで分類は動かない」が**初回だけ成立しない**。
    開いた時点の分類はサーバが確定させた正当な値なので、これを最初の確定値として扱う。
    分類未導出（「不明」）の行は `buildCategorySnapshot` が確定しないため、echo で分類が届く
    余地は従来どおり残る。
  - `state.project.overlaps` は**書き換えない**。かぶせるのは描画側だけで、生データは次の確定で
    本物の分類へ戻れる状態に保つ（`timelineModel.recomputeOverlapsSweep` のローカル分類引き継ぎも
    生データを読むので、スナップショットと干渉しない）。
  - `confirmOverlapCategories()` が元にするのは表示中の行ではなく `state.project.overlaps`。
    `runAutoEdit` は冒頭で `flushSave()` するため、応答が返る頃には新閾値の echo が state に届いて
    いる。ここで表示中の行を読むと古いスナップショットを確定し直すだけになる。
- **リセット**: 上記2つと選択集合・カーソルは `freshOverlapState(openingOverlaps)` に一点集約し、
  `project-set` が丸ごと入れ替える（状態を増やすたびに購読側へ手で足すと、前プロジェクトの記録が
  漏れる）。スナップショットのシードもこの関数の中で行うので、リセット契約は1箇所のまま。
- **確認ダイアログの配置**: `#overlapResetDialog` の DOM は `autoEdit.js` が直接引く。`main.js` は
  `autoEdit` を import しているため `autoEdit → main` は循環する。既存の「`at*` 群は autoEdit が
  所有する」DOM 所有ルールをそのまま延長した形。判定（`shouldConfirmOverlapReset` /
  `overlapResetChoice`）と Promise ラッパ（`awaitOverlapResetChoice`）は引数で DOM を受ける純関数・
  準純関数として切り出してあり、`importFlow.js` / `overlayGate.js` と同じ「規則は純関数・DOM は端で」
  の流儀に揃えている。多重起動は `preview()` の `busy` フラグが `showModal` の前に立つ。
  DOM 欠損（HTML / ID の退行）は **fail-closed**（確認を出せないなら実行しない）。fail-open だと
  ダイアログが出ないままユーザーのチェックを無確認で破棄する方向に倒れる。他のダイアログ helper
  は DOM 欠損ガードを持たず throw して止まるので、破壊的操作へ倒れない点で流儀が揃う。
- **閾値の永続化ゲート（補足バグ。同時修正）**: 閾値入力欄を空にすると `Number("") === 0` が
  `Number.isFinite` を通過し、settings に 0 が保存されてサーバへ飛んでいた。サーバ側で
  `max_ov < min_ov` となり `classify_overlaps` が ValueError → 分類を放棄して一覧が**全行「不明」**に
  化ける。ユーザーが明示的に `0` と打った場合も同一症状・同一経路なので、両方まとめて塞ぐ。
  責務を3層に分け、**妥当性ルールの定義箇所を増やさない**のが設計の要点:
  - `parseThresholdInput` … 「空」と「0」を取り違えないこと（表記レベル）だけを担う。
  - `validateAutoEditThresholds` … 値が妥当か（意味レベル）。サーバ `auto_edit_project` の検証式
    `keep_gap < 0 or max_gap < keep_gap or max_ov < min_ov` のミラー。赤字表示と共用。
  - `thresholdValueToPersist` … 上2つを合成して「settings へ書いてよいか」だけを決める。
    新しいルールは書かず、検証結果に**自分の欄の `field` が含まれるか**だけを見る。これにより
    「サーバが 400 で撥ねる値は settings にも書かない」が自動的に揃う。
  検証は3欄まとめて行い、自分の欄に紐づくエラーだけを見る（`max_gap < keep_gap` のような
  組み合わせエラーは単独の欄では判定できず、サーバも3値をまとめて見て 400 を返すため）。
  インライン赤字は入力欄の生値を見て従来どおり出るので、「保存されないが理由は画面で分かる」。

### Issue #37: 空のギャップ欄が検証を素通りし、無音が全削除される

#36 で塞いだのは**永続化ゲート**（settings への保存）だけで、**送信ゲート**には同じ穴が残っていた。
`validateAutoEditThresholds` 自身が各欄を `Number(opts?.max_gap_s)` で読んでいたため、
`Number("") === 0` が `Number.isFinite` を通過し、**空欄が「0 という妥当な入力」として素通り**する。
実測で `keep_gap_s=''` も `max_gap_s='' + keep_gap_s=''` も `errors: []` を返していた。

サーバの検証式 `keep_gap < 0 or max_gap < keep_gap or max_ov < min_ov` は **0/0 を合法として通す**ため、
`detect_silence_gaps(min_gap_s=0)` が**すべての無音ギャップ**を検出して詰める。つまり
**警告なしに最も破壊的な編集が走る**（⌘Z 1段で戻せるが体験として重い）。#36 の `max_ov` 経路が
「一覧が全行“不明”に化ける」表示の壊れ方だったのに対し、こちらは**音声そのものが壊れる**。

修正は読み取り規則の統一の一点だけ:

- `validateAutoEditThresholds` の3欄を `Number(...)` → **`parseThresholdInput(...)`** に置き換え、
  判定を `!Number.isFinite(x)` → `x === null` に変える。新しいパース規則は追加しない
  （#36 で入れた純関数をそのまま再利用する）。エラー文言も既存のものが過不足なく当てはまる。
- 組み合わせ判定 `max_gap < keep_gap` は**両方が数値のときだけ**行う。空欄を 0 とみなして
  「0 < 0.5 → 判定超過」という**誤った理由**の赤字を出すと、空欄が原因だと気づけない。
- `currentOpts()` の送信値も `parseThresholdInput` に揃える。ゲートを通った後にしか呼ばれないが、
  `Number("")` を残すと「空欄が 0 に化ける」罠を送信経路に温存することになる。万一 `null` が
  送られてもサーバ `_opt` の `float(None)` が 400 になる = fail-closed で、0 を送るより安全。

**1箇所の修正で赤字と送信ゲートの両方が直る**理由: `renderThresholdErrors` は
`validateAutoEditThresholds` の結果を「赤字の描画」と「`return errors.length === 0`」の両方に使い、
`preview()` / `apply()` はその戻り値が false なら送信前に `return` する。赤字と送信可否は
**同じ `errors` 配列の別の読み方**であって、二重に定義されていない。

明示的に打った `0` の扱いは**変えない**。`max_gap_s=0` を合法とするサーバ検証式そのものの是非
（API 直叩きでは同じ破壊が起こせる）は別論点として Issue 側に記録した。

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

