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
  return readdirSync(jobsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(jobsDir, f), "utf-8")));
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
