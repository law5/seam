// persistence.js の採用ガード・保存フラッシュの回帰テスト（QA指摘対応）。
// state / api / persistence / history は実物を使い、fetch のみモックする（edits.test.mjs の流儀）。
// 対象:
//   1. startTranscribe: ジョブ中のプロジェクト切替 → 結果破棄（別プロジェクト汚染防止・id+epochガード）
//   2. importFiles: ジョブ完了時の adoptServerProject にも同ガード
//   3. openProjectFolder/importFiles: POST 前の flushSave + adoptServerProject の保留デバウンス破棄
//   4. adoptBlocksFrom: mergeServerEcho と同形の id ガード（runAutoEdit apply 飛行中切替）

import test from "node:test";
import assert from "node:assert/strict";

import {
  state, on, beginJob, endJob, isJobBusy,
} from "../../src/podcast_prep/static/js/state.js";
import * as persistence from "../../src/podcast_prep/static/js/persistence.js";
import { chooseFile, chooseFolder } from "../../src/podcast_prep/static/js/api.js";
import { makeBlock } from "./helpers.mjs";

// ── fetch モック ─────────────────────────────────────────

let routes = [];   // {match(url, options), handler(url, options) -> Promise<body> | body}
let fetchLog = []; // {url, method, body}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    async json() {
      return structuredClone(body);
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const method = options.method || "GET";
  fetchLog.push({ url, method, body: options.body });
  for (const route of routes) {
    if (route.match(url, options)) {
      return jsonResponse(await route.handler(url, options));
    }
  }
  throw new Error(`fetch mock: 未登録のリクエスト ${method} ${url}`);
};
test.after(() => {
  globalThis.fetch = realFetch;
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(cond, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timeout");
    await sleep(5);
  }
}

const puts = (id) =>
  fetchLog.filter((e) => e.method === "PUT" && e.url === `/api/projects/${id}`);

// ── フィクスチャ ─────────────────────────────────────────

function project(id, extra = {}) {
  return {
    id,
    name: `${id} name`,
    status: "ready",
    settings: { min_overlap_s: 0.3 },
    tracks: {
      A: { speaker: "A", label: "A", gain_db: 0, deesser: 0, offset_seconds: 0 },
      B: { speaker: "B", label: "B", gain_db: 0, deesser: 0, offset_seconds: 0 },
    },
    blocks: [makeBlock(`${id}-a1`, "A", 0, 2, 0)],
    transcripts: [],
    overlaps: [],
    ...extra,
  };
}

function transcript(id, text) {
  return { id, speaker: "A", source_start: 0, source_end: 1, text };
}

function setup(proj) {
  routes = [];
  fetchLog = [];
  state.project = proj;
  state.selectedBlockId = null;
  state.editVersion = 0;
  state.projectEpoch = 0;
}

function putEchoRoute(id) {
  return {
    match: (url, options) =>
      (options.method || "GET") === "PUT" && url === `/api/projects/${id}`,
    handler: (url, options) => ({ project: JSON.parse(options.body) }),
  };
}

// ── startTranscribe: id+epoch ガード ──────────────────────

test("startTranscribe: ジョブ中のプロジェクト切替で結果を破棄する（別プロジェクト汚染防止）", async () => {
  const pA = project("p-a");
  setup(pA);
  const gate = deferred();
  routes.push({
    match: (url) => url === "/api/projects/p-a/transcribe",
    handler: async () => {
      await gate.promise;
      return {
        job: {
          id: "j1",
          kind: "transcribe",
          status: "done",
          result: {
            project: project("p-a", { transcripts: [transcript("tr-a", "P-A SECRET")] }),
          },
        },
      };
    },
  });

  const flight = persistence.startTranscribe("medium");
  await until(() => fetchLog.some((e) => e.url === "/api/projects/p-a/transcribe"));

  // POST 飛行中に別プロジェクトを開く（openProjectFolder の採用経路と同じ adoptServerProject）
  const pB = project("p-b", { transcripts: [transcript("tr-b", "p-b own transcript")] });
  persistence.adoptServerProject(pB);

  gate.resolve();
  const job = await flight;
  assert.equal(job.status, "done");

  // p-b は無傷: transcripts が p-a の結果で置換されていない
  assert.equal(state.project.id, "p-b");
  assert.deepEqual(state.project.transcripts, [transcript("tr-b", "p-b own transcript")]);

  // saveSoon も予約されない: デバウンス窓を跨いでも p-b への汚染 PUT ゼロ
  await sleep(450);
  assert.equal(puts("p-b").length, 0);
  assert.equal(puts("p-a").length, 0);
});

test("startTranscribe: 同一プロジェクトで編集が進んだら transcripts のみ部分採用し blocks はローカル維持（§9-6 回帰）", async () => {
  const pA = project("p-a");
  setup(pA);
  const gate = deferred();
  routes.push(putEchoRoute("p-a"));
  routes.push({
    match: (url) => url === "/api/projects/p-a/transcribe",
    handler: async () => {
      await gate.promise;
      return {
        job: {
          id: "j1",
          kind: "transcribe",
          status: "done",
          result: {
            project: project("p-a", { transcripts: [transcript("tr-a", "hello")] }),
          },
        },
      };
    },
  });

  const flight = persistence.startTranscribe("medium");
  await until(() => fetchLog.some((e) => e.url === "/api/projects/p-a/transcribe"));

  // ジョブ中のローカル編集（commitEdit 相当）
  state.project.blocks[0].start = 5;
  state.editVersion += 1;

  let blocksChanged = 0;
  const off = on("blocks-changed", () => blocksChanged++);
  gate.resolve();
  await flight;
  off();

  assert.equal(state.project.id, "p-a");
  assert.deepEqual(state.project.transcripts, [transcript("tr-a", "hello")]); // 部分採用
  assert.equal(state.project.blocks[0].start, 5); // ローカル編集は維持（全置換しない）
  assert.equal(blocksChanged, 1);

  // saveSoon → PUT で再収束
  await until(() => puts("p-a").length >= 1);
  assert.equal(JSON.parse(puts("p-a")[0].body).blocks[0].start, 5);
});

test("startTranscribe: 編集も切替も無ければ全置換採用（既存挙動の回帰）", async () => {
  const pA = project("p-a");
  setup(pA);
  routes.push({
    match: (url) => url === "/api/projects/p-a/transcribe",
    handler: () => ({
      job: {
        id: "j1",
        kind: "transcribe",
        status: "done",
        result: {
          project: project("p-a", { transcripts: [transcript("tr-a", "hello")] }),
        },
      },
    }),
  });
  const epochBefore = state.projectEpoch;
  await persistence.startTranscribe("medium");
  assert.deepEqual(state.project.transcripts, [transcript("tr-a", "hello")]);
  assert.equal(state.projectEpoch, epochBefore + 1); // adoptServerProject（全置換）が走った
});

// ── importFiles: 完了時採用の id+epoch ガード ─────────────

test("importFiles: ジョブ中のプロジェクト切替で完了文書を採用しない", async () => {
  setup(null);
  routes.push({
    match: (url, options) =>
      url === "/api/projects" && (options.method || "GET") === "POST",
    handler: () => ({
      project: project("p-imp", { status: "importing" }),
      job: { id: "j2", kind: "import", status: "running" },
    }),
  });
  routes.push({
    match: (url) => url === "/api/jobs/j2",
    handler: () => ({
      id: "j2",
      kind: "import",
      status: "done",
      result: { project: project("p-imp", { status: "ready" }) },
    }),
  });

  const flight = persistence.importFiles(new Blob(["a"]), new Blob(["b"]), "t", -16);
  await until(() => state.project?.id === "p-imp"); // 初回採用（importing）完了を待つ

  // ポーリング待機中（1.4s）に別プロジェクトを開く
  persistence.adoptServerProject(project("p-other"));

  const job = await flight;
  assert.equal(job.status, "done");
  assert.equal(state.project.id, "p-other"); // 完了文書（p-imp ready）に差し替わらない
});

test("importFiles: 切替が無ければ完了文書を全置換採用（既存挙動の回帰）", async () => {
  setup(null);
  routes.push({
    match: (url, options) =>
      url === "/api/projects" && (options.method || "GET") === "POST",
    handler: () => ({
      project: project("p-imp", { status: "importing" }),
      job: {
        id: "j2",
        kind: "import",
        status: "done",
        result: { project: project("p-imp", { status: "ready" }) },
      },
    }),
  });
  await persistence.importFiles(new Blob(["a"]), new Blob(["b"]), "t", -16);
  assert.equal(state.project.id, "p-imp");
  assert.equal(state.project.status, "ready");
});

// ── importFiles: 作業フォルダ（フェーズ3） ─────────────────

function importDoneRoute() {
  return {
    match: (url, options) =>
      url === "/api/projects" && (options.method || "GET") === "POST",
    handler: () => ({
      project: project("p-wd", { status: "importing" }),
      job: {
        id: "j-wd",
        kind: "import",
        status: "done",
        result: { project: project("p-wd", { status: "ready" }) },
      },
    }),
  };
}

test("importFiles: workdir 指定時は FormData に載る", async () => {
  setup(null);
  routes.push(importDoneRoute());
  await persistence.importFiles(
    new Blob(["a"]), new Blob(["b"]), "t", -16, true, "/Users/example/Podcast/EP01",
  );
  const post = fetchLog.find((e) => e.url === "/api/projects");
  assert.equal(post.body.get("workdir"), "/Users/example/Podcast/EP01");
});

test("importFiles: workdir 未指定はフィールド自体を送らない（空文字は 400 になるサーバ契約）", async () => {
  setup(null);
  routes.push(importDoneRoute());
  await persistence.importFiles(new Blob(["a"]), new Blob(["b"]), "t", -16);
  const post = fetchLog.find((e) => e.url === "/api/projects");
  assert.equal(post.body.has("workdir"), false);
});

// ── importFiles: ラウドネス詳細（Issue #37） ──────────────

test("importFiles: true_peak / tolerance が FormData に載る", async () => {
  setup(null);
  routes.push(importDoneRoute());
  await persistence.importFiles(
    new Blob(["a"]), new Blob(["b"]), "t", -16, true, null,
    { truePeak: -2, tolerance: 1 },
  );
  const post = fetchLog.find((e) => e.url === "/api/projects");
  assert.equal(post.body.get("true_peak"), "-2");
  assert.equal(post.body.get("tolerance"), "1");
});

test("importFiles: ラウドネス詳細の未指定はサーバ既定と同値（-1.5 / 0.5）を送る = 挙動不変", async () => {
  setup(null);
  routes.push(importDoneRoute());
  await persistence.importFiles(new Blob(["a"]), new Blob(["b"]), "t", -16);
  const post = fetchLog.find((e) => e.url === "/api/projects");
  assert.equal(post.body.get("true_peak"), "-1.5");
  assert.equal(post.body.get("tolerance"), "0.5");
});

test("importFiles: 許容量 0（常に正規化）が既定値 0.5 に化けない", async () => {
  setup(null);
  routes.push(importDoneRoute());
  await persistence.importFiles(
    new Blob(["a"]), new Blob(["b"]), "t", -16, true, null,
    { truePeak: -1.5, tolerance: 0 },
  );
  const post = fetchLog.find((e) => e.url === "/api/projects");
  assert.equal(post.body.get("tolerance"), "0");
});

// ── api.chooseFolder（フォルダ選択の薄いラッパ） ───────────

test("chooseFolder: purpose を POST し、キャンセル応答（200 + cancelled）をそのまま返す", async () => {
  setup(null);
  let sent = null;
  routes.push({
    match: (url, options) =>
      url === "/api/system/choose_folder" && (options.method || "GET") === "POST",
    handler: (url, options) => {
      sent = JSON.parse(options.body);
      return { path: null, cancelled: true };
    },
  });
  const res = await chooseFolder("workdir");
  assert.deepEqual(sent, { purpose: "workdir" }); // prompt 未指定ならキー自体を送らない
  assert.deepEqual(res, { path: null, cancelled: true }); // キャンセルは throw しない正常系
});

test("chooseFile: purpose を POST し、キャンセル応答（200 + cancelled）をそのまま返す", async () => {
  setup(null);
  let sent = null;
  routes.push({
    match: (url, options) =>
      url === "/api/system/choose_file" && (options.method || "GET") === "POST",
    handler: (url, options) => {
      sent = JSON.parse(options.body);
      return { path: null, cancelled: true };
    },
  });
  const res = await chooseFile("project_json");
  assert.deepEqual(sent, { purpose: "project_json" });
  assert.deepEqual(res, { path: null, cancelled: true }); // キャンセルは throw しない正常系
});

// ── precheckExport（Issue #32: 上書き事前チェックの薄いラッパ） ──

test("precheckExport: output_dir を POST し、exists/files 応答をそのまま返す", async () => {
  setup(project("p-pre"));
  let sent = null;
  routes.push({
    match: (url, options) =>
      url === "/api/projects/p-pre/export/precheck" && (options.method || "GET") === "POST",
    handler: (url, options) => {
      sent = JSON.parse(options.body);
      return { output_dir: "/abs/exports", exists: true, files: ["speakerA.wav"] };
    },
  });
  const res = await persistence.precheckExport("/abs/exports");
  assert.deepEqual(sent, { output_dir: "/abs/exports" });
  assert.equal(res.exists, true);
  assert.deepEqual(res.files, ["speakerA.wav"]);
});

test("precheckExport: 出力先未指定は null を送る（既定 = プロジェクト内 exports）", async () => {
  setup(project("p-pre2"));
  let sent = null;
  routes.push({
    match: (url) => url === "/api/projects/p-pre2/export/precheck",
    handler: (url, options) => {
      sent = JSON.parse(options.body);
      return { output_dir: "/abs/default", exists: false, files: [] };
    },
  });
  const res = await persistence.precheckExport(null);
  assert.deepEqual(sent, { output_dir: null });
  assert.equal(res.exists, false);
});

// ── 切替前 flushSave + 保留デバウンス破棄 ─────────────────

test("openProjectFolder: 保留中のデバウンス保存を切替前に flush し、切替後の迷子 PUT を出さない", async () => {
  const pA = project("p-a");
  setup(pA);
  routes.push(putEchoRoute("p-a"));
  routes.push({
    match: (url, options) =>
      url === "/api/projects/open" && (options.method || "GET") === "POST",
    handler: () => ({ project: project("p-b") }),
  });

  // 直前の編集（デバウンス保留中）
  state.project.name = "edited just before switch";
  state.editVersion += 1;
  persistence.saveSoon();

  await persistence.openProjectFolder("/Users/example/Podcast/EP01");

  // flush が open POST より先に p-a へ PUT している（silent loss 防止）
  const putIndex = fetchLog.findIndex(
    (e) => e.method === "PUT" && e.url === "/api/projects/p-a",
  );
  const openIndex = fetchLog.findIndex((e) => e.url === "/api/projects/open");
  assert.notEqual(putIndex, -1, "切替前に p-a の保留編集が PUT されること");
  assert.ok(putIndex < openIndex, "PUT(p-a) は open POST より先であること");
  assert.equal(fetchLog[openIndex].body.get("source_dir"), "/Users/example/Podcast/EP01");
  assert.equal(
    JSON.parse(fetchLog[putIndex].body).name,
    "edited just before switch",
  );
  assert.equal(state.project.id, "p-b");

  // 旧タイマーは adoptServerProject で破棄済み → p-b への無意味な PUT は出ない
  await sleep(450);
  assert.equal(puts("p-b").length, 0);
  assert.equal(puts("p-a").length, 1);
});

test("adoptServerProject: 保留デバウンスを破棄する（新プロジェクトへ旧編集のつもりの PUT を出さない）", async () => {
  const pA = project("p-a");
  setup(pA);
  routes.push(putEchoRoute("p-a"));
  routes.push(putEchoRoute("p-b"));

  state.editVersion += 1;
  persistence.saveSoon(); // 350ms 後に発火予定
  persistence.adoptServerProject(project("p-b")); // 発火前に切替

  await sleep(450);
  assert.equal(puts("p-a").length, 0);
  assert.equal(puts("p-b").length, 0); // タイマーは clear 済み
});

// ── adoptBlocksFrom: id ガード ────────────────────────────

test("adoptBlocksFrom: id 不一致の応答を破棄する（mergeServerEcho と同形ガード）", () => {
  const pB = project("p-b");
  setup(pB);
  let blocksChanged = 0;
  const off = on("blocks-changed", () => blocksChanged++);

  persistence.adoptBlocksFrom({
    id: "p-a",
    blocks: [makeBlock("p-a-a1", "A", 0, 9, 0)],
    overlaps: [{ start: 0, end: 1 }],
  });
  assert.deepEqual(state.project.blocks, [makeBlock("p-b-a1", "A", 0, 2, 0)]); // 無傷
  assert.deepEqual(state.project.overlaps, []);
  assert.equal(blocksChanged, 0);

  // id 一致なら従来どおり採用
  persistence.adoptBlocksFrom({
    id: "p-b",
    blocks: [makeBlock("p-b-a2", "A", 0, 3, 1)],
    overlaps: [],
  });
  assert.deepEqual(state.project.blocks, [makeBlock("p-b-a2", "A", 0, 3, 1)]);
  assert.equal(blocksChanged, 1);
  off();
});

test("runAutoEdit: apply 応答の飛行中切替で旧プロジェクトの blocks を差し込まない", async () => {
  const pA = project("p-a");
  setup(pA);
  const gate = deferred();
  routes.push({
    match: (url) => url === "/api/projects/p-a/auto_edit",
    handler: async () => {
      await gate.promise;
      return {
        dry_run: false,
        applied: true,
        project: project("p-a", {
          blocks: [makeBlock("p-a-a1", "A", 0, 2, 0.5)],
        }),
      };
    },
  });

  const flight = persistence.runAutoEdit({ dry_run: false });
  await until(() => fetchLog.some((e) => e.url === "/api/projects/p-a/auto_edit"));

  persistence.adoptServerProject(project("p-b")); // POST 飛行中に切替

  gate.resolve();
  const data = await flight;
  assert.equal(data.applied, true);
  assert.equal(state.project.id, "p-b");
  assert.deepEqual(state.project.blocks, [makeBlock("p-b-a1", "A", 0, 2, 0)]); // p-a の blocks が混入しない
});

// ── mergeServerEcho: overlaps 分類の反映（Issue #20 実機FB） ──
// 被り一覧の分類チップはサーバ導出の overlap.category を表示する。編集後の
// ローカルスイープは分類を持たないため、静止後の PUT echo（editVersion 一致）で
// 最新分類を採用し "overlaps-merged" で一覧の再描画を促す。不一致なら丸ごと破棄。

test("saveProject: editVersion 一致の echo は category 付き overlaps を採用し overlaps-merged を発火する", async () => {
  const pA = project("p-a", {
    overlaps: [{ start: 1, end: 2, duration: 1, block_ids: ["p-a-a1", "p-a-b1"] }],
  });
  setup(pA);
  let merged = 0;
  const off = on("overlaps-merged", () => merged++);
  routes.push({
    match: (url, options) =>
      (options.method || "GET") === "PUT" && url === "/api/projects/p-a",
    handler: (url, options) => {
      const doc = JSON.parse(options.body);
      doc.overlaps = [
        { start: 1, end: 2, duration: 1, block_ids: ["p-a-a1", "p-a-b1"], category: "resolvable" },
      ];
      return { project: doc };
    },
  });

  await persistence.saveProject();
  off();
  assert.equal(merged, 1, "echo 採用時に overlaps-merged が1回発火すること");
  assert.equal(state.project.overlaps[0].category, "resolvable");
});

test("saveProject: editVersion 不一致の echo は破棄し overlaps-merged も発火しない", async () => {
  const pA = project("p-a", {
    overlaps: [{ start: 1, end: 2, duration: 1, block_ids: ["p-a-a1", "p-a-b1"] }],
  });
  setup(pA);
  let merged = 0;
  const off = on("overlaps-merged", () => merged++);
  const gate = deferred();
  routes.push({
    match: (url, options) =>
      (options.method || "GET") === "PUT" && url === "/api/projects/p-a",
    handler: async (url, options) => {
      await gate.promise; // 応答を待たせて「送信後に編集が進む」状況を作る
      const doc = JSON.parse(options.body);
      doc.overlaps = [
        { start: 1, end: 2, duration: 1, block_ids: ["p-a-a1", "p-a-b1"], category: "resolvable" },
      ];
      return { project: doc };
    },
  });

  const flight = persistence.saveProject();
  state.editVersion += 1; // 飛行中に編集が進んだ
  gate.resolve();
  await flight;
  off();
  assert.equal(merged, 0, "不一致 echo で overlaps-merged を発火しないこと");
  assert.ok(!("category" in state.project.overlaps[0]), "不一致 echo の overlaps を採用しないこと");
});

// ── Issue #54「編集を破棄して閉じる」: スナップショット巻き戻し ──
// adoptServerProject 時点の structuredClone を保持し、discardToSnapshot が
// 保留デバウンスのキャンセル → 飛行静穏待ち → 巻き戻し PUT → echo 全置換採用を行う。

test("canDiscardToSnapshot: スナップショット存在 + id 一致のときだけ true（純関数）", () => {
  const proj = project("p-x");
  assert.equal(persistence.canDiscardToSnapshot(null, proj), false);
  assert.equal(persistence.canDiscardToSnapshot(proj, null), false);
  assert.equal(persistence.canDiscardToSnapshot(project("p-y"), proj), false);
  assert.equal(persistence.canDiscardToSnapshot(project("p-x"), proj), true);
});

test("discardToSnapshot: 保留デバウンスをキャンセルし、開いた時点の文書を書き戻す（deep clone）", async () => {
  setup(null);
  routes.push(putEchoRoute("p-d1"));
  persistence.adoptServerProject(project("p-d1"));

  // 自動保存済み相当の編集（デバウンス保留中）+ 採用済みオブジェクトの直接ミューテーション
  state.project.name = "edited after open";
  state.project.blocks[0].start = 7;
  state.editVersion += 1;
  persistence.saveSoon();

  const epochBefore = state.projectEpoch;
  await persistence.discardToSnapshot();

  // 巻き戻し PUT の本文 = 開いた時点の文書（ミューテーションが snapshot に漏れていない = deep clone）
  const all = puts("p-d1");
  assert.equal(all.length, 1, "保留デバウンスはキャンセルされ、PUT は巻き戻しの1本だけ");
  const sent = JSON.parse(all[0].body);
  assert.equal(sent.name, "p-d1 name");
  assert.equal(sent.blocks[0].start, 0);

  // echo を全置換採用（project-set 経路）: state も開いた時点へ戻る
  assert.equal(state.project.name, "p-d1 name");
  assert.equal(state.project.blocks[0].start, 0);
  assert.equal(state.projectEpoch, epochBefore + 1);

  // デバウンス窓を跨いでも追加 PUT なし（キャンセル済みの回帰確認）
  await sleep(450);
  assert.equal(puts("p-d1").length, 1);
});

test("discardToSnapshot: 飛行中 PUT（+追撃）の完了を待ってから巻き戻し PUT を送る", async () => {
  setup(null);
  const gate = deferred();
  let putCount = 0;
  routes.push({
    match: (url, options) =>
      (options.method || "GET") === "PUT" && url === "/api/projects/p-d2",
    handler: async (url, options) => {
      putCount += 1;
      if (putCount === 1) await gate.promise; // 先行便だけ待たせる
      return { project: JSON.parse(options.body) };
    },
  });
  persistence.adoptServerProject(project("p-d2"));

  state.project.name = "edit 1";
  state.editVersion += 1;
  const flight1 = persistence.saveProject(); // 先行便（ゲートで停留）
  state.project.name = "edit 2";
  state.editVersion += 1;
  const flight2 = persistence.saveProject(); // 追撃へ合流

  const discardFlight = persistence.discardToSnapshot();
  await sleep(30);
  assert.equal(puts("p-d2").length, 1, "飛行静穏まで巻き戻し PUT は出ない");

  gate.resolve();
  await flight1;
  await flight2;
  await discardFlight;

  // 順序は常に「編集PUT（先行便→追撃）→ 破棄PUT」= 破棄が追撃に上書きされない
  const bodies = puts("p-d2").map((e) => JSON.parse(e.body).name);
  assert.deepEqual(bodies, ["edit 1", "edit 2", "p-d2 name"]);
  assert.equal(state.project.name, "p-d2 name");
});

test("discardToSnapshot: PUT 失敗時は throw し編集状態を巻き戻さない（スナップショット温存 = 再試行可）", async () => {
  setup(null);
  let fail = true;
  routes.push({
    match: (url, options) =>
      (options.method || "GET") === "PUT" && url === "/api/projects/p-d3",
    handler: (url, options) => {
      if (fail) throw new Error("boom");
      return { project: JSON.parse(options.body) };
    },
  });
  persistence.adoptServerProject(project("p-d3"));
  state.project.name = "edited";
  state.editVersion += 1;
  const epochBefore = state.projectEpoch;

  await assert.rejects(() => persistence.discardToSnapshot());
  assert.equal(state.project.name, "edited", "失敗時は編集画面に留まる（state 不変）");
  assert.equal(state.projectEpoch, epochBefore, "失敗時は project-set を発火しない");

  fail = false;
  await persistence.discardToSnapshot(); // スナップショットは温存されている
  assert.equal(state.project.name, "p-d3 name");
});

test("discardToSnapshot: スナップショットが無い（adopt を経ていない）プロジェクトでは破棄できない", async () => {
  setup(project("p-never-adopted")); // state 直接セット = adoptServerProject を通っていない
  await assert.rejects(() => persistence.discardToSnapshot(), /開いた時点の状態/);
  assert.equal(puts("p-never-adopted").length, 0, "巻き戻し PUT を送らない");
  assert.equal(persistence.canDiscard(), false);
});

// ── Issue #54 QA指摘: 破棄 PUT の競合防止（discarding フラグ + 静穏待ちループ） ──
// ダイアログは submit で即閉じるため破棄 await 中もエディタ操作が可能。破棄 PUT は
// putProject 直呼びで単一飛行の外を飛ぶので、破棄中の saveSoon / saveProject を
// no-op にしないと編集 PUT が並走し、後着した編集がサーバ上の破棄を静かに上書きする。

test("discardToSnapshot: 破棄 await 中の saveSoon / saveProject は no-op（編集PUTが破棄と並走しない）", async () => {
  setup(null);
  const gate = deferred();
  routes.push({
    match: (url, options) =>
      (options.method || "GET") === "PUT" && url === "/api/projects/p-d5",
    handler: async (url, options) => {
      await gate.promise; // 破棄 PUT を停留させ「破棄 await 中」を作る
      return { project: JSON.parse(options.body) };
    },
  });
  persistence.adoptServerProject(project("p-d5"));
  state.project.name = "edited before discard";
  state.editVersion += 1;

  const discardFlight = persistence.discardToSnapshot();
  await until(() => puts("p-d5").length === 1); // 破棄 PUT が飛行中

  // ダイアログ閉鎖後のエディタ操作: 編集 → saveSoon / 保存ボタン直クリック
  state.project.name = "edited during discard";
  state.editVersion += 1;
  persistence.saveSoon();
  await persistence.saveProject(); // no-op なら即解決（新規飛行を作らない）
  assert.equal(puts("p-d5").length, 1, "破棄中の saveProject は PUT を出さない");

  gate.resolve();
  await discardFlight;
  await sleep(450); // saveSoon のデバウンス窓を跨いでも PUT が出ないこと

  const all = puts("p-d5");
  assert.equal(all.length, 1, "PUT は破棄の1本だけ（破棄中の編集PUTは発生しない）");
  assert.equal(JSON.parse(all[0].body).name, "p-d5 name");
  assert.equal(state.project.name, "p-d5 name", "echo 全置換採用で開いた時点へ戻る");
  // フラグは finally で解除済み: 破棄後の通常保存は従来どおり飛ぶ
  state.project.name = "edited after discard";
  state.editVersion += 1;
  await persistence.saveProject();
  assert.equal(puts("p-d5").length, 2);
  assert.equal(JSON.parse(puts("p-d5")[1].body).name, "edited after discard");
});

test("discardToSnapshot: 静穏待ち中の saveSoon / saveProject も PUT を生まず、破棄前に積まれた追撃 → 破棄PUT の順序が固定される", async () => {
  setup(null);
  const gate = deferred();
  let putCount = 0;
  routes.push({
    match: (url, options) =>
      (options.method || "GET") === "PUT" && url === "/api/projects/p-d6",
    handler: async (url, options) => {
      putCount += 1;
      if (putCount === 1) await gate.promise; // 先行便だけ停留（静穏待ちを作る）
      return { project: JSON.parse(options.body) };
    },
  });
  persistence.adoptServerProject(project("p-d6"));

  state.project.name = "edit 1";
  state.editVersion += 1;
  const flight1 = persistence.saveProject(); // 先行便（ゲートで停留）
  state.project.name = "edit 2";
  state.editVersion += 1;
  const flight2 = persistence.saveProject(); // 追撃へ合流

  const discardFlight = persistence.discardToSnapshot(); // 静穏待ちへ入る

  // 静穏待ち中のエディタ操作: 新規予約・新規飛行を発生させない
  await sleep(30);
  persistence.saveSoon();
  await persistence.saveProject();
  assert.equal(puts("p-d6").length, 1, "静穏待ち中は先行便の1本のみ");

  gate.resolve();
  await flight1;
  await flight2;
  await discardFlight;
  await sleep(450); // デバウンス窓を跨いでも迷子 PUT なし

  // 破棄前に積まれた飛行・追撃は飲み干され、順序は常に「編集PUT（先行便→追撃）→ 破棄PUT」
  const bodies = puts("p-d6").map((e) => JSON.parse(e.body).name);
  assert.deepEqual(bodies, ["edit 1", "edit 2", "p-d6 name"]);
  assert.equal(state.project.name, "p-d6 name");
});

// ── Issue #57 QA指摘: 破棄 → ジョブ方向のガード（job-busy 排他への参加） ──
// ジョブ → 破棄は塞がれている（破棄ボタンの disabled + onCloseProjectSubmit の二重ガード）が、
// 逆方向は素通りだった: 破棄ダイアログは submit で即閉じ、巻き戻し PUT は非同期で飛び続けるため、
// その窓で transcribe / export / normalize を起票できる。discarding フラグは saveSoon /
// saveProject を no-op にするだけで beginJob 経路には効かない。破棄自体を beginJob()/endJob()
// で包み、既存の busy ガード（isJobBusy）で他ジョブの起票を塞ぐ。

test("discardToSnapshot: 破棄の実行中は isJobBusy が真（transcribe/export/normalize の起票が既存 busy ガードで塞がる）", async () => {
  setup(null);
  const gate = deferred();
  routes.push({
    match: (url, options) =>
      (options.method || "GET") === "PUT" && url === "/api/projects/p-d7",
    handler: async (url, options) => {
      await gate.promise; // 巻き戻し PUT を停留させ「破棄 await 中」を作る
      return { project: JSON.parse(options.body) };
    },
  });
  persistence.adoptServerProject(project("p-d7"));
  state.project.name = "edited before discard";
  state.editVersion += 1;

  assert.equal(isJobBusy(), false, "破棄前は busy でない");
  const busyEvents = [];
  const off = on("job-busy", (detail) => busyEvents.push(detail.busy));

  const discardFlight = persistence.discardToSnapshot();
  await until(() => puts("p-d7").length === 1); // 巻き戻し PUT が飛行中
  assert.equal(isJobBusy(), true, "破棄中は busy = 他ジョブの起票が塞がれる");
  assert.deepEqual(busyEvents, [true], "UI 追随用に job-busy を立てる");

  gate.resolve();
  await discardFlight;

  assert.equal(isJobBusy(), false, "破棄完了で busy 解除");
  assert.equal(state.jobsInFlight, 0, "カウンタをリークしない");
  assert.deepEqual(busyEvents, [true, false]);
  off();
});

test("discardToSnapshot: 静穏待ち中（巻き戻し PUT 前）から既に busy（起票窓を残さない）", async () => {
  setup(null);
  const gate = deferred();
  let putCount = 0;
  routes.push({
    match: (url, options) =>
      (options.method || "GET") === "PUT" && url === "/api/projects/p-d8",
    handler: async (url, options) => {
      putCount += 1;
      if (putCount === 1) await gate.promise; // 先行便だけ停留（静穏待ちを作る）
      return { project: JSON.parse(options.body) };
    },
  });
  persistence.adoptServerProject(project("p-d8"));
  state.project.name = "edit 1";
  state.editVersion += 1;
  const flight1 = persistence.saveProject(); // 先行便（ゲートで停留）

  const discardFlight = persistence.discardToSnapshot(); // 静穏待ちへ入る
  await sleep(30);
  assert.equal(puts("p-d8").length, 1, "巻き戻し PUT はまだ出ていない（静穏待ち中）");
  assert.equal(isJobBusy(), true, "静穏待ちの時点で既に busy");

  gate.resolve();
  await flight1;
  await discardFlight;
  assert.equal(isJobBusy(), false);
  assert.equal(state.jobsInFlight, 0);
});

test("discardToSnapshot: 失敗（PUT throw / スナップショット無し）でも busy を解除する（カウンタリーク防止）", async () => {
  setup(null);
  routes.push({
    match: (url, options) =>
      (options.method || "GET") === "PUT" && url === "/api/projects/p-d9",
    handler: () => {
      throw new Error("boom");
    },
  });
  persistence.adoptServerProject(project("p-d9"));
  state.project.name = "edited";
  state.editVersion += 1;

  await assert.rejects(() => persistence.discardToSnapshot());
  assert.equal(isJobBusy(), false, "PUT 失敗でも busy 解除（編集画面に留まって再試行できる）");
  assert.equal(state.jobsInFlight, 0);

  // 前提エラー（スナップショット無し）で早期 throw する経路も busy を残さない
  setup(project("p-never-adopted-2"));
  await assert.rejects(() => persistence.discardToSnapshot(), /開いた時点の状態/);
  assert.equal(isJobBusy(), false);
  assert.equal(state.jobsInFlight, 0);
});

test("discardToSnapshot: 破棄完了後は通常のジョブを起票できる（busy が張り付かない）", async () => {
  setup(null);
  routes.push(putEchoRoute("p-d10"));
  routes.push({
    match: (url) => url === "/api/projects/p-d10/transcribe",
    handler: () => ({ job: { id: "j-d10", status: "succeeded", result: {} } }),
  });
  persistence.adoptServerProject(project("p-d10"));
  state.project.name = "edited";
  state.editVersion += 1;

  await persistence.discardToSnapshot();
  assert.equal(isJobBusy(), false, "破棄後は busy でない = transcribe/export/normalize が起票できる");

  // 破棄が endJob を余分に呼んでいないこと（他ジョブの busy を取り落とさない）
  beginJob();
  assert.equal(isJobBusy(), true);
  endJob();
  assert.equal(isJobBusy(), false);
});

// ── Issue #54 QA指摘: transcribe 部分採用時のスナップショット追随 ──
// 編集併走時の transcribe 完了は transcripts のみ部分採用で adoptServerProject を
// 通らない。スナップショットを追随させないと、その後の破棄が採用済み whisper 結果を
// 恒久削除する（transcripts は project.json のみ保管・サイドカーなし）。

test("startTranscribe: 部分採用後の破棄でも採用済み transcripts がスナップショット PUT に含まれる（whisper 結果は破棄対象外）", async () => {
  setup(null);
  const gate = deferred();
  routes.push(putEchoRoute("p-t1"));
  routes.push({
    match: (url) => url === "/api/projects/p-t1/transcribe",
    handler: async () => {
      await gate.promise;
      return {
        job: {
          id: "j1",
          kind: "transcribe",
          status: "done",
          result: {
            project: project("p-t1", { transcripts: [transcript("tr-1", "whisper result")] }),
          },
        },
      };
    },
  });
  persistence.adoptServerProject(project("p-t1")); // 開いた時点のベースライン

  const flight = persistence.startTranscribe("medium");
  await until(() => fetchLog.some((e) => e.url === "/api/projects/p-t1/transcribe"));

  // ジョブ中のローカル編集 → 完了時は transcripts のみ部分採用の経路へ
  state.project.blocks[0].start = 5;
  state.editVersion += 1;
  gate.resolve();
  await flight;
  await until(() => puts("p-t1").length >= 1); // 部分採用後の saveSoon → 再収束 PUT

  await persistence.discardToSnapshot();

  // 巻き戻し PUT の本文: 手編集は開いた時点へ戻るが transcripts は採用済みのまま
  const discardPut = puts("p-t1").at(-1);
  const sent = JSON.parse(discardPut.body);
  assert.deepEqual(sent.transcripts, [transcript("tr-1", "whisper result")]);
  assert.equal(sent.blocks[0].start, 0, "手編集は破棄される");
  assert.deepEqual(
    state.project.transcripts,
    [transcript("tr-1", "whisper result")],
    "破棄後の state にも whisper 結果が残る",
  );
});

test("adoptServerProject: 再採用でスナップショットが更新される（transcribe 全置換の結果は破棄対象外）", async () => {
  setup(null);
  routes.push(putEchoRoute("p-d4"));
  persistence.adoptServerProject(project("p-d4")); // 取込直後のベースライン
  // transcribe 全置換（編集なしで完了 → adoptServerProject 経路）相当
  persistence.adoptServerProject(
    project("p-d4", { transcripts: [transcript("tr-1", "whisper result")] }),
  );
  // その後の手編集（自動保存保留中）
  state.project.blocks[0].start = 7;
  state.editVersion += 1;
  persistence.saveSoon();

  await persistence.discardToSnapshot();
  assert.deepEqual(
    state.project.transcripts,
    [transcript("tr-1", "whisper result")],
    "文字起こし結果は最新スナップショットに含まれ破棄されない",
  );
  assert.equal(state.project.blocks[0].start, 0, "手編集は破棄される");
  assert.equal(puts("p-d4").length, 1);
});

// ── Issue #57 QA(Medium): 閉じている間の採用は #54 の破棄ベースラインを前進させない ──
// 「はい」で閉じる経路は採用しないので閉じた時点のベースラインは開いた時点 S+E のまま
// 正しいが、**閉じている間に裏のジョブ（正規化 / 文字起こし全置換）が完了して
// adoptServerProject が走ると openSnapshot が前進**し、後の「編集を破棄して閉じる」が
// 開いた時点の編集 E を巻き戻さなくなる（#54 の契約違反）。
// 閉じ状態の正は DOM（panels.projectViewClosed）なので persistence へは注入で渡す。

// 各テストで自前に閉じ状態を切り替えるプローブ。test.after で必ず既定へ戻す
// （未登録 = 常に false = 従来挙動。他テストへ漏らさない）。
let viewClosed = false;
persistence.setViewClosedProbe(() => viewClosed);
test.after(() => {
  viewClosed = false;
  persistence.setViewClosedProbe(null);
});

test("閉じている間のジョブ完了採用では破棄ベースラインが前進しない（開いた時点へ戻る）", async () => {
  setup(null);
  viewClosed = false;
  routes.push(putEchoRoute("p-m1"));
  persistence.adoptServerProject(project("p-m1")); // 開いた時点 = ベースライン S

  // 開いている間の手編集 E（自動保存でディスクには載っている想定）
  state.project.blocks[0].start = 7;
  state.project.name = "edited before close";
  state.editVersion += 1;

  // 「はい」で閉じる（保存のみ。採用は通らない）→ ビューは閉じた
  viewClosed = true;

  // 閉じている間に正規化が完了 → adoptServerProject（E を含むサーバ正本 + 成果物）
  persistence.adoptServerProject(
    project("p-m1", {
      name: "edited before close",
      blocks: [makeBlock("p-m1-a1", "A", 0, 2, 7)],
      tracks: {
        A: { speaker: "A", label: "A", gain_db: 0, deesser: 0, offset_seconds: 0, loudness_normalized: true },
        B: { speaker: "B", label: "B", gain_db: 0, deesser: 0, offset_seconds: 0 },
      },
    }),
  );

  // ユーザーが開き直して「編集を破棄して閉じる」→ 開いた時点 S に戻るべき
  viewClosed = false;
  await persistence.discardToSnapshot();
  const sent = JSON.parse(puts("p-m1").at(-1).body);
  assert.equal(sent.blocks[0].start, 0, "閉じている間の採用でベースラインが前進していないこと");
  assert.equal(sent.name, "p-m1 name");
  assert.equal(state.project.blocks[0].start, 0);
});

test("開いた状態の採用は従来どおりベースラインを前進させる（#54 の既存契約）", async () => {
  setup(null);
  viewClosed = false;
  routes.push(putEchoRoute("p-m2"));
  persistence.adoptServerProject(project("p-m2"));
  // 開いたまま待った正規化完了（リフレッシュ経路）は「サーバ正本と完全同期した瞬間」
  persistence.adoptServerProject(project("p-m2", { name: "normalized" }));
  state.project.blocks[0].start = 9; // その後の手編集だけが破棄対象
  state.editVersion += 1;

  await persistence.discardToSnapshot();
  assert.equal(state.project.name, "normalized", "開いた状態の採用は新ベースラインになる");
  assert.equal(state.project.blocks[0].start, 0);
});

test("setOpenSnapshot: ユーザーが明示的に開いた直後はベースラインを作り直す（復元・再開・取込）", async () => {
  setup(null);
  routes.push(putEchoRoute("p-m3"));
  // 復元は「閉じた」オーバーレイ表示中に走るため採用ではベースラインが作られない
  viewClosed = true;
  persistence.adoptServerProject(project("p-m3"));
  assert.equal(persistence.canDiscard(), false, "採用だけではベースライン未確立");

  // overlayGate が畳んだ直後に呼ぶ（= 「今この瞬間から編集を始める」）
  persistence.setOpenSnapshot();
  viewClosed = false;
  assert.equal(persistence.canDiscard(), true);

  state.project.blocks[0].start = 5;
  state.editVersion += 1;
  await persistence.discardToSnapshot();
  assert.equal(state.project.blocks[0].start, 0, "開いた時点へ戻る");
});

test("閉じている間の transcribe 部分採用はスナップショットの transcripts だけ追随する（#54 との整合）", async () => {
  // 全置換と違い blocks / tracks を触らないため「開いた時点の編集 E」を巻き戻す能力は
  // 失われない。逆に据え置くと開き直して破棄したとき whisper 結果が恒久削除される。
  setup(null);
  viewClosed = false;
  routes.push(putEchoRoute("p-m4"));
  routes.push({
    match: (url, options) =>
      (options.method || "GET") === "POST" && url === "/api/projects/p-m4/transcribe",
    handler: () => ({
      job: {
        id: "j-m4",
        kind: "transcribe",
        status: "succeeded",
        progress: 1,
        project_id: "p-m4",
        result: { project: project("p-m4", { transcripts: [transcript("tr-9", "closed run")] }) },
      },
    }),
  });
  persistence.adoptServerProject(project("p-m4")); // ベースライン S

  const started = persistence.startTranscribe("small");
  // ジョブ中の手編集 → editVersion がずれるので完了時は部分採用（transcripts のみ）。
  // startTranscribe は冒頭で flushSave を await してから startVersion を確定するため、
  // 同期に触ると「編集なし」扱い（= 全置換採用）になる。1ティック待って起票後に編集する。
  await sleep(10);
  state.project.blocks[0].start = 4;
  state.editVersion += 1;
  viewClosed = true; // 閉じている間に完了
  await started;
  assert.equal(state.project.blocks[0].start, 4, "部分採用経路（全置換ではない）を通ったこと");

  viewClosed = false;
  await persistence.discardToSnapshot();
  assert.deepEqual(
    state.project.transcripts,
    [transcript("tr-9", "closed run")],
    "文字起こし結果は破棄対象外（閉じている間の部分採用でも維持）",
  );
  assert.equal(state.project.blocks[0].start, 0, "手編集は開いた時点へ巻き戻る");
});
