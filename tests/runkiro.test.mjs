// Regression tests for how the companion actually invokes kiro-cli: argument
// passing, background detachment, and job-store robustness. The pre-existing
// suites never entered these paths, which is why a shell-injection bug and a
// non-detaching "background" mode both survived.
import { test, after, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPANION = resolve(__dirname, "..", "plugins", "kiro-cli", "scripts", "kiro-companion.mjs");

let tmpDir;
let jobsDir;
const created = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kiro-runkiro-test-"));
  jobsDir = join(tmpDir, "jobs");
  created.push(tmpDir);
});

// A runner can outlive its own afterEach by longer than that hook will wait, so
// sweep once more at the end, when nothing this file started is still alive.
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  // Tests start detached runners. Left alive they keep their fake kiro-cli
  // running and recreate the jobs directory through ensureJobsDir() as soon as
  // it is removed, which is how ~50 stale temp dirs accumulated per suite run.
  for (const job of safeReadJobs()) {
    if (job.status !== "running" || typeof job.pid !== "number") continue;
    // Only ever signal a real runner. Some fixtures deliberately record
    // process.pid to stand in for a recycled pid, and group-killing that would
    // take this test process down with it.
    if (!isRunnerPid(job.pid)) continue;
    try { process.kill(-job.pid, "SIGKILL"); } catch {
      try { process.kill(job.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  // A runner already past its record write can still be in its flush grace and
  // recreate the directory through ensureJobsDir(); retry until it stays gone.
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 150 : 250));
    rmSync(tmpDir, { recursive: true, force: true });
    if (!existsSync(tmpDir)) break;
  }
});

function safeReadJobs() {
  try {
    return readJobs();
  } catch {
    return [];
  }
}

function isRunnerPid(pid) {
  if (pid === process.pid) return false;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8").includes("kiro-runner");
  } catch {
    return false;
  }
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: "utf-8",
    env: { ...process.env, KIRO_PLUGIN_JOBS_DIR: jobsDir, ...env },
  });
}

/** Drives the --args-stdin route the slash commands use for free-form text. */
function runWithStdin(args, stdin, env = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args, "--args-stdin"], {
    encoding: "utf-8",
    input: stdin,
    env: { ...process.env, KIRO_PLUGIN_JOBS_DIR: jobsDir, ...env },
  });
}

/** A fake kiro-cli that prints its own argv, one argument per line. */
function fakeEchoKiro(name = "fake-kiro-cli") {
  const path = join(tmpDir, name);
  writeFileSync(
    path,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "kiro-cli 1.2.3"; exit 0; fi\n' +
      'for a in "$@"; do echo "ARG:$a"; done\n',
    { mode: 0o755 }
  );
  return path;
}

function fakeSlowKiro(seconds, markerPath) {
  const path = join(tmpDir, "fake-slow-kiro");
  const marker = markerPath ? `touch "${markerPath}"\n` : "";
  writeFileSync(path, `#!/bin/sh\nsleep ${seconds}\n${marker}echo "slow done"\n`, { mode: 0o755 });
  return path;
}

/** A job's transcript now lives beside its record, not inside it. */
function resultOf(id) {
  return readFileSync(join(jobsDir, `${id}.out`), "utf-8");
}

function readJobs() {
  const jobs = [];
  for (const f of readdirSync(jobsDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      jobs.push(JSON.parse(readFileSync(join(jobsDir, f), "utf-8")));
    } catch {
      // Some tests deliberately plant unreadable entries; skip them here.
    }
  }
  return jobs;
}

async function waitForJob(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jobs = readJobs();
    const hit = jobs.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for job; saw ${JSON.stringify(readJobs())}`);
}

// --- Argument passing (no shell) ---

test("prompt metacharacters reach kiro-cli literally, unexpanded", () => {
  const kiro = fakeEchoKiro();
  const r = run(["rescue", "fix the $(id -u) and `hostname` bug"], { KIRO_CLI_PATH: kiro });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // One argv entry, verbatim: no command substitution, no word splitting.
  assert.match(r.stdout, /^ARG:fix the \$\(id -u\) and `hostname` bug$/m);
  assert.doesNotMatch(r.stdout, /ARG:fix the 0 /);
});

test("prompt with quotes and semicolons stays a single argument", () => {
  const kiro = fakeEchoKiro();
  const r = run(["rescue", 'a "quoted" thing; echo pwned'], { KIRO_CLI_PATH: kiro });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // The whole string arrives as one argv entry, so the `;` never separated
  // commands: a bare "pwned" line would mean the shell had run the echo.
  assert.match(r.stdout, /^ARG:a "quoted" thing; echo pwned$/m);
  assert.doesNotMatch(r.stdout, /^pwned$/m);
  assert.equal(r.stdout.trim().split("\n").length, 4);
});

test("a kiro-cli path containing spaces works for both setup and rescue", () => {
  const dir = join(tmpDir, "my dir");
  mkdirSync(dir);
  const kiro = fakeEchoKiro(join("my dir", "fake-kiro-cli"));
  assert.ok(kiro.includes(" "));
  const s = run(["setup"], { KIRO_CLI_PATH: kiro });
  assert.match(s.stdout, /kiro-cli is ready/);
  assert.match(s.stdout, /Version: kiro-cli 1\.2\.3/);
  const r = run(["rescue", "hello"], { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /^ARG:hello$/m);
  assert.doesNotMatch(r.stdout, /not found/);
});

test("review passes --trust-all-tools by default and drops it when opted out", () => {
  const kiro = fakeEchoKiro();
  const on = run(["review"], { KIRO_CLI_PATH: kiro });
  assert.match(on.stdout, /^ARG:--trust-all-tools$/m);
  const off = run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_TRUST_ALL_TOOLS: "0" });
  assert.doesNotMatch(off.stdout, /^ARG:--trust-all-tools$/m);
  assert.match(off.stdout, /^ARG:--no-interactive$/m);
});

test("setup reports a found-but-unrunnable binary as an error, not as ready", () => {
  const broken = join(tmpDir, "not-executable");
  writeFileSync(broken, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  const r = run(["setup"], { KIRO_CLI_PATH: broken });
  assert.match(r.stdout, /could not be run/);
  assert.doesNotMatch(r.stdout, /is ready/);
  const j = JSON.parse(run(["setup", "--json"], { KIRO_CLI_PATH: broken }).stdout);
  assert.equal(j.installed, true);
  assert.equal(j.runnable, false);
  assert.ok(j.error);
});

// --- Background jobs ---

test("--background returns immediately instead of waiting for kiro-cli", () => {
  const kiro = fakeSlowKiro(5);
  const started = Date.now();
  const r = run(["review", "--background"], { KIRO_CLI_PATH: kiro });
  const elapsed = Date.now() - started;
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).status, "started");
  assert.ok(elapsed < 3000, `expected an immediate return, took ${elapsed}ms`);
});

test("a background job completes after the process that started it has exited", async () => {
  const kiro = fakeSlowKiro(2);
  const r = run(["rescue", "--background", "do the thing"], { KIRO_CLI_PATH: kiro });
  const { jobId } = JSON.parse(r.stdout);
  // spawnSync has already reaped the starter, so only a detached runner can finish this.
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running");
  assert.equal(job.status, "completed");
  assert.match(resultOf(job.id), /slow done/);
  assert.ok(job.finishedAt);
});

test("job kind records the command, not the generated prompt", async () => {
  const kiro = fakeEchoKiro();
  const rev = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  const res = JSON.parse(run(["rescue", "--background", "fix it"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === rev.jobId && j.status !== "running");
  await waitForJob((j) => j.id === res.jobId && j.status !== "running");
  const kinds = readJobs().map((j) => j.kind).sort();
  assert.deepEqual(kinds, ["rescue", "review"]);
});

test("a failing background job is recorded as failed with its output", async () => {
  const kiro = join(tmpDir, "failing-kiro");
  writeFileSync(kiro, '#!/bin/sh\necho "boom" >&2\nexit 3\n', { mode: 0o755 });
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running");
  assert.equal(job.status, "failed");
  assert.match(resultOf(job.id), /boom/);
});

test("cancel stops a running background job and its kiro-cli child", async () => {
  // The marker is only written once the sleep finishes, so its absence proves
  // the kiro-cli child itself was killed -- not merely the runner above it.
  const marker = join(tmpDir, "kiro-finished");
  const kiro = fakeSlowKiro(2, marker);
  const { jobId } = JSON.parse(run(["rescue", "--background", "long task"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  const c = run(["cancel", jobId]);
  assert.match(c.stdout, new RegExp(`Cancelled job ${jobId}`));
  assert.equal(JSON.parse(run(["status", jobId]).stdout).status, "cancelled");
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(existsSync(marker), false, "kiro-cli kept running after cancel");
  // A cancelled record must not be overwritten by a late runner write.
  assert.equal(JSON.parse(run(["status", jobId]).stdout).status, "cancelled");
});

test("cancel refuses a job that is no longer running instead of signalling its pid", () => {
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(
    join(jobsDir, "done.json"),
    JSON.stringify({ id: "done", kind: "review", status: "completed", startedAt: "2026-01-01T00:00:00.000Z", pid: 1 })
  );
  const r = run(["cancel", "done"]);
  assert.match(r.stdout, /already completed; nothing to cancel/);
});

test("a running job whose runner died is reported as failed, not as running forever", () => {
  mkdirSync(jobsDir, { recursive: true });
  // pid 2^22 is above the default pid_max, so it can never be live.
  writeFileSync(
    join(jobsDir, "orphan.json"),
    JSON.stringify({ id: "orphan", kind: "rescue", status: "running", startedAt: "2026-01-01T00:00:00.000Z", pid: 4194304 })
  );
  const s = JSON.parse(run(["status", "orphan"]).stdout);
  assert.equal(s.status, "failed");
  assert.match(s.note, /without recording a result/);
  assert.match(run(["cancel"]).stdout, /No running jobs to cancel/);
});

// --- Job store robustness ---

test("a corrupt or foreign json file in the jobs dir does not break any command", () => {
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(join(jobsDir, "truncated.json"), '{"id":"truncated","kind":"rev');
  writeFileSync(join(jobsDir, "foreign.json"), '{"unrelated":true}');
  writeFileSync(join(jobsDir, "array.json"), "[1,2,3]");
  writeFileSync(
    join(jobsDir, "good.json"),
    JSON.stringify({ id: "good", kind: "review", status: "completed", startedAt: "2026-01-02T00:00:00.000Z", resultBytes: 2 })
  );
  writeFileSync(join(jobsDir, "good.out"), "ok");
  for (const args of [["status"], ["result"], ["cancel"]]) {
    const r = run(args);
    assert.equal(r.status, 0, `${args[0]} exited ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /SyntaxError/);
  }
  assert.deepEqual(JSON.parse(run(["status"]).stdout).map((j) => j.id), ["good"]);
  assert.equal(run(["result"]).stdout.trim(), "ok");
});

