// transcribeSettings.js の純関数テスト（Issue #12 / 契約 §K）。
// モジュールトップで DOM に触らない契約 — node で import できること自体も回帰検知になる。
// DOM 結線（select 描画・ダウンロードジョブ）は実機E2Eで確認する。

import test from "node:test";
import assert from "node:assert/strict";

import {
  CUSTOM_MODEL_VALUE,
  FALLBACK_MODELS,
  FALLBACK_COMPUTE_TYPES,
  formatBytes,
  isCustomModelRef,
  modelOptionLabel,
  computeOptionLabel,
  deviceOptions,
  selectionForModelRef,
} from "../../src/podcast_prep/static/js/transcribeSettings.js";

test("formatBytes: MB/GB 表示・不正入力は空", () => {
  assert.equal(formatBytes(484 * 1024 ** 2), "484 MB");
  assert.equal(formatBytes(1.5 * 1024 ** 3), "1.5 GB");
  assert.equal(formatBytes(0), "");
  assert.equal(formatBytes(null), "");
  assert.equal(formatBytes("abc"), "");
});

test("isCustomModelRef: パス様の参照だけ true", () => {
  assert.equal(isCustomModelRef("/models/faster-whisper-medium"), true);
  assert.equal(isCustomModelRef("~/models/x"), true);
  assert.equal(isCustomModelRef("./local"), true);
  assert.equal(isCustomModelRef("C:\\models\\x"), true);
  assert.equal(isCustomModelRef("medium"), false);
  assert.equal(isCustomModelRef("large-v3"), false);
  assert.equal(isCustomModelRef(""), false);
});

test("modelOptionLabel: speed_hint 併記 + 未取得だけ「（未取得）」", () => {
  assert.equal(
    modelOptionLabel({ name: "small", downloaded: false, speed_hint: "mediumの2〜3倍速・日本語会話で実用的" }),
    "small — mediumの2〜3倍速・日本語会話で実用的（未取得）",
  );
  assert.equal(
    modelOptionLabel({ name: "medium", downloaded: true, speed_hint: "既定・バランス型" }),
    "medium — 既定・バランス型",
  );
  // downloaded: null（フォールバック時 = 取得状況不明）は未取得表示を出さない
  assert.equal(modelOptionLabel({ name: "tiny", downloaded: null, speed_hint: null }), "tiny");
});

test("computeOptionLabel: 選べない選択肢は注記を文言に埋め込む", () => {
  assert.equal(
    computeOptionLabel({ value: "float16", label: "float16", available: false, note: "CUDA環境のみ選択可能" }),
    "float16 — ※CUDA環境のみ選択可能",
  );
  // 選べる選択肢は label のみ（note は選択時に #whisperComputeNote で表示）
  assert.equal(
    computeOptionLabel({ value: "int8", label: "int8（高速）", available: true, note: "macOSで推奨" }),
    "int8（高速）",
  );
});

test("FALLBACK_COMPUTE_TYPES: int8 の macOS 推奨注記を含む（Issue #12 受け入れ条件）", () => {
  const int8 = FALLBACK_COMPUTE_TYPES.find((ct) => ct.value === "int8");
  assert.ok(int8.available);
  assert.match(int8.note, /macOSで推奨/);
  const f16 = FALLBACK_COMPUTE_TYPES.find((ct) => ct.value === "float16");
  assert.equal(f16.available, false);
  assert.match(f16.note, /CUDA/);
});

test("deviceOptions: cuda は環境が無ければ disabled + 注記", () => {
  const noCuda = deviceOptions(false);
  assert.equal(noCuda.find((d) => d.value === "cuda").available, false);
  assert.match(noCuda.find((d) => d.value === "cuda").note, /CUDA/);
  assert.ok(noCuda.find((d) => d.value === "auto").available);
  assert.ok(noCuda.find((d) => d.value === "cpu").available);
  const withCuda = deviceOptions(true);
  assert.equal(withCuda.find((d) => d.value === "cuda").available, true);
});

test("selectionForModelRef: 一覧の名前はそのまま・未知値はカスタム扱いで値を保持", () => {
  assert.deepEqual(selectionForModelRef(FALLBACK_MODELS, "small"), {
    value: "small",
    customPath: "",
  });
  assert.deepEqual(selectionForModelRef(FALLBACK_MODELS, "/opt/models/fw-medium"), {
    value: CUSTOM_MODEL_VALUE,
    customPath: "/opt/models/fw-medium",
  });
  // 未設定は medium 既定
  assert.deepEqual(selectionForModelRef(FALLBACK_MODELS, null), {
    value: "medium",
    customPath: "",
  });
  // 旧設定の未知モデル名（例: large-v2）も握り潰さずカスタムへ
  assert.deepEqual(selectionForModelRef(FALLBACK_MODELS, "large-v2"), {
    value: CUSTOM_MODEL_VALUE,
    customPath: "large-v2",
  });
});

test("プロジェクト未読込でも既定は medium（先頭の tiny に落ちない）", () => {
  // 実機フィードバック: 取得済みの medium/small があるのに「未取得です」と
  // 表示された。原因は select が一覧描画直後に先頭(tiny)を自動選択しており、
  // `!els.model.value` のガードでは既定への差し替えが走らなかったこと。
  // 未読込時の解決先が medium であることを純関数の側で固定する。
  assert.equal(selectionForModelRef(FALLBACK_MODELS, undefined).value, "medium");
  assert.equal(selectionForModelRef(FALLBACK_MODELS, "").value, "medium");
  assert.equal(selectionForModelRef(FALLBACK_MODELS, null).value, "medium");
  // 一覧の先頭が tiny であること（この前提が崩れたら回帰の意味が変わる）
  assert.equal(FALLBACK_MODELS[0].name, "tiny");
});
