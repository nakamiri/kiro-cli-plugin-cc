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


// --- Records that cannot be trusted ---
//
// Everything below plants files directly and calls the store. These paths used
// to be covered by spawning the CLI once per case, which answered the same
// question about the same on-disk state several hundred milliseconds slower.

const { readJobResult, pruneJobs } = await import("../plugins/kiro-cli/scripts/lib/jobs.js");
const { dispatch } = await import("../plugins/kiro-cli/scripts/lib/kiro-companion.js");
const { mkdirSync, writeFileSync } = await import("node:fs");

/** Writes a file into the jobs directory verbatim, valid or not. */
function plantFile(name, contents) {
  mkdirSync(tmpJobsDir, { recursive: true });
  writeFileSync(join(tmpJobsDir, name), contents);
}

const GOOD = { id: "kiro-good0001-aa", kind: "review", status: "completed", startedAt: "2026-01-02T00:00:00.000Z", finishedAt: "2026-01-02T00:00:01.000Z", resultBytes: 2 };

test("a record that cannot be trusted is ignored, and does not take the listing with it", () => {
  // One malformed file used to raise out of every command that read the store.
  const unusable = {
    "truncated.json": '{"id":"truncated","kind":"rev',
    "foreign.json": '{"unrelated":true}',
    "array.json": "[1,2,3]",
    // saveJob writes <id>.json, so a record naming something else could never be
    // updated through its own id: it read as running for ever while a second,
    // cancelled record accumulated alongside it.
    "kiro-mismatch-aa.json": JSON.stringify({ ...GOOD, id: "kiro-somethingelse-aa" }),
    // Each of these fields is used for ordering, pruning or accounting, and a
    // value of the wrong type silently poisoned all three.
    "kiro-badstart-aa.json": JSON.stringify({ ...GOOD, id: "kiro-badstart-aa", startedAt: "whenever" }),
    "kiro-badfinis-aa.json": JSON.stringify({ ...GOOD, id: "kiro-badfinis-aa", finishedAt: "soon" }),
    "kiro-badbytes-aa.json": JSON.stringify({ ...GOOD, id: "kiro-badbytes-aa", resultBytes: "9999" }),
    "kiro-badbudge-aa.json": JSON.stringify({ ...GOOD, id: "kiro-badbudge-aa", timeoutMs: "60000" }),
  };
  for (const [name, contents] of Object.entries(unusable)) plantFile(name, contents);
  plantFile(`${GOOD.id}.json`, JSON.stringify(GOOD));
  plantFile(`${GOOD.id}.out`, "ok");

  assert.deepEqual(listJobs().map((j) => j.id), [GOOD.id]);
  assert.equal(result([]), "ok");
  assert.equal(cancel([]), "No running jobs to cancel.");
  for (const name of Object.keys(unusable)) {
    const id = name.slice(0, -".json".length);
    assert.equal(loadJob(id), null, `${name} was accepted`);
  }
});

test("an unreadable record is not reported as a missing one", async () => {
  // A directory where the record should be: readFileSync raises EISDIR, which
  // is emphatically not "this job does not exist".
  mkdirSync(join(tmpJobsDir, "kiro-unread01-aa.json"), { recursive: true });
  assert.throws(() => loadJob("kiro-unread01-aa"), /EISDIR/);
  // Slash commands render stdout, so dispatch turns it into a line the user can
  // see rather than a stack trace on stderr.
  const out = await dispatch("status", ["kiro-unread01-aa"]);
  assert.match(out, /^ERROR: /);
  assert.doesNotMatch(out, /No job found/);
  // And it does not break the commands that read the whole store.
  saveJob({ id: "kiro-fine0001-aa", kind: "review", status: "completed", startedAt: NOW(), finishedAt: NOW() });
  assert.deepEqual(JSON.parse(status([])).map((j) => j.id), ["kiro-fine0001-aa"]);
  assert.equal(cancel([]), "No running jobs to cancel.");
  // Housekeeping must not be able to fail a job either.
  assert.doesNotThrow(() => pruneJobs());
});

// --- The transcript, which lives beside the record ---

test("status reports a transcript by size; result is what hands the body over", () => {
  const big = "R".repeat(40_000);
  saveJob({ id: "kiro-big00001-aa", kind: "review", status: "completed", startedAt: NOW(), finishedAt: NOW() });
  saveJob({ id: "kiro-big00001-aa", kind: "review", status: "completed", startedAt: NOW(), finishedAt: NOW(), resultBytes: saveJobResult("kiro-big00001-aa", big) });
  const job = JSON.parse(status(["kiro-big00001-aa"]));
  assert.equal(job.resultBytes, 40_000);
  assert.equal(job.result, undefined, "status inlined the transcript");
  assert.equal(result(["kiro-big00001-aa"]), big);
});