test("the default jobs directory is per-user and not world-readable", () => {
  if (process.getuid === undefined) return;
  const home = join(tmpDir, "tmphome");
  mkdirSync(home);
  const r = spawnSync(process.execPath, [COMPANION, "status"], {
    encoding: "utf-8",
    env: { ...process.env, KIRO_PLUGIN_JOBS_DIR: "", TMPDIR: home },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const dir = readdirSync(home).find((d) => d.startsWith("kiro-plugin-cc-jobs-"));
  assert.ok(dir, `no jobs dir created in ${home}: ${readdirSync(home)}`);
  assert.equal(dir, `kiro-plugin-cc-jobs-${process.getuid()}`);
  assert.equal(statSync(join(home, dir)).mode & 0o777, 0o700);
});

test("an existing default jobs directory with loose permissions is tightened", () => {
  if (process.getuid === undefined) return;
  const home = join(tmpDir, "loosehome");
  const dir = join(home, `kiro-plugin-cc-jobs-${process.getuid()}`);
  mkdirSync(dir, { recursive: true, mode: 0o777 });
  const r = spawnSync(process.execPath, [COMPANION, "status"], {
    encoding: "utf-8",
    env: { ...process.env, KIRO_PLUGIN_JOBS_DIR: "", TMPDIR: home },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(statSync(dir).mode & 0o077, 0);
});

test("an explicitly configured jobs directory keeps the permissions it was given", () => {
  if (process.getuid === undefined) return;
  // The operator chose this directory; silently chmod-ing a shared one would be
  // a surprise. Records inside it are still 0600.
  mkdirSync(jobsDir, { recursive: true, mode: 0o755 });
  const r = run(["status"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(statSync(jobsDir).mode & 0o777, 0o755);
});

test("job records themselves are not world-readable", async () => {
  if (process.getuid === undefined) return;
  const kiro = fakeEchoKiro();
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && j.status !== "running");
  assert.equal(statSync(join(jobsDir, `${jobId}.json`)).mode & 0o077, 0);
});

// --- Round-2 regressions ---

test("a job finishes when kiro-cli exits but a descendant still holds its stdout", async () => {
  // "close" would never fire here; only reacting to "exit" finishes the job.
  const kiro = join(tmpDir, "leaky-kiro");
  writeFileSync(kiro, '#!/bin/sh\necho "review body"\nsleep 30 &\nexit 0\n', { mode: 0o755 });
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running", 10_000);
  assert.equal(job.status, "completed");
  assert.match(resultOf(job.id), /review body/);
});

test("a foreground run that exits non-zero still returns what kiro printed", () => {
  const kiro = join(tmpDir, "warn-kiro");
  writeFileSync(kiro, '#!/bin/sh\necho "THE ENTIRE REVIEW BODY"\necho "rate limited" >&2\nexit 1\n', { mode: 0o755 });
  const r = run(["review"], { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /THE ENTIRE REVIEW BODY/);
  assert.match(r.stdout, /rate limited/);
  // And the failure itself is still signalled rather than reading as a success.
  assert.match(r.stdout, /ERROR: kiro-cli did not complete/);
});

test("multi-byte output survives pipe-read boundaries intact", async () => {
  const unit = "あいうえお日本語レビュー結果";
  const repeats = 60_000;
  const kiro = join(tmpDir, "utf8-kiro");
  writeFileSync(
    kiro,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(unit)}.repeat(${repeats}));\n`,
    { mode: 0o755 }
  );
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running", 30_000);
  const body = resultOf(job.id);
  assert.equal(job.status, "completed");
  assert.equal(body.includes("\uFFFD"), false, "output contains replacement characters");
  assert.equal(body.length, unit.length * repeats);
});

test("truncation keeps the part of the overflowing chunk that fits", async () => {
  const kiro = join(tmpDir, "loud-kiro");
  writeFileSync(kiro, `#!${process.execPath}\nprocess.stdout.write("x".repeat(50_000));\n`, { mode: 0o755 });
  const { jobId } = JSON.parse(
    run(["review", "--background"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_OUTPUT_BYTES: "1000" }).stdout
  );
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running", 15_000);
  const body = resultOf(job.id);
  assert.match(body, /\[output truncated at 1000 bytes\]/);
  // Without the slice the whole first chunk was dropped and nothing was kept.
  assert.equal(body.replace(/\n*\[output truncated.*$/s, "").length, 1000);
});

test("a prompt starting with a dash is passed as text, not parsed as an option", () => {
  const kiro = fakeEchoKiro();
  const r = run(["rescue", "--verbose is broken"], { KIRO_CLI_PATH: kiro });
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.at(-2), "ARG:--");
  assert.equal(lines.at(-1), "ARG:--verbose is broken");
});

test("no -- separator is emitted for an ordinary prompt", () => {
  const kiro = fakeEchoKiro();
  const r = run(["rescue", "tests are failing"], { KIRO_CLI_PATH: kiro });
  assert.doesNotMatch(r.stdout, /^ARG:--$/m);
});

test("cancel does not signal a pid that has been recycled by another process", () => {
  mkdirSync(jobsDir, { recursive: true });
  // This test process is alive but is plainly not our runner.
  writeFileSync(
    join(jobsDir, "recycled.json"),
    JSON.stringify({ id: "recycled", kind: "review", status: "running", startedAt: new Date().toISOString(), pid: process.pid })
  );
  const r = run(["cancel", "recycled"]);
  // Reconciliation refuses to call it running, so cancel never reaches the pid.
  assert.match(r.stdout, /already failed; nothing to cancel/);
  // Still here, so nothing was signalled.
  assert.equal(process.kill(process.pid, 0), true);
});

test("flags are recognised when forwarded as their own arguments", () => {
  const kiro = fakeEchoKiro();
  const r = run(["review", "--base", "main", "extra focus"], { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /Compare against main\./);
  assert.match(r.stdout, /Focus on: extra focus/);
});

test("prompt text that mentions a flag is not treated as that flag", () => {
  const kiro = fakeEchoKiro();
  const r = run(["rescue", "add a --wait flag to the CLI"], { KIRO_CLI_PATH: kiro });
  // Splitting arguments on whitespace used to strip the word out of the task.
  assert.match(r.stdout, /^ARG:add a --wait flag to the CLI$/m);
});

test("prompt text that mentions --background does not silently detach", () => {
  const kiro = fakeEchoKiro();
  const r = run(["rescue", "make --background the default"], { KIRO_CLI_PATH: kiro });
  assert.doesNotMatch(r.stdout, /"status":"started"/);
  assert.match(r.stdout, /^ARG:make --background the default$/m);
});

test("a multi-line task description keeps its newlines and indentation", () => {
  const kiro = fakeEchoKiro();
  const task = "line one\n  indented two\nline three";
  const r = run(["rescue", task], { KIRO_CLI_PATH: kiro });
  assert.ok(r.stdout.includes(`ARG:${task}`), `flattened: ${JSON.stringify(r.stdout)}`);
});

test("an empty quoted argument is treated as no arguments", () => {
  const r = run(["status", ""]);
  assert.match(r.stdout, /No Kiro jobs found/);
});

// --- Round-3 regressions ---

test("cancel keeps the output the runner had already captured", async () => {
  const kiro = join(tmpDir, "chatty-kiro");
  writeFileSync(kiro, '#!/bin/sh\necho "partial findings so far"\nsleep 30\n', { mode: 0o755 });
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  // Let kiro emit its first line before pulling the plug.
  await new Promise((r) => setTimeout(r, 600));
  assert.match(run(["cancel", jobId]).stdout, /Cancelled job/);
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running", 10_000);
  assert.equal(job.status, "cancelled");
  // Previously the launcher overwrote the runner's record with a stale snapshot.
  assert.match(run(["result", jobId]).stdout, /partial findings so far/);
});

test("truncation honours a byte budget, not a character count", async () => {
  const kiro = join(tmpDir, "cjk-loud-kiro");
  writeFileSync(kiro, `#!${process.execPath}\nprocess.stdout.write("日".repeat(20_000));\n`, { mode: 0o755 });
  const { jobId } = JSON.parse(
    run(["review", "--background"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_OUTPUT_BYTES: "1000" }).stdout
  );
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running", 15_000);
  const kept = resultOf(job.id).replace(/\n*\[output truncated.*$/s, "");
  // Each character is 3 bytes, so a character-based slice kept 3000 bytes.
  assert.ok(Buffer.byteLength(kept) <= 1000, `kept ${Buffer.byteLength(kept)} bytes`);
  assert.ok(Buffer.byteLength(kept) > 900, `kept only ${Buffer.byteLength(kept)} bytes`);
  assert.equal(kept.includes("�"), false, "sliced mid-character");
});

test("tool trust fails closed for an unrecognised opt-out value", () => {
  const kiro = fakeEchoKiro();
  for (const v of ["off", "FALSE", "disabled", "0", "no"]) {
    const r = run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_TRUST_ALL_TOOLS: v });
    assert.doesNotMatch(r.stdout, /^ARG:--trust-all-tools$/m, `trust survived ${v}`);
  }
  for (const v of ["1", "true", "YES", "on"]) {
    const r = run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_TRUST_ALL_TOOLS: v });
    assert.match(r.stdout, /^ARG:--trust-all-tools$/m, `trust lost for ${v}`);
  }
});

test("a timeout beyond the timer limit is clamped instead of wrapping", async () => {
  const kiro = fakeSlowKiro(2);
  const { jobId } = JSON.parse(
    run(["review", "--background"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_BACKGROUND_TIMEOUT_MS: "2147483648" }).stdout
  );
  // An overflowed delay fired almost immediately and failed the job as a timeout.
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running", 15_000);
  assert.equal(job.status, "completed");
  assert.doesNotMatch(resultOf(job.id), /timed out/);
});

// --- Round-4 regressions ---

test("a runner that cannot be spawned is recorded as failed, not left crashing", async () => {
  const kiro = fakeEchoKiro();
  const r = run(["review", "--background"], {
    KIRO_CLI_PATH: kiro,
    KIRO_PLUGIN_NODE: join(tmpDir, "no-such-node"),
  });
  // The async 'error' event from spawn used to be unhandled: exit 1 and a stack
  // trace, after the JSON had already been printed.
  assert.equal(r.status, 0, `exited ${r.status}: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /ENOENT/);
  // A failure is reported as an error, not as a job the user can go and watch.
  assert.match(r.stdout, /^ERROR: /);
  assert.doesNotMatch(r.stdout, /"status":"started"/);
  const job = await waitForJob((j) => j.status !== "running", 10_000);
  assert.equal(job.status, "failed");
  assert.match(job.note, /(could not start|could not spawn) the Kiro runner/);
});

test("a symlinked default jobs directory is refused", () => {
  if (process.getuid === undefined) return;
  const home = join(tmpDir, "symhome");
  const real = join(tmpDir, "elsewhere");
  mkdirSync(home);
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, join(home, `kiro-plugin-cc-jobs-${process.getuid()}`));
  const r = spawnSync(process.execPath, [COMPANION, "status"], {
    encoding: "utf-8",
    env: { ...process.env, KIRO_PLUGIN_JOBS_DIR: "", TMPDIR: home },
  });
  // statSync followed the link, so the uid check passed and records landed in
  // whatever the link pointed at.
  assert.match(r.stdout, /ERROR: .*symbolic link/);
  assert.equal(readdirSync(real).length, 0);
});

test("cancel kills a kiro-cli that ignores SIGTERM", async () => {
  const marker = join(tmpDir, "stubborn-finished");
  const kiro = join(tmpDir, "stubborn-kiro");
  // Traps SIGTERM and keeps going, the way a build or test grandchild might.
  writeFileSync(
    kiro,
    `#!/bin/sh\ntrap '' TERM\necho started\nsleep 2\ntouch "${marker}"\n`,
    { mode: 0o755 }
  );
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  await new Promise((r) => setTimeout(r, 400));
  assert.match(run(["cancel", jobId]).stdout, /Cancelled job/);
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(existsSync(marker), false, "kiro-cli survived cancellation");
});

test("a finished run is still recorded when its record lost the pid mid-flight", async () => {
  const kiro = fakeSlowKiro(3);
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  // Reconciliation would call this "failed"; the runner must not read it that
  // way and throw away the review it just completed.
  writeFileSync(
    join(jobsDir, `${jobId}.json`),
    JSON.stringify({ id: jobId, kind: "review", status: "running", startedAt: "2026-01-01T00:00:00.000Z" })
  );
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running", 15_000);
  assert.equal(job.status, "completed");
  assert.match(resultOf(job.id), /slow done/);
});

// --- Round-5 regressions ---

test("a job id that escapes the jobs directory is refused", () => {
  const outside = join(tmpDir, "outside.json");
  writeFileSync(
    outside,
    JSON.stringify({ id: "outside", kind: "review", status: "completed", startedAt: "2026-01-01T00:00:00.000Z", resultBytes: 14 })
  );
  writeFileSync(join(tmpDir, "outside.out"), "SECRET CONTENT");
  mkdirSync(jobsDir, { recursive: true });
  for (const id of ["../outside", "../../etc/passwd", "/etc/passwd", "..", "a/b"]) {
    for (const cmd of ["status", "result", "cancel"]) {
      const r = run([cmd, id]);
      assert.equal(r.status, 0, `${cmd} ${id} exited ${r.status}`);
      assert.doesNotMatch(r.stdout, /SECRET CONTENT/, `${cmd} ${id} read outside the jobs dir`);
      assert.match(r.stdout, /No job found with ID/);
    }
  }
});

test("a running record whose pid now belongs to another process reads as failed", () => {
  mkdirSync(jobsDir, { recursive: true });
  // Alive, but plainly not our runner -- the shape of a pre-reboot record.
  writeFileSync(
    join(jobsDir, "stale.json"),
    JSON.stringify({ id: "stale", kind: "review", status: "running", startedAt: new Date().toISOString(), pid: process.pid })
  );
  assert.equal(JSON.parse(run(["status", "stale"]).stdout).status, "failed");
  // And it is no longer picked up as the job to cancel.
  assert.match(run(["cancel"]).stdout, /No running jobs to cancel/);
});

// --- Round-6 regressions ---

test("reading a job by id also clears the symlink guard", () => {
  if (process.getuid === undefined) return;
  const home = join(tmpDir, "symhome2");
  const evil = join(tmpDir, "evil");
  mkdirSync(home);
  mkdirSync(evil, { mode: 0o700 });
  writeFileSync(
    join(evil, "planted.json"),
    JSON.stringify({ id: "planted", kind: "review", status: "completed", startedAt: "2026-01-01T00:00:00.000Z", resultBytes: 13 })
  );
  writeFileSync(join(evil, "planted.out"), "ATTACKER TEXT");
  symlinkSync(evil, join(home, `kiro-plugin-cc-jobs-${process.getuid()}`));
  const env = { ...process.env, KIRO_PLUGIN_JOBS_DIR: "", TMPDIR: home };
  for (const args of [["status"], ["status", "planted"], ["result", "planted"], ["cancel", "planted"]]) {
    const r = spawnSync(process.execPath, [COMPANION, ...args], { encoding: "utf-8", env });
    // The by-id path used to resolve through the link and print the record.
    assert.doesNotMatch(r.stdout, /ATTACKER TEXT/, `${args.join(" ")} read through the link`);
    assert.match(r.stdout, /ERROR: .*symbolic link/);
  }
});

test("a record whose id does not match its filename is ignored, not duplicated", () => {
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(
    join(jobsDir, "somefile.json"),
    JSON.stringify({ id: "ghost", kind: "review", status: "running", startedAt: new Date().toISOString() })
  );
  // saveJob writes <id>.json, so such a record could never be updated in place:
  // cancel reported success while the running record stayed, forever.
  assert.equal(run(["status"]).stdout.trim(), "No Kiro jobs found.");
  assert.match(run(["cancel"]).stdout, /No running jobs to cancel/);
  assert.match(run(["status", "ghost"]).stdout, /No job found with ID: ghost/);
});

test("a legitimate record is still readable by id", async () => {
  const kiro = fakeEchoKiro();
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && j.status !== "running");
  assert.equal(JSON.parse(run(["status", jobId]).stdout).id, jobId);
});

// --- Round-7 regressions ---

test("the foreground timeout is a hard upper bound", () => {
  const kiro = join(tmpDir, "stubborn-fg-kiro");
  writeFileSync(kiro, "#!/bin/sh\ntrap '' TERM\nsleep 10\necho done\n", { mode: 0o755 });
  const started = Date.now();
  const r = run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_TIMEOUT_MS: "1500" });
  const elapsed = Date.now() - started;
  // A plain `timeout` only sends SIGTERM and then keeps waiting.
  // Unbounded it ran the stub's full 10s; the margin is for a loaded runner.
  assert.ok(elapsed < 8000, `waited ${elapsed}ms on a 1500ms budget`);
  assert.match(r.stdout, /ERROR/);
});

