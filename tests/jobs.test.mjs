import { test, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpJobsDir;

beforeEach(() => {
  if (tmpJobsDir && existsSync(tmpJobsDir)) {
    rmSync(tmpJobsDir, { recursive: true, force: true });
  }
  tmpJobsDir = mkdtempSync(join(tmpdir(), "kiro-jobs-test-"));
  process.env.KIRO_PLUGIN_JOBS_DIR = tmpJobsDir;
});

// Import after setting the env var so the module reads it lazily via getJobsDir().
const { saveJob, loadJob, listJobs, cancel, status, result, getJobsDir } =
  await import("../plugins/kiro-cli/scripts/lib/kiro-companion.js");

test("getJobsDir: respects KIRO_PLUGIN_JOBS_DIR env var", () => {
  assert.equal(getJobsDir(), tmpJobsDir);
});

test("saveJob + loadJob: roundtrip", () => {
  const job = {
    id: "test-1",
    kind: "review",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  saveJob(job);
  const loaded = loadJob("test-1");
  assert.deepEqual(loaded, job);
});

test("loadJob: returns null for missing job", () => {
  assert.equal(loadJob("does-not-exist"), null);
});

test("listJobs: returns jobs sorted by startedAt descending", () => {
  saveJob({ id: "a", kind: "review", status: "completed", startedAt: "2026-01-01T00:00:00.000Z" });
  saveJob({ id: "b", kind: "rescue", status: "running", startedAt: "2026-01-02T00:00:00.000Z" });
  saveJob({ id: "c", kind: "review", status: "failed", startedAt: "2026-01-03T00:00:00.000Z" });
  const jobs = listJobs();
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map((j) => j.id), ["c", "b", "a"]);
});

test("listJobs: returns empty array when no jobs", () => {
  assert.deepEqual(listJobs(), []);
});

test("status command: returns specific job by ID as JSON", () => {
  saveJob({ id: "job-x", kind: "review", status: "completed", startedAt: "2026-01-01T00:00:00.000Z" });
  const out = status(["job-x"]);
  const parsed = JSON.parse(out);
  assert.equal(parsed.id, "job-x");
});

test("status command: reports missing job", () => {
  const out = status(["nope"]);
  assert.match(out, /No job found with ID: nope/);
});

test("status command: reports empty when no jobs", () => {
  const out = status([]);
  assert.equal(out, "No Kiro jobs found.");
});

test("status command: lists multiple jobs as JSON array", () => {
  saveJob({ id: "j1", kind: "review", status: "completed", startedAt: "2026-01-01T00:00:00.000Z" });
  saveJob({ id: "j2", kind: "rescue", status: "running", startedAt: "2026-01-02T00:00:00.000Z" });
  const out = status([]);
  const parsed = JSON.parse(out);
  assert.equal(parsed.length, 2);
});

test("result command: returns latest completed job result by default", () => {
  saveJob({
    id: "old", kind: "review", status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z", result: "old-output",
  });
  saveJob({
    id: "new", kind: "review", status: "completed",
    startedAt: "2026-01-05T00:00:00.000Z", result: "new-output",
  });
  saveJob({
    id: "running", kind: "rescue", status: "running",
    startedAt: "2026-01-10T00:00:00.000Z",
  });
  assert.equal(result([]), "new-output");
});

test("result command: by ID returns that job's result", () => {
  saveJob({
    id: "specific", kind: "review", status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z", result: "specific-output",
  });
  assert.equal(result(["specific"]), "specific-output");
});

test("result command: warns when job is still running", () => {
  saveJob({ id: "r1", kind: "rescue", status: "running", startedAt: "2026-01-01T00:00:00.000Z" });
  const out = result(["r1"]);
  assert.match(out, /still running/);
});

test("result command: reports missing job", () => {
  const out = result(["missing"]);
  assert.match(out, /No job found with ID: missing/);
});

test("result command: reports no completed jobs", () => {
  saveJob({ id: "r1", kind: "rescue", status: "running", startedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(result([]), "No completed jobs found.");
});

test("cancel command: marks specified job as cancelled", () => {
  saveJob({ id: "c1", kind: "review", status: "running", startedAt: "2026-01-01T00:00:00.000Z" });
  const out = cancel(["c1"]);
  assert.match(out, /Cancelled job c1/);
  const reloaded = loadJob("c1");
  assert.equal(reloaded.status, "cancelled");
  assert.ok(reloaded.finishedAt);
});

test("cancel command: with no ID cancels first running job", () => {
  saveJob({ id: "done", kind: "review", status: "completed", startedAt: "2026-01-01T00:00:00.000Z" });
  saveJob({ id: "live", kind: "rescue", status: "running", startedAt: "2026-01-02T00:00:00.000Z" });
  const out = cancel([]);
  assert.match(out, /Cancelled job live/);
  assert.equal(loadJob("live").status, "cancelled");
  assert.equal(loadJob("done").status, "completed");
});

test("cancel command: reports when no running jobs", () => {
  saveJob({ id: "done", kind: "review", status: "completed", startedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(cancel([]), "No running jobs to cancel.");
});

test("cancel command: reports missing job", () => {
  const out = cancel(["nope"]);
  assert.match(out, /No job found with ID: nope/);
});
