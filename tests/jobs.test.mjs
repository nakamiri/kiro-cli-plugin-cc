import { test, after, beforeEach } from "node:test";
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

// beforeEach only clears the *previous* directory, so the last one would be
// left behind on every run.
after(() => {
  if (tmpJobsDir && existsSync(tmpJobsDir)) rmSync(tmpJobsDir, { recursive: true, force: true });
});

// Import after setting the env var so the module reads it lazily via getJobsDir().
const { saveJob, saveJobResult, loadJob, loadJobRaw, listJobs, cancel, status, result, getJobsDir } =
  await import("../plugins/kiro-cli/scripts/lib/kiro-companion.js");

// A record that claims "running" is only believed while it plausibly still is:
// the launcher records a pid within milliseconds, so a pid-less "running"
// record from months ago means the launcher died. Fixtures for a job that is
// meant to be genuinely in flight therefore have to be recent.
const NOW = () => new Date().toISOString();

test("getJobsDir: respects KIRO_PLUGIN_JOBS_DIR env var", () => {
  assert.equal(getJobsDir(), tmpJobsDir);
});

test("saveJob + loadJob: roundtrip", () => {
  const job = {
    id: "test-1",
    kind: "review",
    status: "running",
    startedAt: NOW(),
  };
  saveJob(job);
  assert.deepEqual(loadJob("test-1"), job);
});

test("saveJob + loadJobRaw: stores a record verbatim, without interpretation", () => {
  // loadJob reports a stale in-flight record as failed; loadJobRaw must not.
  const job = {
    id: "test-raw",
    kind: "review",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  saveJob(job);
  assert.deepEqual(loadJobRaw("test-raw"), job);
  assert.equal(loadJob("test-raw").status, "failed");
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

test("result command: returns the latest finished job's result by default", () => {
  saveJob({ id: "old", kind: "review", status: "completed", startedAt: "2026-01-01T00:00:00.000Z" });
  saveJobResult("old", "old-output");
  saveJob({ id: "new", kind: "review", status: "completed", startedAt: "2026-01-05T00:00:00.000Z" });
  saveJobResult("new", "new-output");
  saveJob({ id: "running", kind: "rescue", status: "running", startedAt: NOW() });
  assert.equal(result([]), "new-output");
});

test("result command: by ID returns that job's result", () => {
  saveJob({ id: "specific", kind: "review", status: "completed", startedAt: "2026-01-01T00:00:00.000Z" });
  saveJobResult("specific", "specific-output");
  assert.equal(result(["specific"]), "specific-output");
});

test("result command: warns when job is still running", () => {
  saveJob({ id: "r1", kind: "rescue", status: "running", startedAt: NOW() });
  const out = result(["r1"]);
  assert.match(out, /still running/);
});

test("result command: reports missing job", () => {
  const out = result(["missing"]);
  assert.match(out, /No job found with ID: missing/);
});

test("result command: reports when nothing has finished yet", () => {
  saveJob({ id: "r1", kind: "rescue", status: "running", startedAt: NOW() });
  assert.equal(result([]), "No finished jobs found.");
});

test("result command: falls back to the newest finished job whatever its outcome", () => {
  // Filtering to "completed" quietly handed back an older run's transcript
  // after a failure, and left the failed run reachable only by its id.
  saveJob({ id: "ok", kind: "review", status: "completed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.000Z" });
  saveJobResult("ok", "older-but-successful");
  saveJob({ id: "bad", kind: "review", status: "failed", startedAt: "2026-01-05T00:00:00.000Z", finishedAt: "2026-01-05T00:00:00.000Z" });
  saveJobResult("bad", "what actually just happened");
  const out = result([]);
  assert.match(out, /what actually just happened/);
  assert.match(out, /\[job bad \(review\) failed\]/);
  assert.doesNotMatch(out, /older-but-successful/);
});

test("cancel command: refuses a job with no runner recorded yet", () => {
  // Only a launcher mid-flight looks like this. Reporting a cancellation we
  // cannot perform would leave Kiro working while the user believed otherwise.
  saveJob({ id: "c1", kind: "review", status: "running", startedAt: NOW() });
  const out = cancel(["c1"]);
  assert.match(out, /Could not cancel job c1/);
  assert.match(out, /still starting/);
  assert.equal(loadJob("c1").status, "running");
});

test("cancel command: with no ID selects the running job", () => {
  saveJob({ id: "done", kind: "review", status: "completed", startedAt: "2026-01-01T00:00:00.000Z" });
  saveJob({ id: "live", kind: "rescue", status: "running", startedAt: NOW() });
  const out = cancel([]);
  // It picked "live" rather than the finished record; it declines to act on it
  // only because no runner has been recorded for it yet.
  assert.match(out, /job live/);
  assert.doesNotMatch(out, /done/);
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

test("a pid-less running record is reported as failed once its launch window passes", () => {
  // Written by the launcher before it knew the runner's pid; it never came back.
  saveJob({ id: "stillborn", kind: "review", status: "running", startedAt: "2026-01-01T00:00:00.000Z" });
  const job = loadJob("stillborn");
  assert.equal(job.status, "failed");
  assert.match(job.note, /never started/);
  assert.equal(cancel([]), "No running jobs to cancel.");
});