test("--base does not consume a following flag as its ref", () => {
  const kiro = fakeEchoKiro();
  const r = run(["review", "--base", "--wait", "fix auth"], { KIRO_CLI_PATH: kiro });
  // "--wait" used to become the git ref.
  assert.match(r.stdout, /Compare against HEAD\./);
  assert.doesNotMatch(r.stdout, /Compare against --/);
  // And it is still honoured as a flag, so it does not leak into the prompt.
  assert.doesNotMatch(r.stdout, /Focus on:.*--wait/);
  assert.match(r.stdout, /Focus on: fix auth/);
});

test("--base followed by --background still detaches, with HEAD as the ref", async () => {
  const kiro = fakeEchoKiro();
  const { jobId } = JSON.parse(run(["review", "--base", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running");
  const body = resultOf(job.id);
  assert.equal(job.status, "completed");
  assert.match(body, /Compare against HEAD\./);
  assert.doesNotMatch(body, /Compare against --/);
});

test("--base at the end of the arguments falls back to HEAD", () => {
  const kiro = fakeEchoKiro();
  const r = run(["review", "--base"], { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /Compare against HEAD\./);
});

test("--base still takes an ordinary ref", () => {
  const kiro = fakeEchoKiro();
  const r = run(["review", "--base", "release/1.x"], { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /Compare against release\/1\.x\./);
});

test("a record with an unparseable startedAt is rejected outright", () => {
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(
    join(jobsDir, "weird.json"),
    JSON.stringify({ id: "weird", kind: "review", status: "running", startedAt: "not-a-date" })
  );
  // It used to reconcile to "running" forever and keep being picked by cancel.
  assert.equal(run(["status"]).stdout.trim(), "No Kiro jobs found.");
  assert.match(run(["status", "weird"]).stdout, /No job found with ID: weird/);
  assert.match(run(["cancel"]).stdout, /No running jobs to cancel/);
});

test("an unwritable job store reports an error and starts nothing", async () => {
  if (process.getuid === undefined || process.getuid() === 0) return; // root ignores the mode
  const marker = join(tmpDir, "should-not-run");
  const kiro = fakeSlowKiro(1, marker);
  mkdirSync(jobsDir, { recursive: true, mode: 0o500 });
  const r = run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /^ERROR: /);
  assert.doesNotMatch(r.stdout, /"status":"started"/);
  // A job that could not be recorded must not be running behind our back.
  await new Promise((res) => setTimeout(res, 2500));
  assert.equal(existsSync(marker), false, "kiro-cli ran for an unrecordable job");
});

// --- Round-8 regressions ---

test("a foreground timeout takes kiro-cli's descendants with it", async () => {
  const marker = join(tmpDir, "descendant-finished");
  const kiro = join(tmpDir, "leaky-stubborn-kiro");
  // Ignores SIGTERM and leaves a descendant behind, the shape of a build step
  // still writing to the repository under --trust-all-tools.
  writeFileSync(
    kiro,
    `#!/bin/sh\ntrap '' TERM\n( sleep 6; touch "${marker}" ) &\nsleep 6\n`,
    { mode: 0o755 }
  );
  const started = Date.now();
  const r = run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_TIMEOUT_MS: "1500" });
  assert.ok(Date.now() - started < 14_000, "the foreground wait was not bounded");
  assert.match(r.stdout, /ERROR/);
  await new Promise((res) => setTimeout(res, 7000));
  assert.equal(existsSync(marker), false, "a descendant outlived the timeout");
});

test("setup's version probe is bounded even against a process that ignores SIGTERM", () => {
  const kiro = join(tmpDir, "hanging-version-kiro");
  writeFileSync(kiro, "#!/bin/sh\ntrap '' TERM\nsleep 45\n", { mode: 0o755 });
  const started = Date.now();
  const r = run(["setup", "--json"], { KIRO_CLI_PATH: kiro });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 40_000, `waited ${elapsed}ms`);
  const info = JSON.parse(r.stdout);
  assert.equal(info.installed, true);
  assert.equal(info.runnable, false);
});

test("status reports large results by size instead of inlining them", async () => {
  const kiro = join(tmpDir, "verbose-kiro");
  writeFileSync(kiro, `#!${process.execPath}\nprocess.stdout.write("y".repeat(40_000));\n`, { mode: 0o755 });
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && j.status !== "running", 15_000);
  const listed = JSON.parse(run(["status"]).stdout);
  assert.equal(listed[0].result, undefined, "status inlined the whole body");
  assert.ok(listed[0].resultBytes >= 40_000);
  // The body is still reachable where it belongs.
  assert.ok(run(["result", jobId]).stdout.length >= 40_000);
});

test("status keeps a short failure explanation inline", () => {
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(
    join(jobsDir, "orphan2.json"),
    JSON.stringify({ id: "orphan2", kind: "rescue", status: "running", startedAt: new Date().toISOString(), pid: 4194304 })
  );
  const job = JSON.parse(run(["status", "orphan2"]).stdout);
  assert.equal(job.status, "failed");
  assert.match(job.note, /without recording a result/);
});

test("a foreground run is recorded, so its output survives the caller", () => {
  const kiro = fakeEchoKiro();
  const out = run(["review"], { KIRO_CLI_PATH: kiro }).stdout;
  assert.match(out, /^ARG:chat$/m);
  const listed = JSON.parse(run(["status"]).stdout);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, "review");
  assert.equal(listed[0].status, "completed");
});

// --- Round-9 regressions ---

test("a fractional env value falls back instead of collapsing to zero", () => {
  const kiro = fakeEchoKiro();
  // Flooring after the "> 0" guard made 0.5 into 0: no output, instant timeout.
  const r = run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_OUTPUT_BYTES: "0.5" });
  assert.match(r.stdout, /^ARG:chat$/m);
  assert.doesNotMatch(r.stdout, /truncated at 0 bytes/);
  const r2 = run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_TIMEOUT_MS: "0.9" });
  assert.match(r2.stdout, /^ARG:chat$/m);
  assert.doesNotMatch(r2.stdout, /timed out after 0ms/);
});

test("the runner rejects a non-numeric timeout instead of treating it as NaN", () => {
  const kiro = fakeEchoKiro();
  const runner = resolve(__dirname, "..", "plugins", "kiro-cli", "scripts", "lib", "kiro-runner.js");
  const r = spawnSync(process.execPath, [runner, "kiro-x-y", "not-a-number", kiro, "chat"], {
    encoding: "utf-8",
    env: { ...process.env, KIRO_PLUGIN_JOBS_DIR: jobsDir },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /timeoutMs must be a positive integer/);
});

test("old terminal records are pruned when a new job starts", async () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  const old = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(
    join(jobsDir, "kiro-old-one.json"),
    JSON.stringify({ id: "kiro-old-one", kind: "review", status: "completed", startedAt: old, finishedAt: old })
  );
  const { jobId } = JSON.parse(
    run(["review", "--background"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_JOB_TTL_MS: "1000" }).stdout
  );
  await waitForJob((j) => j.id === jobId && j.status !== "running");
  const ids = readJobs().map((j) => j.id);
  assert.equal(ids.includes("kiro-old-one"), false, "the stale record survived");
  assert.ok(ids.includes(jobId));
});

test("pruning keeps running jobs and respects the retention cap", async () => {
  const kiro = fakeSlowKiro(6);
  mkdirSync(jobsDir, { recursive: true });
  const live = JSON.parse(run(["rescue", "--background", "long"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === live.jobId && typeof j.pid === "number");
  for (const [n, age] of [["a", 90_000], ["b", 60_000], ["c", 30_000]]) {
    const ts = new Date(Date.now() - age).toISOString();
    writeFileSync(
      join(jobsDir, `kiro-keep-${n}.json`),
      JSON.stringify({ id: `kiro-keep-${n}`, kind: "review", status: "completed", startedAt: ts, finishedAt: ts })
    );
  }
  const echo = fakeEchoKiro("cap-kiro");
  run(["review"], { KIRO_CLI_PATH: echo, KIRO_PLUGIN_MAX_JOBS: "1" });
  const jobs = readJobs();
  // The in-flight job is untouched by pruning.
  assert.ok(jobs.some((j) => j.id === live.jobId && j.status === "running"));
  const terminal = jobs.filter((j) => j.status !== "running");
  // The cap is applied when a job starts, so it holds over the records that
  // existed then -- the newest one -- plus the run that has since finished.
  assert.equal(terminal.length, 2);
  assert.ok(terminal.some((j) => j.id === "kiro-keep-c"), "the newest retained record was pruned");
  assert.equal(terminal.some((j) => j.id === "kiro-keep-a" || j.id === "kiro-keep-b"), false);
  run(["cancel", live.jobId]);
});

test("a background job whose runner is killed reconciles to failed", async () => {
  const kiro = fakeSlowKiro(30);
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  const job = await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  process.kill(-job.pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(JSON.parse(run(["status", jobId]).stdout).status, "failed");
});

test("a foreground wait ends promptly when its runner dies without recording", () => {
  const kiro = fakeEchoKiro();
  // /bin/true stands in for a runner that exits immediately having recorded
  // nothing. A synchronous wait never yielded, so the runner stayed an unreaped
  // zombie, kill(pid, 0) kept succeeding, and this blocked for the full budget.
  const started = Date.now();
  const r = run(["review"], {
    KIRO_CLI_PATH: kiro,
    KIRO_PLUGIN_NODE: "/bin/true",
    KIRO_PLUGIN_TIMEOUT_MS: "1000",
  });
  const elapsed = Date.now() - started;
  // Previously this blocked for the whole budget plus slack, about 11s.
  assert.ok(elapsed < 8000, `waited ${elapsed}ms for a runner that exited at once`);
  assert.match(r.stdout, /ERROR/);
  assert.doesNotMatch(r.stdout, /did not finish within/);
});

// --- Round-10 regressions ---

test("a timeout expiring during the flush grace window does not fail a finished run", async () => {
  const kiro = join(tmpDir, "quick-leaky-kiro");
  // Exits 0 almost at once but leaves a descendant holding stdout, so settle()
  // is delayed by the grace timer -- the window the timeout used to fire in.
  writeFileSync(kiro, '#!/bin/sh\necho "the review"\nsleep 10 &\nexit 0\n', { mode: 0o755 });
  const { jobId } = JSON.parse(
    run(["review", "--background"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_BACKGROUND_TIMEOUT_MS: "900" }).stdout
  );
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running", 10_000);
  const body = resultOf(job.id);
  assert.equal(job.status, "completed");
  assert.doesNotMatch(body, /timed out/);
  assert.match(body, /the review/);
});

test("the same run in the foreground is not reported as a timeout either", () => {
  const kiro = join(tmpDir, "quick-leaky-fg-kiro");
  writeFileSync(kiro, '#!/bin/sh\necho "the review"\nsleep 10 &\nexit 0\n', { mode: 0o755 });
  const r = run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_TIMEOUT_MS: "900" });
  assert.match(r.stdout, /the review/);
  assert.doesNotMatch(r.stdout, /timed out/);
  assert.doesNotMatch(r.stdout, /did not complete/);
});

test("a retention age longer than the timer ceiling is honoured", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  // 30 days: under the old shared clamp this became 24.8 days and pruned it.
  const ts = new Date(Date.now() - 26 * 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(
    join(jobsDir, "kiro-aged-one.json"),
    JSON.stringify({ id: "kiro-aged-one", kind: "review", status: "completed", startedAt: ts, finishedAt: ts })
  );
  run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_JOB_TTL_MS: "2592000000" });
  assert.ok(readJobs().some((j) => j.id === "kiro-aged-one"), "a 26-day-old record was pruned under a 30-day TTL");
});

test("a descendant that redirected its own stdio does not outlive the run", async () => {
  const marker = join(tmpDir, "hidden-descendant");
  const kiro = join(tmpDir, "hidden-desc-kiro");
  // stdio redirected away, so it never delays close() and is invisible to the
  // supervisor: the clean exit path was the one that left it running.
  writeFileSync(
    kiro,
    `#!/bin/sh\necho "the review"\n( sleep 5; touch "${marker}" ) >/dev/null 2>&1 &\nexit 0\n`,
    { mode: 0o755 }
  );
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running", 15_000);
  assert.equal(job.status, "completed");
  assert.match(resultOf(job.id), /the review/);
  await new Promise((r) => setTimeout(r, 6500));
  assert.equal(existsSync(marker), false, "a descendant outlived the supervisor");
});

// --- Round-12 regressions ---

function writeStoredJob(id, { status = "completed", ageMs = 0, body = "" } = {}) {
  const ts = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(
    join(jobsDir, `${id}.json`),
    JSON.stringify({ id, kind: "review", status, startedAt: ts, finishedAt: ts, resultBytes: Buffer.byteLength(body) })
  );
  writeFileSync(join(jobsDir, `${id}.out`), body);
}

test("listing jobs does not pay for the transcripts behind them", () => {
  mkdirSync(jobsDir, { recursive: true });
  const body = "x".repeat(2 * 1024 * 1024);
  for (let i = 0; i < 8; i++) writeStoredJob(`kiro-heavy${i}-aa`, { ageMs: i * 1000, body });
  // Records used to carry the transcript inline, so listing eight of these
  // parsed 16 MB; fifty at the default output cap exhausted the heap outright.
  const r = spawnSync(process.execPath, ["--max-old-space-size=128", COMPANION, "status"], {
    encoding: "utf-8",
    env: { ...process.env, KIRO_PLUGIN_JOBS_DIR: jobsDir },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const listed = JSON.parse(r.stdout);
  assert.equal(listed.length, 8);
  assert.equal(listed[0].result, undefined);
  assert.equal(listed[0].resultBytes, body.length);
});

test("pruning enforces a byte budget, not just a count", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  const body = "y".repeat(600);
  for (const n of ["a", "b", "c", "d"]) writeStoredJob(`kiro-bytes${n}-aa`, { ageMs: 5000, body });
  run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_JOB_BYTES: "1000", KIRO_PLUGIN_MAX_JOBS: "50" });
  const remaining = readdirSync(jobsDir).filter((f) => f.startsWith("kiro-bytes"));
  // Four 600-byte transcripts are inside the count cap and over the byte one.
  assert.ok(remaining.filter((f) => f.endsWith(".out")).length <= 2, `kept ${remaining}`);
});