test("a pre-split record still gives up its transcript, without re-emitting it", () => {
  // Before the split the transcript lived inside the metadata. Without the
  // fallback the commands reported "No result stored." with the body right there.
  plantFile("kiro-inline01-aa.json", JSON.stringify({
    id: "kiro-inline01-aa", kind: "review", status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z",
    result: "the old review body",
  }));
  assert.equal(readJobResult("kiro-inline01-aa"), "the old review body");
  assert.match(result(["kiro-inline01-aa"]), /the old review body/);
  const listed = JSON.parse(status([]))[0];
  assert.equal(listed.result, undefined, "status re-emitted an inline transcript");
  assert.equal(listed.resultBytes, Buffer.byteLength("the old review body"));
});

test("an unreadable transcript is reported, not called an absence of output", () => {
  // Swallowing the read error made this indistinguishable from a missing
  // transcript, so a completed job reported "No output was recorded." while its
  // own status advertised the bytes.
  saveJob({ id: "kiro-lostout1-aa", kind: "review", status: "completed", startedAt: NOW(), finishedAt: NOW(), resultBytes: 1234 });
  mkdirSync(join(tmpJobsDir, "kiro-lostout1-aa.out"), { recursive: true });
  const out = result(["kiro-lostout1-aa"]);
  assert.match(out, /1234/);
  assert.doesNotMatch(out, /No output was recorded/);
});

test("a run that genuinely printed nothing says so, from either path", () => {
  saveJob({ id: "kiro-silent01-aa", kind: "review", status: "completed", startedAt: NOW(), finishedAt: NOW(), resultBytes: saveJobResult("kiro-silent01-aa", "") });
  assert.equal(result(["kiro-silent01-aa"]), "No output was recorded.");
  assert.equal(result([]), "No output was recorded.");
});

// --- Which run is "the latest" ---

test("the latest run is the one that finished last, not the one that started last", () => {
  // Two overlapping background jobs. Ordering by startedAt handed back the
  // older transcript, and pruning deleted the newer one.
  saveJob({ id: "kiro-startfir-aa", kind: "review", status: "completed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:10:00.000Z", resultBytes: saveJobResult("kiro-startfir-aa", "finished last") });
  saveJob({ id: "kiro-startsec-aa", kind: "review", status: "completed", startedAt: "2026-01-01T00:05:00.000Z", finishedAt: "2026-01-01T00:06:00.000Z", resultBytes: saveJobResult("kiro-startsec-aa", "finished first") });
  assert.match(result([]), /finished last/);
});

test("a stale running record does not shadow later results", () => {
  // reconcile must not synthesize finishedAt for a record it fails: doing so
  // made one stale record look like the most recently finished job on every
  // read, hiding every genuine result for the whole retention window.
  saveJob({ id: "kiro-stale001-aa", kind: "rescue", status: "running", startedAt: "2026-01-01T00:00:00.000Z" });
  saveJob({ id: "kiro-real0001-aa", kind: "review", status: "completed", startedAt: NOW(), finishedAt: NOW(), resultBytes: saveJobResult("kiro-real0001-aa", "the actual review") });
  assert.match(result([]), /the actual review/);
});

// --- cancel, when there is nothing it can do ---

test("cancel refuses a record that is not running, and does not claim otherwise", () => {
  // A live pid that is plainly not our runner has the shape of a pre-reboot
  // record whose pid has been recycled. Claiming a cancellation we did not
  // perform is the worst outcome: Kiro would keep working under
  // --trust-all-tools while the user was told it had stopped, and its result
  // would then be discarded when the runner found a terminal record.
  // That nothing is actually signalled is a property of a process, and is
  // asserted in runkiro.test.mjs against a child's own pid.
  const cases = {
    "kiro-finished1-aa": { status: "completed", pid: process.pid, expect: /already completed; nothing to cancel/ },
    "kiro-foreign01-aa": { status: "running", pid: process.pid, expect: /already failed; nothing to cancel/ },
    "kiro-deadpid01-aa": { status: "running", pid: 4194304, expect: /already failed; nothing to cancel/ },
  };
  for (const [id, { status: st, pid }] of Object.entries(cases)) {
    saveJob({ id, kind: "review", status: st, startedAt: NOW(), pid });
  }
  for (const [id, { expect }] of Object.entries(cases)) {
    const out = cancel([id]);
    assert.match(out, expect, `${id}: ${out}`);
    assert.doesNotMatch(out, /Cancelled job/, `${id} claimed a cancellation it did not perform`);
  }
  assert.equal(cancel([]), "No running jobs to cancel.");
});

test("an empty argument is treated as no argument at all", () => {
  assert.equal(status([""]), "No Kiro jobs found.");
  assert.equal(result([""]), "No finished jobs found.");
  assert.equal(cancel([""]), "No running jobs to cancel.");
});
