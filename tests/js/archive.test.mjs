// アーカイブ / 復元（Issue #22）のフロント側テスト。
// persistence.test.mjs と同じ流儀: state / api / persistence は実物、fetch のみモック。
// 対象:
//   1. canArchiveProject: 両トラックの original_file + normalized_wav が揃うときだけ可
//   2. archiveEstimateBytes: 48kHz/16bit/mono の概算（duration ベース）
//   3. openProjectFolder: restore_job 付き応答 → ジョブ完了の result.project を採用
//   4. archiveProject: 保存（PUT）→ POST /archive の順序

import test from "node:test";
import assert from "node:assert/strict";

import { state, on } from "../../src/podcast_prep/static/js/state.js";
import * as persistence from "../../src/podcast_prep/static/js/persistence.js";

// ── fetch モック（persistence.test.mjs と同形） ──────────

let routes = [];
let fetchLog = [];

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

function resetWorld() {
  routes = [];
  fetchLog = [];
  state.project = null;
  state.projectEpoch += 1;
  state.editVersion += 1;
}

function makeProject(id, extra = {}) {
  return {
    id,
    name: `project ${id}`,
    status: "ready",
    settings: {},
    tracks: {
      A: { speaker: "A", original_file: "speakerA.wav", normalized_wav: "speakerA_normalized.wav", duration: 60 },
      B: { speaker: "B", original_file: "speakerB.wav", normalized_wav: "speakerB_normalized.wav", duration: 60 },
    },
    blocks: [],
    transcripts: [],
    overlaps: [],
    ...extra,
  };
}

// ── canArchiveProject ────────────────────────────────────

test("canArchiveProject: 両トラック揃いのときだけ true", () => {
  const project = makeProject("p1");
  assert.equal(persistence.canArchiveProject(project), true);
  assert.equal(persistence.canArchiveProject(null), false);
  const noOriginal = makeProject("p2");
  noOriginal.tracks.B.original_file = "";
  assert.equal(persistence.canArchiveProject(noOriginal), false);
  const noWav = makeProject("p3");
  noWav.tracks.A.normalized_wav = "";
  assert.equal(persistence.canArchiveProject(noWav), false);
  const archived = makeProject("p4", { archived: { tracks: {} } });
  assert.equal(persistence.canArchiveProject(archived), false);
});

test("archiveEstimateBytes: duration × 48000 × 2 の合算（不正値は 0 扱い）", () => {
  const project = makeProject("p5");
  assert.equal(persistence.archiveEstimateBytes(project), 2 * 60 * 48000 * 2);
  project.tracks.B.duration = "broken";
  assert.equal(persistence.archiveEstimateBytes(project), 60 * 48000 * 2);
  assert.equal(persistence.archiveEstimateBytes(null), 0);
});

// ── openProjectFolder の復元ジョブ ───────────────────────

test("openProjectFolder: restore_job 付き応答はジョブ完了の result.project を採用する", async () => {
  resetWorld();
  const opened = makeProject("arch-1", { status: "ready" });
  opened.tracks.A.normalized_wav = "";
  opened.tracks.B.normalized_wav = "";
  const restored = makeProject("arch-1");
  // pollJob は初回ジョブが complete なら即返る（タイマー不要にする）
  routes.push({
    match: (url) => url === "/api/projects/open",
    handler: () => ({
      project: opened,
      restore_job: {
        id: "job-restore",
        kind: "restore",
        status: "complete",
        progress: 1,
        result: { project: restored },
      },
    }),
  });
  const progressed = [];
  const off = on("job-progress", (job) => progressed.push(job));
  const project = await persistence.openProjectFolder("/tmp/arch-folder");
  off?.();
  assert.equal(project.id, "arch-1");
  assert.equal(state.project.tracks.A.normalized_wav, "speakerA_normalized.wav"); // 復元後を採用
  assert.equal(progressed.length, 1);
  assert.equal(progressed[0].kind, "restore");
});

test("openProjectFolder: restore_job が失敗したら throw して採用しない", async () => {
  resetWorld();
  routes.push({
    match: (url) => url === "/api/projects/open",
    handler: () => ({
      project: makeProject("arch-2"),
      restore_job: {
        id: "job-restore-2",
        kind: "restore",
        status: "error",
        error: "復元した音声が記録と一致しません",
      },
    }),
  });
  await assert.rejects(
    () => persistence.openProjectFolder("/tmp/arch-folder"),
    /一致しません/,
  );
  assert.equal(state.project, null); // 失敗時は採用しない
});

// ── archiveProject ───────────────────────────────────────

test("archiveProject: 保存 PUT → POST /archive の順で呼ぶ", async () => {
  resetWorld();
  const project = makeProject("arch-3");
  persistence.adoptServerProject(project);
  routes.push({
    match: (url, options) => url === `/api/projects/arch-3` && (options.method || "GET") === "PUT",
    handler: () => ({ project }),
  });
  routes.push({
    match: (url, options) => url === "/api/projects/arch-3/archive" && options.method === "POST",
    handler: () => ({ project: { ...project, status: "archived" }, freed_bytes: 1048576 }),
  });
  fetchLog = [];
  const res = await persistence.archiveProject();
  assert.equal(res.freed_bytes, 1048576);
  const calls = fetchLog.map((entry) => `${entry.method} ${entry.url}`);
  assert.deepEqual(calls, ["PUT /api/projects/arch-3", "POST /api/projects/arch-3/archive"]);
});