test("pruning removes records nothing can read, orphaned output and stale temporaries", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(join(jobsDir, "kiro-corrupt-aa.json"), '{"id":"kiro-corrupt-aa","kind":"rev');
  writeFileSync(join(jobsDir, "kiro-mismatch-aa.json"), JSON.stringify({ id: "other", kind: "review", status: "completed", startedAt: new Date().toISOString() }));
  writeFileSync(join(jobsDir, "kiro-orphan-aa.out"), "no record points here");
  writeFileSync(join(jobsDir, ".tmp-999-1.tmp"), "abandoned write");
  const stale = new Date(Date.now() - 60_000);
  for (const f of readdirSync(jobsDir)) utimesSync(join(jobsDir, f), stale, stale);

  run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_JOB_TTL_MS: "1000" });
  const left = readdirSync(jobsDir);
  // pruneJobs used to walk listJobs(), which cannot see any of these.
  for (const gone of ["kiro-corrupt-aa.json", "kiro-mismatch-aa.json", "kiro-orphan-aa.out", ".tmp-999-1.tmp"]) {
    assert.equal(left.includes(gone), false, `${gone} survived pruning`);
  }
});

test("a foreground wait stops when its record is removed underneath it", async () => {
  const kiro = fakeSlowKiro(20);
  mkdirSync(jobsDir, { recursive: true });
  const child = spawn(process.execPath, [COMPANION, "review"], {
    env: { ...process.env, KIRO_PLUGIN_JOBS_DIR: jobsDir, KIRO_CLI_PATH: kiro, KIRO_PLUGIN_TIMEOUT_MS: "15000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (d) => { out += d; });

  const started = Date.now();
  let removed = false;
  while (Date.now() - started < 5000) {
    // Wait for the record to carry a pid: before that the launcher is about to
    // rewrite it, and deleting it would not be a disappearance at all.
    const meta = readJobs().find((j) => typeof j.pid === "number");
    if (meta) {
      unlinkSync(join(jobsDir, `${meta.id}.json`));
      removed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(removed, "never saw a record with a pid to remove");
  const code = await new Promise((resolve) => child.on("close", resolve));
  // A missing record used to read as "still running", so the wait ran out the
  // whole budget and then reported a timeout that had not happened.
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 12_000, "the wait ran to its deadline");
  assert.match(out, /disappeared while waiting/);
});

// --- Round-13 regressions ---

test("pruning leaves files it did not write strictly alone", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  // An operator may point KIRO_PLUGIN_JOBS_DIR at a directory of their own.
  const bystanders = {
    "notes.md": "keep me",
    "build.log": "keep me too",
    "package.json": '{"name":"not-a-job"}',
    "package.out": "nor this",
    "kiro-not-an-id.json": "{}",
    ".tmp-hand-written.tmp": "not our shape",
  };
  for (const [name, body] of Object.entries(bystanders)) writeFileSync(join(jobsDir, name), body);
  const stale = new Date(Date.now() - 120_000);
  for (const name of Object.keys(bystanders)) utimesSync(join(jobsDir, name), stale, stale);

  run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_JOB_TTL_MS: "1000" });

  const left = readdirSync(jobsDir);
  for (const [name, body] of Object.entries(bystanders)) {
    assert.ok(left.includes(name), `${name} was deleted`);
    assert.equal(readFileSync(join(jobsDir, name), "utf-8"), body, `${name} was modified`);
  }
});

test("a young unreadable record keeps its transcript", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(join(jobsDir, "kiro-young-aa.json"), '{"id":"kiro-young-aa","kind":"rev');
  writeFileSync(join(jobsDir, "kiro-young-aa.out"), "recoverable output");
  run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_JOB_TTL_MS: "3600000" });
  // The transcript sweep used to run without an age guard.
  assert.ok(readdirSync(jobsDir).includes("kiro-young-aa.out"), "a young transcript was deleted");
});

test("an old orphaned transcript is still cleaned up", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(join(jobsDir, "kiro-old2-aa.out"), "no record points here");
  const stale = new Date(Date.now() - 120_000);
  utimesSync(join(jobsDir, "kiro-old2-aa.out"), stale, stale);
  run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_JOB_TTL_MS: "1000" });
  assert.equal(readdirSync(jobsDir).includes("kiro-old2-aa.out"), false);
});

// --- Round-14 regressions ---

test("a run that printed nothing says so instead of returning a blank line", async () => {
  const kiro = join(tmpDir, "silent-kiro");
  writeFileSync(kiro, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const fg = run(["review"], { KIRO_CLI_PATH: kiro });
  assert.match(fg.stdout, /No output was recorded/);

  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && j.status !== "running");
  // An empty transcript is stored, so `??` returned it and printed nothing.
  assert.match(run(["result", jobId]).stdout, /No result stored|No output was recorded/);
  assert.match(run(["result"]).stdout, /No result stored|No output was recorded/);
});

// --- Round-15 regressions ---

test("--wait wins over --background, as the commands document", () => {
  const kiro = fakeEchoKiro();
  const r = run(["review", "--wait", "--background"], { KIRO_CLI_PATH: kiro });
  // --wait was parsed nowhere, so asking to wait produced a detached job.
  assert.doesNotMatch(r.stdout, /"status":"started"/);
  assert.match(r.stdout, /^ARG:chat$/m);
});

test("--background alone still detaches", () => {
  const kiro = fakeEchoKiro();
  assert.equal(JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout).status, "started");
});

test("--base with an empty value falls back to HEAD", () => {
  const kiro = fakeEchoKiro();
  const r = run(["review", "--base", ""], { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /Compare against HEAD\./);
  assert.doesNotMatch(r.stdout, /Compare against \./);
});

test("a record with a non-numeric resultBytes is rejected, not summed", () => {
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(
    join(jobsDir, "kiro-badbytes-aa.json"),
    JSON.stringify({ id: "kiro-badbytes-aa", kind: "review", status: "completed", startedAt: new Date().toISOString(), resultBytes: "9999" })
  );
  // Summed as a string it concatenated, inflating the byte accumulator and
  // pruning transcripts that were well inside the budget.
  assert.equal(run(["status"]).stdout.trim(), "No Kiro jobs found.");
});

test("a record with an unparseable finishedAt is rejected, not immune to pruning", () => {
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(
    join(jobsDir, "kiro-badfin-aa.json"),
    JSON.stringify({ id: "kiro-badfin-aa", kind: "review", status: "completed", startedAt: new Date().toISOString(), finishedAt: "whenever" })
  );
  assert.equal(run(["status"]).stdout.trim(), "No Kiro jobs found.");
});

test("a job whose record is removed mid-run is discarded, not refiled", async () => {
  const kiro = fakeSlowKiro(2);
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  unlinkSync(join(jobsDir, `${jobId}.json`));
  await new Promise((r) => setTimeout(r, 4000));
  // It used to be resurrected with kind "task" and a startedAt of now, so a
  // review reappeared as a rescue that had apparently taken no time at all.
  assert.equal(readdirSync(jobsDir).includes(`${jobId}.json`), false);
  assert.equal(run(["status"]).stdout.trim(), "No Kiro jobs found.");
});

test("the PATH lookup for kiro-cli is bounded", () => {
  const bin = join(tmpDir, "slowbin");
  mkdirSync(bin);
  writeFileSync(join(bin, "which"), "#!/bin/sh\ntrap '' TERM\nsleep 40\n", { mode: 0o755 });
  const started = Date.now();
  const r = run(["setup"], { KIRO_CLI_PATH: "", PATH: `${bin}:${process.env.PATH}` });
  const elapsed = Date.now() - started;
  // Unbounded, this blocked for the full 40s before any budget could apply.
  assert.ok(elapsed < 20_000, `waited ${elapsed}ms`);
  assert.match(r.stdout, /not installed/);
});

// --- Round-16 regressions ---

test("free-form text on stdin survives characters no quoting would", () => {
  const kiro = fakeEchoKiro();
  // The exact shape that breaks single-quoting when text is put on a command
  // line: an apostrophe, then a command separator and a substitution.
  const task = "don't break the build; echo INJECTED $(id -u) `hostname`";
  const r = runWithStdin(["rescue"], `${task}\n`, { KIRO_CLI_PATH: kiro });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes(`ARG:${task}`), `mangled: ${JSON.stringify(r.stdout)}`);
  assert.doesNotMatch(r.stdout, /^INJECTED/m);
});

test("stdin text keeps its newlines and indentation", () => {
  const kiro = fakeEchoKiro();
  const task = "first line\n  indented\nlast line";
  const r = runWithStdin(["rescue"], `${task}\n`, { KIRO_CLI_PATH: kiro });
  assert.ok(r.stdout.includes(`ARG:${task}`), `mangled: ${JSON.stringify(r.stdout)}`);
});

test("flags stay in argv while the text comes from stdin", () => {
  const kiro = fakeEchoKiro();
  const r = runWithStdin(["review", "--base", "main"], "the auth paths\n", { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /Compare against main\./);
  assert.match(r.stdout, /Focus on: the auth paths/);
  assert.doesNotMatch(r.stdout, /--args-stdin/);
});

test("--args-stdin with nothing on stdin behaves as no arguments", () => {
  const kiro = fakeEchoKiro();
  const r = runWithStdin(["review"], "", { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /Compare against HEAD\./);
  assert.doesNotMatch(r.stdout, /Focus on:/);
});

test("--background is still honoured alongside stdin text", () => {
  const kiro = fakeEchoKiro();
  const r = runWithStdin(["rescue", "--background"], "go and look\n", { KIRO_CLI_PATH: kiro });
  assert.equal(JSON.parse(r.stdout).status, "started");
});

test("result with no id reports the newest finished run, not the newest success", async () => {
  const echo = fakeEchoKiro();
  const failing = join(tmpDir, "failing2-kiro");
  writeFileSync(failing, '#!/bin/sh\necho "what actually just happened" >&2\nexit 4\n', { mode: 0o755 });
  const ok = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: echo }).stdout);
  await waitForJob((j) => j.id === ok.jobId && j.status !== "running");
  const bad = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: failing }).stdout);
  await waitForJob((j) => j.id === bad.jobId && j.status !== "running");

  const out = run(["result"]).stdout;
  // It used to filter to "completed" and hand back the earlier, successful run.
  assert.match(out, /what actually just happened/);
  assert.ok(out.includes(`[job ${bad.jobId} (rescue) failed]`), `no provenance line: ${out}`);
});

// --- Round-17 regressions ---

test("stdin text is not taken as the --base ref", () => {
  const kiro = fakeEchoKiro();
  const r = runWithStdin(["review", "--base"], "the auth paths\n", { KIRO_CLI_PATH: kiro });
  // Appended plainly, the text became the ref and the focus text vanished.
  assert.match(r.stdout, /Compare against HEAD\./);
  assert.match(r.stdout, /Focus on: the auth paths/);
});

test("stdin text that reads like a flag stays text", () => {
  const kiro = fakeEchoKiro();
  const r = runWithStdin(["rescue"], "--background\n", { KIRO_CLI_PATH: kiro });
  assert.doesNotMatch(r.stdout, /"status":"started"/);
  assert.match(r.stdout, /^ARG:--background$/m);
});

test("--args-stdin against a terminal is refused rather than hanging", () => {
  const kiro = fakeEchoKiro();
  // No `input`, and stdin inherited from a non-tty here, so drive the tty branch
  // by checking the closed-descriptor path instead: either way it must not hang.
  const r = spawnSync(process.execPath, [COMPANION, "rescue", "--args-stdin"], {
    encoding: "utf-8",
    input: "",
    timeout: 15_000,
    env: { ...process.env, KIRO_PLUGIN_JOBS_DIR: jobsDir, KIRO_CLI_PATH: kiro },
  });
  assert.equal(r.signal, null, "the command hung");
  assert.equal(r.status, 0);
});

test("result with no id reports the run that finished last, not the one that started last", () => {
  mkdirSync(jobsDir, { recursive: true });
  // A long job started first and finished last; a short one started later.
  writeFileSync(join(jobsDir, "kiro-long-aa.json"), JSON.stringify({
    id: "kiro-long-aa", kind: "review", status: "completed",
    startedAt: "2026-01-01T10:00:00.000Z", finishedAt: "2026-01-01T10:30:00.000Z", resultBytes: 7,
  }));
  writeFileSync(join(jobsDir, "kiro-long-aa.out"), "LATEST!");
  writeFileSync(join(jobsDir, "kiro-short-aa.json"), JSON.stringify({
    id: "kiro-short-aa", kind: "review", status: "completed",
    startedAt: "2026-01-01T10:05:00.000Z", finishedAt: "2026-01-01T10:06:00.000Z", resultBytes: 6,
  }));
  writeFileSync(join(jobsDir, "kiro-short-aa.out"), "stale!");
  // listJobs sorts by startedAt, which picked the short job.
  assert.equal(run(["result"]).stdout.trim(), "LATEST!");
});

test("cancel never signals a live pid that is not one of our runners", () => {
  mkdirSync(jobsDir, { recursive: true });
  // pid 1 is alive and is emphatically not a kiro runner. The identity guard
  // must stop this before any signal is considered -- as root it would
  // otherwise be delivered to init.
  writeFileSync(join(jobsDir, "kiro-foreign-aa.json"), JSON.stringify({
    id: "kiro-foreign-aa", kind: "review", status: "running",
    startedAt: new Date().toISOString(), pid: 1,
  }));
  const r = run(["cancel", "kiro-foreign-aa"]);
  assert.doesNotMatch(r.stdout, /^Cancelled job/);
  assert.match(r.stdout, /already failed|Could not cancel/);
  assert.equal(process.kill(1, 0), true, "pid 1 was signalled");
});

