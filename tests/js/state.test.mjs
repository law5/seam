import test from "node:test";
import assert from "node:assert/strict";

import {
  state, emit, on, beginJob, endJob, isJobBusy,
} from "../../src/podcast_prep/static/js/state.js";

test("state: 初期形", () => {
  assert.equal(state.project, null);
  assert.deepEqual(state.peaks, { A: null, B: null });
  assert.deepEqual(state.wavMeta, { A: null, B: null });
  assert.equal(state.selectedBlockId, null);
  assert.equal(state.zoom, 80);
  assert.equal(state.editVersion, 0);
  assert.equal(state.projectEpoch, 0);
  assert.equal(state.jobsInFlight, 0);
});

test("イベントバス: emit/on はdetailを渡す・解除関数が効く", () => {
  const received = [];
  const off = on("blocks-changed", (detail) => received.push(detail));
  emit("blocks-changed", { n: 1 });
  emit("blocks-changed"); // detail省略はCustomEvent仕様どおりnullで届く
  assert.deepEqual(received, [{ n: 1 }, null]);

  off();
  emit("blocks-changed", { n: 2 });
  assert.equal(received.length, 2);
});

test("イベントバス: 複数購読者・イベント名の分離", () => {
  const a = [];
  const b = [];
  const offA = on("playhead-tick", (t) => a.push(t));
  const offB = on("playhead-tick", (t) => b.push(t * 2));
  const offC = on("zoom-changed", () => a.push("zoom"));
  emit("playhead-tick", 1.5);
  assert.deepEqual(a, [1.5]);
  assert.deepEqual(b, [3]);
  emit("zoom-changed");
  assert.deepEqual(a, [1.5, "zoom"]);
  offA();
  offB();
  offC();
});

// ── Issue #57 QA(根因): プロジェクト対象ジョブ在否の単一の正 ──
// 従来 jobBusy は main.js のローカル変数で、panels.js の後がけ正規化だけが自前の
// normalizeBusy を使い**グローバルには busy を立てていなかった**。そのため正規化の裏で
// 「編集を破棄して閉じる」・復元・別プロジェクト取込が通り、閉じたビューと採用が交錯した
// （#57 High / Medium 双方の前提）。在否は state に集約し、UI は "job-busy" で追随する。

test("beginJob/endJob: 在否が state に集約され isJobBusy に反映される", () => {
  assert.equal(isJobBusy(), false);
  beginJob();
  assert.equal(isJobBusy(), true);
  assert.equal(state.jobsInFlight, 1);
  endJob();
  assert.equal(isJobBusy(), false);
});

test("beginJob/endJob: カウンタなので同時進行（正規化 + 文字起こし）でも早期に false へ落ちない", () => {
  // ローカル boolean 方式だと先に終わったジョブが busy を落とし、残っているジョブの
  // 最中に破棄・復元が通ってしまう。
  beginJob(); // 正規化
  beginJob(); // 文字起こし
  endJob();   // 文字起こしだけ完了
  assert.equal(isJobBusy(), true, "正規化が残っている間は busy のまま");
  endJob();
  assert.equal(isJobBusy(), false);
});

test('"job-busy": 立ち上がり/立ち下がりのエッジだけ通知する（重複描画を避ける）', () => {
  const seen = [];
  const off = on("job-busy", (detail) => seen.push(detail.busy));
  beginJob();
  beginJob();
  endJob();
  endJob();
  off();
  assert.deepEqual(seen, [true, false]);
  assert.equal(isJobBusy(), false);
});

test("endJob: 二重呼び出しでもカウンタが負にならない（busy の取りこぼし防止）", () => {
  endJob();
  endJob();
  assert.equal(state.jobsInFlight, 0);
  assert.equal(isJobBusy(), false);
  // 直後の beginJob が正しく busy を立てられる（負値なら立たない）
  beginJob();
  assert.equal(isJobBusy(), true);
  endJob();
});