// --- Round-18 regressions ---

test("a stale running record does not shadow later results", async () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  // A crashed runner from an hour ago. reconcile() used to stamp it with
  // finishedAt = now, so it looked like the newest finished job on every read
  // and hid every genuine result for the whole retention window.
  writeFileSync(join(jobsDir, "kiro-crashed-aa.json"), JSON.stringify({
    id: "kiro-crashed-aa", kind: "review", status: "running",
    startedAt: new Date(Date.now() - 3_600_000).toISOString(), pid: 4194304,
  }));
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && j.status !== "running");
  const out = run(["result"]).stdout;
  assert.match(out, /ARG:chat/);
  assert.doesNotMatch(out, /exited without recording a result/);
});

test("cancel with no id picks a job it can actually cancel", async () => {
  const kiro = fakeSlowKiro(20);
  const { jobId } = JSON.parse(run(["rescue", "--background", "real work"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  // A launcher record that never recorded a pid: newest, and uncancellable.
  writeFileSync(join(jobsDir, "kiro-zzstillborn-aa.json"), JSON.stringify({
    id: "kiro-zzstillborn-aa", kind: "review", status: "running",
    startedAt: new Date(Date.now() + 1000).toISOString(),
  }));
  const r = run(["cancel"]);
  assert.match(r.stdout, new RegExp(`Cancelled job ${jobId}`));
  assert.doesNotMatch(r.stdout, /still starting/);
});

test("result by id marks a run that did not complete", async () => {
  const failing = join(tmpDir, "failing3-kiro");
  writeFileSync(failing, '#!/bin/sh\necho "partial work"\nexit 5\n', { mode: 0o755 });
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: failing }).stdout);
  await waitForJob((j) => j.id === jobId && j.status !== "running");
  const out = run(["result", jobId]).stdout;
  assert.match(out, /partial work/);
  // Presented bare, an aborted review read as a finished one.
  assert.ok(out.includes(`[job ${jobId} (review) failed]`), `no provenance line: ${out}`);
});

test("--base=<ref> is honoured, not folded into the focus text", () => {
  const kiro = fakeEchoKiro();
  const r = run(["review", "--base=release/2.x"], { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /Compare against release\/2\.x\./);
  assert.doesNotMatch(r.stdout, /Focus on:/);
});

test("--base= with no value falls back to HEAD", () => {
  const kiro = fakeEchoKiro();
  const r = run(["review", "--base="], { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /Compare against HEAD\./);
  assert.doesNotMatch(r.stdout, /Focus on:/);
});

test("an overflowing numeric setting is clamped rather than ignored", () => {
  const kiro = fakeEchoKiro();
  // 1e400 parses to Infinity: it used to revert to the default silently.
  const r = run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_TIMEOUT_MS: "1e400" });
  assert.match(r.stdout, /^ARG:chat$/m);
});

// --- Round-19 regressions ---

test("rescue with no task refuses instead of inventing one", () => {
  const kiro = fakeEchoKiro();
  for (const args of [["rescue"], ["rescue", "--background"], ["rescue", "--wait"]]) {
    const r = run(args, { KIRO_CLI_PATH: kiro });
    // It used to run "Investigate and fix the current issue." under
    // --trust-all-tools -- a fabricated task against a writable repository.
    assert.match(r.stdout, /ERROR: no task was given/);
    assert.doesNotMatch(r.stdout, /Investigate and fix the current issue/);
    assert.doesNotMatch(r.stdout, /^ARG:chat$/m);
  }
});

test("rescue with an empty stdin body refuses too", () => {
  const kiro = fakeEchoKiro();
  const r = runWithStdin(["rescue"], "", { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /ERROR: no task was given/);
  assert.doesNotMatch(r.stdout, /Investigate and fix the current issue/);
});

test("review with no arguments still works", () => {
  const kiro = fakeEchoKiro();
  const r = run(["review"], { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /Compare against HEAD\./);
});

test("stdin input is not lost when the writer stalls part way through", () => {
  const kiro = fakeEchoKiro();
  const runner = spawn(process.execPath, [COMPANION, "rescue", "--args-stdin"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, KIRO_PLUGIN_JOBS_DIR: jobsDir, KIRO_CLI_PATH: kiro },
  });
  let out = "";
  runner.stdout.setEncoding("utf-8");
  runner.stdout.on("data", (d) => { out += d; });
  // Three chunks, each gap inside the per-stall budget but adding up to more
  // than it. The budget used to cover the whole read, so everything already
  // received was discarded once the total passed it.
  runner.stdin.write("one ");
  return new Promise((resolve, reject) => {
    setTimeout(() => runner.stdin.write("two "), 3000);
    setTimeout(() => {
      runner.stdin.write("three\n");
      runner.stdin.end();
    }, 6000);
    runner.on("close", () => {
      try {
        assert.match(out, /ARG:one two three/);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

test("a legacy shared jobs directory is tightened and drained", () => {
  if (process.getuid === undefined) return;
  const home = join(tmpDir, "legacyhome");
  const legacy = join(home, "kiro-plugin-cc-jobs");
  mkdirSync(legacy, { recursive: true, mode: 0o755 });
  writeFileSync(join(legacy, "kiro-oldrec-aa.json"), "{}", { mode: 0o644 });
  writeFileSync(join(legacy, "keep-me.txt"), "not ours");
  const stale = new Date(Date.now() - 120_000);
  for (const f of readdirSync(legacy)) utimesSync(join(legacy, f), stale, stale);

  const kiro = fakeEchoKiro();
  const r = spawnSync(process.execPath, [COMPANION, "review"], {
    encoding: "utf-8",
    env: { ...process.env, KIRO_PLUGIN_JOBS_DIR: "", TMPDIR: home, KIRO_CLI_PATH: kiro, KIRO_PLUGIN_JOB_TTL_MS: "1000" },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // The suffix change orphaned any pre-upgrade store at the old shared path,
  // world-readable and unreachable.
  assert.equal(statSync(legacy).mode & 0o077, 0, "still world-readable");
  assert.equal(readdirSync(legacy).includes("kiro-oldrec-aa.json"), false, "record not drained");
  assert.ok(readdirSync(legacy).includes("keep-me.txt"), "a foreign file was deleted");
});

// --- Round-20 regressions ---

function writeLegacyJob(id, body, extra = {}) {
  writeFileSync(
    join(jobsDir, `${id}.json`),
    JSON.stringify({
      id, kind: "review", status: "completed",
      startedAt: "2026-01-02T00:00:00.000Z", finishedAt: "2026-01-02T00:00:00.000Z",
      result: body, ...extra,
    })
  );
}

test("a pre-split record's transcript is still readable", () => {
  mkdirSync(jobsDir, { recursive: true });
  writeLegacyJob("kiro-legacy-aa", "the old review body");
  // The commands read <id>.out only, so this reported "No result stored." with
  // the body sitting in the metadata.
  assert.match(run(["result", "kiro-legacy-aa"]).stdout, /the old review body/);
  assert.match(run(["result"]).stdout, /the old review body/);
});

test("status does not re-emit a pre-split inline transcript", () => {
  mkdirSync(jobsDir, { recursive: true });
  const body = "z".repeat(60_000);
  writeLegacyJob("kiro-legacyfat-aa", body);
  const listed = JSON.parse(run(["status"]).stdout);
  assert.equal(listed.length, 1);
  // Returned verbatim, the record put the whole transcript back into `status`.
  assert.equal(listed[0].result, undefined);
  assert.equal(listed[0].resultBytes, body.length);
});

test("a pre-split transcript counts against the pruning byte budget", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  for (const n of ["a", "b", "c"]) writeLegacyJob(`kiro-legacyb${n}-aa`, "q".repeat(600));
  // resultBytes was absent, so the budget counted these megabyte-scale bodies
  // as zero and never pruned them.
  run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_JOB_BYTES: "1000", KIRO_PLUGIN_MAX_JOBS: "50" });
  const left = readdirSync(jobsDir).filter((f) => f.startsWith("kiro-legacyb"));
  assert.ok(left.length <= 2, `kept ${left}`);
});

test("setup does not let kiro-cli's stderr into its own output", () => {
  const noisy = join(tmpDir, "noisy-version-kiro");
  writeFileSync(
    noisy,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "warning: config is stale" >&2; echo "kiro-cli 3.2.1"; exit 0; fi\nexit 0\n',
    { mode: 0o755 }
  );
  const r = run(["setup", "--json"], { KIRO_CLI_PATH: noisy });
  // execFileSync echoes child stderr to ours unless stdio is given, which made
  // the combined output unparseable.
  assert.equal(r.stderr, "", `stderr leaked: ${r.stderr}`);
  const info = JSON.parse(r.stdout);
  assert.equal(info.version, "kiro-cli 3.2.1");
  assert.equal(info.runnable, true);
});

// --- Round-21 regressions ---

test("the byte budget never deletes the run that just finished", async () => {
  const kiro = join(tmpDir, "chatty-big-kiro");
  writeFileSync(kiro, `#!${process.execPath}\nprocess.stdout.write("w".repeat(5000));\n`, { mode: 0o755 });
  const { jobId } = JSON.parse(
    run(["review", "--background"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_JOB_BYTES: "1000" }).stdout
  );
  await waitForJob((j) => j.id === jobId && j.status !== "running", 15_000);
  assert.match(run(["result", jobId]).stdout, /w{100}/);

  // pruneJobs runs at every job start, and the byte pass had no floor: a
  // transcript larger than the budget was deleted before anyone read it.
  const echo = fakeEchoKiro("nudge-kiro");
  run(["review"], { KIRO_CLI_PATH: echo, KIRO_PLUGIN_MAX_JOB_BYTES: "1000" });
  const out = run(["result", jobId]).stdout;
  assert.doesNotMatch(out, /No job found|No result stored/);
  assert.match(out, /w{100}/);
});

test("the byte budget still trims older runs", async () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  for (const [n, age] of [["a", 9000], ["b", 6000], ["c", 3000]]) {
    const ts = new Date(Date.now() - age).toISOString();
    writeFileSync(join(jobsDir, `kiro-trim${n}-aa.json`), JSON.stringify({
      id: `kiro-trim${n}-aa`, kind: "review", status: "completed",
      startedAt: ts, finishedAt: ts, resultBytes: 900,
    }));
    writeFileSync(join(jobsDir, `kiro-trim${n}-aa.out`), "q".repeat(900));
  }
  run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_JOB_BYTES: "1000", KIRO_PLUGIN_MAX_JOBS: "50" });
  const left = readdirSync(jobsDir).filter((f) => f.startsWith("kiro-trim") && f.endsWith(".json"));
  assert.ok(left.length < 3, `nothing was trimmed: ${left}`);
  assert.ok(left.includes("kiro-trimc-aa.json"), "the newest was trimmed instead of the oldest");
});

test("cancel refuses a pid that the probe reports as another process", () => {
  mkdirSync(jobsDir, { recursive: true });
  // A live pid that is plainly not this job's runner. reconcile normally
  // catches it; cancel must reach the same verdict on its own.
  writeFileSync(join(jobsDir, "kiro-recyc2-aa.json"), JSON.stringify({
    id: "kiro-recyc2-aa", kind: "review", status: "running",
    startedAt: new Date().toISOString(), pid: 1,
  }));
  const r = run(["cancel", "kiro-recyc2-aa"]);
  assert.doesNotMatch(r.stdout, /^Cancelled job/);
  assert.equal(process.kill(1, 0), true, "pid 1 was signalled");
});

// --- Round-22 regressions ---

test("one oversized transcript does not doom older records that fit", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  const sizes = [["big", 3000, 1000], ["small1", 6000, 2], ["small2", 9000, 2]];
  for (const [n, age, bytes] of sizes) {
    const ts = new Date(Date.now() - age).toISOString();
    writeFileSync(join(jobsDir, `kiro-floor${n}-aa.json`), JSON.stringify({
      id: `kiro-floor${n}-aa`, kind: "review", status: "completed",
      startedAt: ts, finishedAt: ts, resultBytes: bytes,
    }));
    writeFileSync(join(jobsDir, `kiro-floor${n}-aa.out`), "p".repeat(bytes));
  }
  run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_JOB_BYTES: "100", KIRO_PLUGIN_MAX_JOBS: "50" });
  const left = readdirSync(jobsDir).filter((f) => f.startsWith("kiro-floor") && f.endsWith(".json"));
  // Charging the exempt newest record wiped out both two-byte transcripts.
  assert.ok(left.includes("kiro-floorbig-aa.json"), "the newest was pruned");
  assert.equal(left.length, 3, `older records that fit were pruned: ${left}`);
});

test("the focus text does not run into the rest of the prompt", () => {
  const kiro = fakeEchoKiro();
  const r = run(["review", "the auth paths"], { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /Focus on: the auth paths\. Provide a thorough/);
  assert.doesNotMatch(r.stdout, /the auth paths Provide/);
});

test("focus text that already ends in a full stop is not doubled", () => {
  const kiro = fakeEchoKiro();
  const r = run(["review", "check the auth paths."], { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /Focus on: check the auth paths\. Provide/);
  assert.doesNotMatch(r.stdout, /paths\.\./);
});

// --- Round-23 regressions ---

function writeFinishedJob(id, { startedAt, finishedAt, bytes, omitBytes = false }) {
  const meta = { id, kind: "review", status: "completed", startedAt, finishedAt };
  if (!omitBytes) meta.resultBytes = bytes;
  writeFileSync(join(jobsDir, `${id}.json`), JSON.stringify(meta));
  writeFileSync(join(jobsDir, `${id}.out`), "r".repeat(bytes));
}

test("pruning keeps the run that finished last, not the one that started last", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  // A long job started first and finished last; a short one started later.
  writeFinishedJob("kiro-plong-aa", {
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:10:00.000Z", bytes: 1000,
  });
  writeFinishedJob("kiro-pshort-aa", {
    startedAt: "2026-01-01T00:05:00.000Z", finishedAt: "2026-01-01T00:06:00.000Z", bytes: 5,
  });
  run(["review"], {
    KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_JOBS: "2",
    KIRO_PLUGIN_MAX_JOB_BYTES: "100", KIRO_PLUGIN_JOB_TTL_MS: "864000000000",
  });
  const left = readdirSync(jobsDir);
  // Ordering by startedAt deleted the newer result and kept the stale one.
  assert.ok(left.includes("kiro-plong-aa.json"), "the last-finished run was pruned");
});

test("a transcript with no recorded size is still charged to the byte budget", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  writeFinishedJob("kiro-nosize1-aa", {
    startedAt: "2026-01-01T00:02:00.000Z", finishedAt: "2026-01-01T00:02:00.000Z", bytes: 5,
  });
  for (const [n, min] of [["2", "01"], ["3", "00"]]) {
    writeFinishedJob(`kiro-nosize${n}-aa`, {
      startedAt: `2026-01-01T00:${min}:00.000Z`, finishedAt: `2026-01-01T00:${min}:00.000Z`,
      bytes: 15_000, omitBytes: true,
    });
  }
  run(["review"], {
    KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_JOB_BYTES: "100",
    KIRO_PLUGIN_MAX_JOBS: "50", KIRO_PLUGIN_JOB_TTL_MS: "864000000000",
  });
  const left = readdirSync(jobsDir).filter((f) => f.startsWith("kiro-nosize") && f.endsWith(".out"));
  // Charged zero, 30 KB of orphaned transcripts sat inside a 100-byte budget.
  assert.ok(left.length < 3, `nothing was charged: ${left}`);
});

test("an unsafe --base ref is refused rather than passed through", () => {
  const kiro = fakeEchoKiro();
  for (const ref of ["main; echo pwned", "$(id -u)", "a'b", "back`tick`"]) {
    for (const args of [["review", "--base", ref], ["review", `--base=${ref}`]]) {
      const r = run(args, { KIRO_CLI_PATH: kiro });
      assert.match(r.stdout, /not a usable git ref/, `accepted ${ref}`);
      assert.doesNotMatch(r.stdout, /^ARG:chat$/m);
    }
  }
});

test("ordinary git refs are still accepted", () => {
  const kiro = fakeEchoKiro();
  for (const ref of ["main", "origin/main", "v1.2.3", "HEAD~3", "HEAD^", "release/2.x"]) {
    const r = run(["review", "--base", ref], { KIRO_CLI_PATH: kiro });
    assert.ok(r.stdout.includes(`Compare against ${ref}.`), `rejected ${ref}: ${r.stdout}`);
  }
});

test("a question in the focus text keeps its own punctuation", () => {
  const kiro = fakeEchoKiro();
  const r = run(["review", "why is auth slow?"], { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /Focus on: why is auth slow\? Provide/);
  assert.doesNotMatch(r.stdout, /slow\?\./);
});

// --- Round-24 regressions ---

// The "unknown" pid verdict -- no readable /proc and no ps -- cannot be reached
// on Linux, so the staleness bound that now applies to it has no test here. The
// "foreign" verdict it sits beside is covered above ("a running record whose pid
// now belongs to another process reads as failed").

test("a run that printed nothing gets the same wording from every path", async () => {
  const kiro = join(tmpDir, "silent2-kiro");
  writeFileSync(kiro, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && j.status !== "running");
  assert.match(run(["result", jobId]).stdout, /No output was recorded/);
  assert.match(run(["result"]).stdout, /No output was recorded/);
  assert.match(run(["review"], { KIRO_CLI_PATH: kiro }).stdout, /No output was recorded/);
});

// --- Round-25 regressions ---

test("a job records the budget it was started with", async () => {
  const kiro = fakeEchoKiro();
  const { jobId } = JSON.parse(
    run(["review", "--background"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_BACKGROUND_TIMEOUT_MS: "123456" }).stdout
  );
  const job = await waitForJob((j) => j.id === jobId);
  // Without this, the staleness bound had to guess from the current settings,
  // which is wrong whenever the two budgets differ or either is reconfigured.
  assert.equal(job.timeoutMs, 123456);

  const fg = run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_TIMEOUT_MS: "234567" });
  assert.match(fg.stdout, /ARG:chat/);
  const foreground = readJobs().find((j) => j.timeoutMs === 234567);
  assert.ok(foreground, `foreground budget not recorded: ${JSON.stringify(readJobs())}`);
});

test("a record with a bad timeoutMs is rejected", () => {
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(join(jobsDir, "kiro-badto-aa.json"), JSON.stringify({
    id: "kiro-badto-aa", kind: "review", status: "completed",
    startedAt: new Date().toISOString(), timeoutMs: "soon",
  }));
  assert.equal(run(["status"]).stdout.trim(), "No Kiro jobs found.");
});

test("the byte budget keeps each older record that still fits", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  // Documents the retention model: the newest run is kept unconditionally and
  // uncharged, then older ones newest-first while each still fits. Accumulating
  // the bytes of records it had already dropped overstated the total, which then
  // made the unreachable-file sweep fire on a store well inside its budget.
  const rows = [["new", 1000, 900], ["mid", 3000, 5000], ["old", 6000, 5]];
  for (const [n, age, bytes] of rows) {
    const ts = new Date(Date.now() - age).toISOString();
    writeFileSync(join(jobsDir, `kiro-cum${n}-aa.json`), JSON.stringify({
      id: `kiro-cum${n}-aa`, kind: "review", status: "completed",
      startedAt: ts, finishedAt: ts, resultBytes: bytes,
    }));
    writeFileSync(join(jobsDir, `kiro-cum${n}-aa.out`), "s".repeat(bytes));
  }
  run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_JOB_BYTES: "1000", KIRO_PLUGIN_MAX_JOBS: "50" });
  const left = readdirSync(jobsDir).filter((f) => f.startsWith("kiro-cum") && f.endsWith(".json")).sort();
  // "mid" is 5000 bytes against a 1000-byte budget, so it goes; "old" is 5
  // bytes and still fits, so it stays.
  assert.deepEqual(left, ["kiro-cumnew-aa.json", "kiro-cumold-aa.json"]);
});

// --- Round-26 regressions ---

test("a pre-upgrade store is carried into the current one, not left to rot", () => {
  if (process.getuid === undefined) return;
  const home = join(tmpDir, "migratehome");
  const legacy = join(home, "kiro-plugin-cc-jobs");
  mkdirSync(legacy, { recursive: true, mode: 0o755 });
  // main's exact record shape: transcript inline, no per-uid directory.
  writeFileSync(join(legacy, "kiro-oldjob-aa.json"), JSON.stringify({
    id: "kiro-oldjob-aa", kind: "review", status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.000Z",
    result: "the review from before the upgrade",
  }), { mode: 0o644 });
  writeFileSync(join(legacy, "keep-me.txt"), "not ours");

  const env = { ...process.env, KIRO_PLUGIN_JOBS_DIR: "", TMPDIR: home };
  // A read-only command is enough: it used to take a job start, and even then
  // only aged the records out where nothing could read them.
  const listed = JSON.parse(spawnSync(process.execPath, [COMPANION, "status"], { encoding: "utf-8", env }).stdout);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "kiro-oldjob-aa");
  const body = spawnSync(process.execPath, [COMPANION, "result", "kiro-oldjob-aa"], { encoding: "utf-8", env }).stdout;
  assert.match(body, /the review from before the upgrade/);
  // And the world-readable directory is gone, its foreign file left behind.
  assert.ok(readdirSync(legacy).includes("keep-me.txt"), "a foreign file was removed");
  assert.equal(readdirSync(legacy).includes("kiro-oldjob-aa.json"), false, "record not migrated");
  assert.equal(statSync(legacy).mode & 0o077, 0, "still world-readable");
});

test("a cancelled run keeps the output it had already produced", async () => {
  const kiro = join(tmpDir, "verbose-cancel-kiro");
  writeFileSync(kiro, '#!/bin/sh\necho "a full review, as it happens"\nsleep 30\n', { mode: 0o755 });
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  await new Promise((r) => setTimeout(r, 600));
  run(["cancel", jobId]);
  await new Promise((r) => setTimeout(r, 2500));
  // When cancel won the settle race the runner exited without writing the
  // transcript at all, so result reported that nothing had been produced.
  const out = run(["result", jobId]).stdout;
  assert.match(out, /a full review, as it happens/);
  assert.doesNotMatch(out, /No output was recorded/);
});

test("setup reports the Bash timeout a foreground run needs", () => {
  const kiro = fakeEchoKiro();
  const info = JSON.parse(run(["setup", "--json"], { KIRO_CLI_PATH: kiro }).stdout);
  assert.equal(info.foregroundTimeoutMs, 300_000);
  assert.ok(info.recommendedBashTimeoutMs > info.foregroundTimeoutMs);

  const raised = JSON.parse(
    run(["setup", "--json"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_TIMEOUT_MS: "900000" }).stdout
  );
  // The commands used to hard-code 320000, which a raised budget outlives.
  assert.equal(raised.foregroundTimeoutMs, 900_000);
  assert.ok(raised.recommendedBashTimeoutMs > 900_000);
  assert.match(run(["setup"], { KIRO_CLI_PATH: kiro }).stdout, /allow \d+ms for a foreground run/);
});

// --- Round-27 regressions ---

test("an over-long task is reported, not left as a phantom running job", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  // Past MAX_ARG_STRLEN, so spawn throws E2BIG synchronously -- reachable now
  // that free-form text arrives on stdin rather than a command line.
  const huge = "x".repeat(300 * 1024);
  const r = runWithStdin(["rescue"], `${huge}\n`, { KIRO_CLI_PATH: kiro });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /ERROR: could not start the Kiro runner/);
  assert.match(r.stdout, /too long to pass to a command/);
  // The pre-spawn record used to sit "running" with no pid for the whole
  // pidless window, and cancel refused it as "still starting".
  const jobs = readJobs();
  assert.equal(jobs.filter((j) => j.status === "running").length, 0, JSON.stringify(jobs));
  assert.match(run(["cancel"]).stdout, /No running jobs to cancel/);
});

test("an ordinary task is unaffected by the size guard", () => {
  const kiro = fakeEchoKiro();
  const r = runWithStdin(["rescue"], "a perfectly normal task\n", { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /^ARG:a perfectly normal task$/m);
});

// --- Round-28 regressions ---

test("a verified live runner is trusted however long it has been running", () => {
  mkdirSync(jobsDir, { recursive: true });
  // The extra argv entries put "kiro-runner" and the job id in the process's
  // command line, so the identity probe returns "ours".
  const runnerish = spawn(
    process.execPath,
    ["-e", "setTimeout(()=>{}, 60000)", "kiro-runner.js", "kiro-wedged-aa"],
    { stdio: "ignore" },
  );
  try {
    writeFileSync(join(jobsDir, "kiro-wedged-aa.json"), JSON.stringify({
      id: "kiro-wedged-aa", kind: "review", status: "running",
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      pid: runnerish.pid, timeoutMs: 1000,
    }));
    const cmdline = readFileSync(`/proc/${runnerish.pid}/cmdline`, "utf-8");
    assert.ok(cmdline.includes("kiro-runner") && cmdline.includes("kiro-wedged-aa"),
      `probe would not read this as ours: ${JSON.stringify(cmdline)}`);
    // Judging a verified supervisor by wall clock reported "failed" while it was
    // still working, and pruning then deleted the record out from under it.
    assert.equal(JSON.parse(run(["status", "kiro-wedged-aa"]).stdout).status, "running");
    const kiro = fakeEchoKiro();
    run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_JOB_TTL_MS: "1000", KIRO_PLUGIN_MAX_JOBS: "1" });
    assert.ok(readdirSync(jobsDir).includes("kiro-wedged-aa.json"), "a live job's record was pruned");
  } finally {
    try { runnerish.kill("SIGKILL"); } catch { /* already gone */ }
  }
});

test("a run inside its recorded budget is still running", async () => {
  const kiro = fakeSlowKiro(4);
  const { jobId } = JSON.parse(
    run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_BACKGROUND_TIMEOUT_MS: "60000" }).stdout
  );
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  assert.equal(JSON.parse(run(["status", jobId]).stdout).status, "running");
  run(["cancel", jobId]);
});

test("migrated records are not left world-readable", () => {
  if (process.getuid === undefined) return;
  const home = join(tmpDir, "modehome");
  const legacy = join(home, "kiro-plugin-cc-jobs");
  mkdirSync(legacy, { recursive: true, mode: 0o755 });
  writeFileSync(join(legacy, "kiro-modejob-aa.json"), JSON.stringify({
    id: "kiro-modejob-aa", kind: "review", status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.000Z",
  }), { mode: 0o644 });
  writeFileSync(join(legacy, "kiro-modejob-aa.out"), "private source", { mode: 0o644 });

  const env = { ...process.env, KIRO_PLUGIN_JOBS_DIR: "", TMPDIR: home };
  const r = spawnSync(process.execPath, [COMPANION, "status"], { encoding: "utf-8", env });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const moved = join(home, `kiro-plugin-cc-jobs-${process.getuid()}`);
  // rename preserves the mode, and pre-0.1.0 records were written without one.
  for (const f of ["kiro-modejob-aa.json", "kiro-modejob-aa.out"]) {
    assert.equal(statSync(join(moved, f)).mode & 0o077, 0, `${f} is still group/world readable`);
  }
});

// --- Round-29 regressions ---

test("a runner that cannot start kiro-cli at all still records and sweeps", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  // A directory is not executable, and spawn throws synchronously for EACCES-
  // adjacent errnos. Unguarded at the top level that escaped module evaluation,
  // leaving no record behind.
  const notABinary = join(tmpDir, "a-directory");
  mkdirSync(notABinary);
  const r = run(["review", "--background"], { KIRO_CLI_PATH: notABinary });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const { jobId } = JSON.parse(r.stdout);
  const deadline = Date.now() + 10_000;
  let job;
  while (Date.now() < deadline) {
    job = readJobs().find((j) => j.id === jobId);
    if (job && job.status !== "running") break;
  }
  assert.ok(job, "no record written");
  assert.equal(job.status, "failed");
});

// Dropping awaitResult's "had we seen it" flag is not a behaviour change on any
// reachable path: startRunner writes the record before the wait begins, so it is
// always present on the first poll. Removal part way through is covered by "a
// foreground wait stops when its record is removed underneath it".

// --- Round-30 regressions ---

test("unreachable bytes do not sit inside the byte budget", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  // Orphaned transcripts (a runner killed between its two writes) and an
  // abandoned write. All young, so the age guard keeps them; all unreadable, so
  // they were charged nothing and held far more than the budget for seven days.
  for (const n of ["o1", "o2", "o3"]) {
    writeFileSync(join(jobsDir, `kiro-orph${n}-aa.out`), "o".repeat(200 * 1024));
  }
  // Its pid is not alive, so this is an abandoned write rather than one in flight.
  writeFileSync(join(jobsDir, ".tmp-4194304-7.tmp"), "t".repeat(200 * 1024));
  run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_JOB_BYTES: "1000", KIRO_PLUGIN_JOB_TTL_MS: "3600000" });
  const left = readdirSync(jobsDir).filter((f) => f.startsWith("kiro-orph") || f.startsWith(".tmp-"));
  assert.deepEqual(left, [], `unreachable files survived: ${left}`);
});

test("young unreachable files are kept while the store fits", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(join(jobsDir, "kiro-orphsmall-aa.out"), "o".repeat(10));
  run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_JOB_TTL_MS: "3600000" });
  // The age grace exists so a record that merely failed to parse this time does
  // not lose its output; it should still apply when there is room.
  assert.ok(readdirSync(jobsDir).includes("kiro-orphsmall-aa.out"));
});

test("a recycled pid is reported as such, not as a crashed runner", () => {
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(join(jobsDir, "kiro-recyc3-aa.json"), JSON.stringify({
    id: "kiro-recyc3-aa", kind: "review", status: "running",
    startedAt: new Date().toISOString(), pid: 1,
  }));
  const job = JSON.parse(run(["status", "kiro-recyc3-aa"]).stdout);
  assert.equal(job.status, "failed");
  assert.match(job.note, /now belongs to another process/);
  assert.doesNotMatch(job.note, /killed or crashed/);
});

test("cancel escalates to SIGKILL when SIGTERM is ignored", async () => {
  const marker = join(tmpDir, "escalate-finished");
  const kiro = join(tmpDir, "term-proof-kiro");
  // Both the fake kiro and, in effect, the whole group ignore SIGTERM.
  writeFileSync(kiro, `#!/bin/sh\ntrap '' TERM\necho started\nsleep 8\ntouch "${marker}"\n`, { mode: 0o755 });
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  await new Promise((r) => setTimeout(r, 400));
  const out = run(["cancel", jobId]).stdout;
  // It used to write "cancelled" and report success without checking.
  assert.match(out, /Cancelled job/);
  await new Promise((r) => setTimeout(r, 9000));
  assert.equal(existsSync(marker), false, "kiro-cli survived the cancellation");
  assert.equal(JSON.parse(run(["status", jobId]).stdout).status, "cancelled");
});

// --- Round-31 regressions ---

test("a temporary belonging to a live process is left alone", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  // Named for this process, which is very much alive: an in-flight writeAtomic.
  const inflight = join(jobsDir, `.tmp-${process.pid}-1.tmp`);
  writeFileSync(inflight, "x".repeat(200 * 1024));
  run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_JOB_BYTES: "1000", KIRO_PLUGIN_JOB_TTL_MS: "3600000" });
  // Removing it makes the writer's rename fail with ENOENT, and its finished
  // run is then reported as never having recorded a result.
  assert.ok(existsSync(inflight), "an in-flight temporary was deleted");
});

test("a temporary whose writer is gone is removed whatever its age", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  const abandoned = join(jobsDir, ".tmp-4194304-3.tmp");
  writeFileSync(abandoned, "x");
  run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_JOB_TTL_MS: "3600000" });
  assert.equal(existsSync(abandoned), false, "an abandoned temporary survived");
});

// The overlap this guards against -- another process's writeAtomic losing its
// rename to a prune -- is covered deterministically by "a temporary belonging to
// a live process is left alone" above; driving it through two real runs instead
// just races the byte budget against the job that is meant to survive.

test("--base followed by an unknown flag is refused, not folded into the prompt", () => {
  const kiro = fakeEchoKiro();
  const r = run(["review", "--base", "-x"], { KIRO_CLI_PATH: kiro });
  // It used to keep HEAD silently and let "-x" reappear as focus text, while
  // --base=-x rejected the very same input.
  assert.match(r.stdout, /not a usable git ref/);
  assert.doesNotMatch(r.stdout, /Focus on: -x/);
});

test("--base followed by a known flag still works", () => {
  const kiro = fakeEchoKiro();
  const r = run(["review", "--base", "--wait", "the auth paths"], { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /Compare against HEAD\./);
  assert.match(r.stdout, /Focus on: the auth paths\./);
});

// --- Round-32 regressions ---

test("an abandoned temporary with a recycled pid is still removed", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  // pid 1 is always alive, so liveness alone protected this for ever -- which
  // is the state of any abandoned temporary after a reboot on a platform where
  // tmpdir persists. It was also no longer charged against the byte budget.
  const stale = join(jobsDir, ".tmp-1-1.tmp");
  writeFileSync(stale, "z".repeat(500 * 1024));
  const old = new Date(Date.now() - 30 * 60_000);
  utimesSync(stale, old, old);
  run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_JOB_BYTES: "1000", KIRO_PLUGIN_JOB_TTL_MS: "1" });
  assert.equal(existsSync(stale), false, "an abandoned temporary survived");
});

test("a young unreachable transcript survives while the store is inside budget", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  for (const [n, age, bytes] of [["a", 9000, 10], ["b", 6000, 600], ["c", 3000, 600]]) {
    const ts = new Date(Date.now() - age).toISOString();
    writeFileSync(join(jobsDir, `kiro-acct${n}-aa.json`), JSON.stringify({
      id: `kiro-acct${n}-aa`, kind: "review", status: "completed",
      startedAt: ts, finishedAt: ts, resultBytes: bytes,
    }));
    writeFileSync(join(jobsDir, `kiro-acct${n}-aa.out`), "a".repeat(bytes));
  }
  writeFileSync(join(jobsDir, "kiro-younorph-aa.out"), "keep me");
  // 1210 bytes of transcripts are retained (600 exempt + 600 + 10), so the
  // budget has to exceed that for the store to be genuinely inside it.
  run(["review"], {
    KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_JOB_BYTES: "4000",
    KIRO_PLUGIN_MAX_JOBS: "50", KIRO_PLUGIN_JOB_TTL_MS: "3600000",
  });
  // Counting the bytes of records it had already dropped made the sweep fire
  // even here, taking the young orphan with it.
  assert.ok(readdirSync(jobsDir).includes("kiro-younorph-aa.out"), "a young orphan was swept prematurely");
  assert.equal(readdirSync(jobsDir).filter((f) => f.startsWith("kiro-acct") && f.endsWith(".json")).length, 3);
});

// --- Round-33 regressions ---

test("a run that exits just before the deadline is not recorded as a timeout", async () => {
  const kiro = join(tmpDir, "just-in-time-kiro");
  // Finishes successfully well inside a very short budget; the timer fires
  // during the same tick range, and timedOut used to outrank the exit code.
  writeFileSync(kiro, '#!/bin/sh\necho "the review"\nexit 0\n', { mode: 0o755 });
  for (const budget of ["1", "2", "5", "10", "25"]) {
    const { jobId } = JSON.parse(
      run(["review", "--background"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_BACKGROUND_TIMEOUT_MS: budget }).stdout
    );
    const job = await waitForJob((j) => j.id === jobId && j.status !== "running", 15_000);
    if (job.status !== "completed") continue; // a genuine timeout at 1ms is fair
    assert.doesNotMatch(resultOf(job.id), /timed out/, `budget ${budget} mislabelled a clean exit`);
  }
});

test("a run killed by the timeout is still recorded as one", async () => {
  const kiro = fakeSlowKiro(10);
  const { jobId } = JSON.parse(
    run(["review", "--background"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_BACKGROUND_TIMEOUT_MS: "800" }).stdout
  );
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running", 15_000);
  assert.equal(job.status, "failed");
  assert.match(resultOf(job.id), /timed out after 800ms/);
});

// The pid-write failure path has no test: it needs the store to break between
// the launcher's first write and its second, which cannot be arranged from
// outside the process. Its two siblings -- a spawn that throws and a spawn with
// no pid -- are covered above.

// --- Round-34 regressions ---

test("a brace-expansion ref is refused", () => {
  const kiro = fakeEchoKiro();
  // Quoted these are inert, but the ref set exists so that a quoting slip is
  // not exploitable: unquoted, v1.{0..2} becomes three words.
  for (const ref of ["v1.{0..2}", "HEAD@{1..3}", "{main,other}"]) {
    const r = run(["review", "--base", ref], { KIRO_CLI_PATH: kiro });
    assert.match(r.stdout, /not a usable git ref/, `accepted ${ref}`);
  }
});

test("a run whose output could not be read in full is not reported as complete", async () => {
  // A stream error is not reachable from a test, so this pins the decision the
  // code makes instead: streamErrors is what turns a clean exit into a failure.
  const src = readFileSync(new URL("../src/kiro-runner.ts", import.meta.url), "utf-8");
  assert.match(src, /code === 0 && streamErrors\.length > 0/);
  assert.match(src, /could not be read in full/);
});

test("a killed runner is still noticed at once, not after its budget", async () => {
  const kiro = fakeSlowKiro(30);
  const { jobId } = JSON.parse(
    run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_BACKGROUND_TIMEOUT_MS: "600000" }).stdout
  );
  const job = await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  process.kill(-job.pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 500));
  // In a container the killed runner is reparented and often left unreaped, so
  // its command line reads empty; treating that as merely "unknown" would have
  // kept the job "running" for the whole ten-minute budget.
  assert.equal(JSON.parse(run(["status", jobId]).stdout).status, "failed");
});

// --- Round-35 regressions ---

test("cancelling a job whose runner is an unreaped zombie records it", async () => {
  const kiro = fakeSlowKiro(30);
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  const job = await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  // Kill it out from under cancel, leaving the reparented runner unreaped --
  // the usual state in a container, where isPidAlive still says yes.
  process.kill(-job.pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 400));
  const raw = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), "utf-8"));
  assert.equal(raw.status, "running", "the record should still read running on disk");

  const out = run(["cancel", jobId]).stdout;
  // The "dead" verdict was handled in reconciliation but not here, so this said
  // the runner was still alive, or that signalling had been refused.
  assert.doesNotMatch(out, /still alive after/);
  assert.doesNotMatch(out, /was refused/);
  assert.match(out, /Cancelled job|already failed/);
});

test("cancel with no id handles a zombie runner the same way", async () => {
  const kiro = fakeSlowKiro(30);
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  const job = await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  process.kill(-job.pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 400));
  const out = run(["cancel"]).stdout;
  assert.doesNotMatch(out, /still alive after/);
  assert.doesNotMatch(out, /was refused/);
});

test("cancelling a live runner still works after the rewrite", async () => {
  const marker = join(tmpDir, "rewrite-finished");
  const kiro = fakeSlowKiro(3, marker);
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  assert.match(run(["cancel", jobId]).stdout, new RegExp(`Cancelled job ${jobId}`));
  await new Promise((r) => setTimeout(r, 4500));
  assert.equal(existsSync(marker), false, "kiro-cli survived the cancellation");
  assert.equal(JSON.parse(run(["status", jobId]).stdout).status, "cancelled");
});

// --- Round-36 regressions ---

test("the newest run is retained unconditionally, and not charged", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  // A single transcript larger than the whole budget. The floor keeps it, and
  // charging it would exhaust the budget on its own -- which is why the
  // unreachable-file sweep is judged on charged bytes rather than on everything
  // that happens to be on disk.
  const ts = new Date(Date.now() - 3000).toISOString();
  writeFileSync(join(jobsDir, "kiro-bigone-aa.json"), JSON.stringify({
    id: "kiro-bigone-aa", kind: "review", status: "completed",
    startedAt: ts, finishedAt: ts, resultBytes: 100 * 1024,
  }));
  writeFileSync(join(jobsDir, "kiro-bigone-aa.out"), "b".repeat(100 * 1024));
  writeFileSync(join(jobsDir, "kiro-orphtiny-aa.out"), "o".repeat(10));
  run(["review"], {
    KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_JOB_BYTES: "64000",
    KIRO_PLUGIN_MAX_JOBS: "50", KIRO_PLUGIN_JOB_TTL_MS: "3600000",
  });
  assert.ok(readdirSync(jobsDir).includes("kiro-bigone-aa.json"), "the newest run was pruned");
  assert.ok(readdirSync(jobsDir).includes("kiro-bigone-aa.out"), "the newest transcript was pruned");
  // Nothing charged is over budget, so the age grace still protects this.
  assert.ok(readdirSync(jobsDir).includes("kiro-orphtiny-aa.out"), "a young orphan was swept");
});

test("unreachable bytes go once the charged total is over budget", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  for (const n of ["p", "q", "r"]) {
    writeFileSync(join(jobsDir, `kiro-orphbig${n}-aa.out`), "o".repeat(20 * 1024));
  }
  run(["review"], {
    KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_JOB_BYTES: "1000",
    KIRO_PLUGIN_MAX_JOBS: "50", KIRO_PLUGIN_JOB_TTL_MS: "3600000",
  });
  const orphans = readdirSync(jobsDir).filter((f) => f.startsWith("kiro-orphbig"));
  assert.deepEqual(orphans, [], `unreachable bytes retained over budget: ${orphans}`);
});

test("a cancelled run's status advertises the output it kept", async () => {
  const kiro = join(tmpDir, "verbose-cancel2-kiro");
  writeFileSync(kiro, '#!/bin/sh\necho "the partial review"\nsleep 30\n', { mode: 0o755 });
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  await new Promise((r) => setTimeout(r, 600));
  run(["cancel", jobId]);
  await new Promise((r) => setTimeout(r, 2500));
  const job = JSON.parse(run(["status", jobId]).stdout);
  const body = run(["result", jobId]).stdout;
  assert.match(body, /the partial review/);
  // status said there was no output while result returned the whole transcript.
  assert.ok(job.resultBytes > 0, `status advertises no output: ${JSON.stringify(job)}`);
});

// --- Round-37 regressions ---

test("a prompt mentioning another job's id does not impersonate it", async () => {
  const kiro = fakeSlowKiro(20);
  // A real runner for one job, whose prompt names a second job.
  const other = "kiro-victim-aa";
  const { jobId } = JSON.parse(
    run(["rescue", "--background", `look at job ${other} too`], { KIRO_CLI_PATH: kiro }).stdout
  );
  const mine = await waitForJob((j) => j.id === jobId && typeof j.pid === "number");

  // A record for the second job pointing at the first job's runner: the shape a
  // recycled pid produces. Matching the id anywhere in the command line read
  // this as "ours", so the job stayed running for ever and cancel would have
  // signalled the other job's process group.
  writeFileSync(join(jobsDir, `${other}.json`), JSON.stringify({
    id: other, kind: "review", status: "running",
    startedAt: new Date().toISOString(), pid: mine.pid,
  }));
  assert.equal(JSON.parse(run(["status", other]).stdout).status, "failed");
  const out = run(["cancel", other]).stdout;
  assert.doesNotMatch(out, new RegExp(`^Cancelled job ${other}`));
  // And the real job is untouched.
  assert.equal(JSON.parse(run(["status", jobId]).stdout).status, "running");
  run(["cancel", jobId]);
});

test("a genuine runner is still recognised", async () => {
  const kiro = fakeSlowKiro(20);
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  assert.equal(JSON.parse(run(["status", jobId]).stdout).status, "running");
  assert.match(run(["cancel", jobId]).stdout, new RegExp(`Cancelled job ${jobId}`));
});

// --- Round-38 regressions ---

test("a future-dated record does not stay running", () => {
  mkdirSync(jobsDir, { recursive: true });
  // A clock stepped backwards mid-flight. Every elapsed-time test used to come
  // out true, so the record stayed "running": uncancellable and unprunable.
  const ahead = new Date(Date.now() + 3_600_000).toISOString();
  writeFileSync(join(jobsDir, "kiro-future-aa.json"), JSON.stringify({
    id: "kiro-future-aa", kind: "review", status: "running", startedAt: ahead,
  }));
  writeFileSync(join(jobsDir, "kiro-futpid-aa.json"), JSON.stringify({
    id: "kiro-futpid-aa", kind: "review", status: "running", startedAt: ahead, pid: 4194304,
  }));
  assert.equal(JSON.parse(run(["status", "kiro-future-aa"]).stdout).status, "failed");
  assert.equal(JSON.parse(run(["status", "kiro-futpid-aa"]).stdout).status, "failed");
  assert.match(run(["cancel"]).stdout, /No running jobs to cancel/);
});

test("a record a moment ahead of the clock is tolerated", () => {
  mkdirSync(jobsDir, { recursive: true });
  // Ordinary jitter between two machines, or between two reads.
  const barelyAhead = new Date(Date.now() + 2000).toISOString();
  writeFileSync(join(jobsDir, "kiro-jitter-aa.json"), JSON.stringify({
    id: "kiro-jitter-aa", kind: "review", status: "running", startedAt: barelyAhead,
  }));
  assert.equal(JSON.parse(run(["status", "kiro-jitter-aa"]).stdout).status, "running");
});

test("setup says what turning tool trust off actually does", () => {
  const kiro = fakeEchoKiro();
  const off = run(["setup"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_TRUST_ALL_TOOLS: "0" }).stdout;
  // The plugin always passes --no-interactive, so there is nobody to ask: this
  // is a read-only Kiro, not a prompting one.
  assert.match(off, /analyse but not change/);
  const on = run(["setup"], { KIRO_CLI_PATH: kiro }).stdout;
  assert.match(on, /all tools trusted/);
});

// --- Round-39 regressions ---

test("an unreadable record is not reported as a missing one", () => {
  mkdirSync(jobsDir, { recursive: true });
  // A directory where the record should be: readFileSync raises EISDIR, which
  // is emphatically not "this job does not exist".
  mkdirSync(join(jobsDir, "kiro-unread-aa.json"));
  const r = run(["status", "kiro-unread-aa"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /^ERROR: /);
  assert.doesNotMatch(r.stdout, /No job found/);
});

test("one unreadable record does not break a listing", () => {
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(join(jobsDir, "kiro-unread2-aa.json"));
  const ts = new Date().toISOString();
  writeFileSync(join(jobsDir, "kiro-fine-aa.json"), JSON.stringify({
    id: "kiro-fine-aa", kind: "review", status: "completed", startedAt: ts, finishedAt: ts,
  }));
  const listed = JSON.parse(run(["status"]).stdout);
  assert.deepEqual(listed.map((j) => j.id), ["kiro-fine-aa"]);
  assert.match(run(["cancel"]).stdout, /No running jobs to cancel/);
});

test("a job start is not derailed by an unreadable neighbour", async () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(join(jobsDir, "kiro-unread3-aa.json"));
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running");
  assert.equal(job.status, "completed");
});

// --- Round-40 regressions ---

test("a no-output record does not spend the byte-budget exemption", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  // The real latest review...
  const older = new Date(Date.now() - 6000).toISOString();
  writeFileSync(join(jobsDir, "kiro-realrev-aa.json"), JSON.stringify({
    id: "kiro-realrev-aa", kind: "review", status: "completed",
    startedAt: older, finishedAt: older, resultBytes: 4096,
  }));
  writeFileSync(join(jobsDir, "kiro-realrev-aa.out"), "r".repeat(4096));
  // ...followed by a job that produced nothing, which took the exemption with it
  // and left the review charged on its own against a smaller budget.
  const newer = new Date(Date.now() - 3000).toISOString();
  writeFileSync(join(jobsDir, "kiro-nooutput-aa.json"), JSON.stringify({
    id: "kiro-nooutput-aa", kind: "rescue", status: "failed",
    startedAt: newer, finishedAt: newer, note: "ERROR: could not start the Kiro runner",
  }));

  run(["review"], {
    KIRO_CLI_PATH: kiro, KIRO_PLUGIN_MAX_JOB_BYTES: "2048",
    KIRO_PLUGIN_MAX_JOBS: "50", KIRO_PLUGIN_JOB_TTL_MS: "3600000",
  });
  const left = readdirSync(jobsDir);
  assert.ok(left.includes("kiro-realrev-aa.out"), "the latest transcript was deleted");
  assert.ok(left.includes("kiro-realrev-aa.json"), "the latest record was deleted");
});

test("cancel does not call a finished run's signal a refusal", async () => {
  const kiro = fakeEchoKiro();
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  const job = await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  // Let it finish, then hand cancel a record that still says running with a pid
  // that is gone: the shape of a runner that finished between the check and the
  // signal, where both kills return ESRCH.
  await waitForJob((j) => j.id === jobId && j.status !== "running");
  writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
    id: jobId, kind: "rescue", status: "running",
    startedAt: new Date().toISOString(), pid: job.pid,
  }));
  const out = run(["cancel", jobId]).stdout;
  assert.doesNotMatch(out, /was refused/);
  assert.doesNotMatch(out, /it is still running/);
});

test("cancel reports an unreadable record rather than a bare errno", async () => {
  const kiro = fakeSlowKiro(20);
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  // Replace the record with a directory: readFileSync then raises EISDIR on
  // every read cancel makes after the signal has already landed.
  const meta = join(jobsDir, `${jobId}.json`);
  const saved = readFileSync(meta, "utf-8");
  unlinkSync(meta);
  mkdirSync(meta);
  const r = run(["cancel", jobId]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /^EISDIR/);
  rmSync(meta, { recursive: true, force: true });
  writeFileSync(meta, saved);
  run(["cancel", jobId]);
});

// --- Round-41 regressions ---

test("an unreadable transcript is reported, not called an absence of output", async () => {
  const kiro = fakeEchoKiro();
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running");
  assert.ok(job.resultBytes > 0);
  // Replace the transcript with a directory: readFileSync raises EISDIR, which
  // used to be swallowed and reported as though nothing had been produced.
  const out = join(jobsDir, `${jobId}.out`);
  unlinkSync(out);
  mkdirSync(out);
  for (const args of [["result", jobId], ["result"]]) {
    const r = run(args);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /No output was recorded/);
    assert.match(r.stdout, /could not be read/);
    assert.match(r.stdout, /bytes of output/);
  }
});

test("a genuinely empty run still says there was no output", async () => {
  const kiro = join(tmpDir, "silent3-kiro");
  writeFileSync(kiro, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && j.status !== "running");
  assert.match(run(["result", jobId]).stdout, /No output was recorded/);
});

test("a foreground wait rides out an unreadable record", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  // A neighbouring unreadable entry must not reach the wait at all, and the
  // reconciling read is now inside the same guard as the raw one.
  mkdirSync(join(jobsDir, "kiro-unread4-aa.json"));
  const r = run(["review"], { KIRO_CLI_PATH: kiro });
  assert.match(r.stdout, /^ARG:chat$/m);
  assert.doesNotMatch(r.stdout, /EISDIR/);
});

// --- Round-42 regressions ---

test("cancel does not claim a cancellation it did not perform", async () => {
  const kiro = fakeEchoKiro();
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  const job = await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  await waitForJob((j) => j.id === jobId && j.status !== "running");
  // A record that still reads running, pointing at a pid that has gone: the
  // pre-check reports it finished and nothing is signalled.
  writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
    id: jobId, kind: "rescue", status: "running",
    startedAt: new Date().toISOString(), pid: job.pid,
  }));
  const out = run(["cancel", jobId]).stdout;
  assert.doesNotMatch(out, /^Cancelled job/, `claimed a cancellation: ${out}`);
  assert.match(out, /had already stopped|already failed/);
});

test("migration leaves a job that is still running where it is", () => {
  if (process.getuid === undefined) return;
  const home = join(tmpDir, "busyhome");
  const legacy = join(home, "kiro-plugin-cc-jobs");
  mkdirSync(legacy, { recursive: true, mode: 0o755 });
  // A background job spanning the upgrade: its runner is this very process, so
  // the record reconciles to running and its files are in use.
  const runnerish = spawn(
    process.execPath,
    ["-e", "setTimeout(()=>{}, 30000)", "kiro-runner.js", "kiro-spanning-aa"],
    { stdio: "ignore" },
  );
  try {
    writeFileSync(join(legacy, "kiro-spanning-aa.json"), JSON.stringify({
      id: "kiro-spanning-aa", kind: "review", status: "running",
      startedAt: new Date().toISOString(), pid: runnerish.pid,
    }));
    writeFileSync(join(legacy, "kiro-spanning-aa.out"), "partial");
    // And a finished one, which should move.
    const ts = new Date().toISOString();
    writeFileSync(join(legacy, "kiro-donejob-aa.json"), JSON.stringify({
      id: "kiro-donejob-aa", kind: "review", status: "completed", startedAt: ts, finishedAt: ts,
    }));
    // An in-flight temporary of a live writer must survive too.
    writeFileSync(join(legacy, `.tmp-${process.pid}-9.tmp`), "half-written");

    const env = { ...process.env, KIRO_PLUGIN_JOBS_DIR: "", TMPDIR: home };
    const r = spawnSync(process.execPath, [COMPANION, "status"], { encoding: "utf-8", env });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    const left = readdirSync(legacy);
    // Moving a running job's record stranded it as permanently "running" while
    // its real result was orphaned at the old path.
    assert.ok(left.includes("kiro-spanning-aa.json"), "a running job's record was moved");
    assert.ok(left.includes("kiro-spanning-aa.out"), "a running job's transcript was moved");
    assert.ok(left.includes(`.tmp-${process.pid}-9.tmp`), "an in-flight temporary was deleted");
    assert.equal(left.includes("kiro-donejob-aa.json"), false, "a finished record was not migrated");
  } finally {
    try { runnerish.kill("SIGKILL"); } catch { /* already gone */ }
  }
});

test("running the runner directly does not sweep the caller's process group", async () => {
  const runner = resolve(__dirname, "..", "plugins", "kiro-cli", "scripts", "lib", "kiro-runner.js");
  const marker = join(tmpDir, "caller-survived");
  const harness = join(tmpDir, "harness.mjs");
  // The harness runs in its own process group, so a regression here kills only
  // it. It invokes the runner *not* detached -- so the runner does not lead the
  // group -- with a kiro path that cannot be spawned, forcing a sweep.
  writeFileSync(harness, `
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
spawnSync(process.execPath, [${JSON.stringify(runner)}, "kiro-direct-aa", "5000", ${JSON.stringify(join(tmpDir, "not-a-binary-at-all"))}, "chat"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(marker)}, "yes");
`);
  const child = spawn(process.execPath, [harness], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, KIRO_PLUGIN_JOBS_DIR: jobsDir },
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(existsSync(marker), true, `the caller was killed by the sweep (exit ${code})`);
});
