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
  // Remove first and only then wait: now that the sweep above actually kills
  // runners on every platform, the common case needs no wait at all, and paying
  // one unconditionally cost the suite 150ms per test.
  for (let attempt = 0; attempt < 6; attempt++) {
    rmSync(tmpDir, { recursive: true, force: true });
    if (!existsSync(tmpDir)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
});

function safeReadJobs() {
  try {
    return readJobs();
  } catch {
    return [];
  }
}

/**
 * A process's command line, from /proc where it exists and from ps otherwise.
 * The code under test has this fallback; the harness needs it too, or on macOS
 * every runner identity check here silently answers "no" -- which is how the
 * afterEach sweep below stopped killing anything and the suite began leaving
 * detached runners and their temp dirs behind.
 */
function cmdlineOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").filter(Boolean).join(" ");
  } catch {
    /* not Linux, or the process is gone */
  }
  const ps = spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf-8" });
  return ps.stdout ?? "";
}

function isRunnerPid(pid) {
  if (pid === process.pid) return false;
  return cmdlineOf(pid).includes("kiro-runner");
}

/**
 * Tool trust is on by default in the product, and off by default here. Nothing
 * in these tests depends on the flag except the three that assert it, and
 * keeping it out of the runner's argv costs a machine running an
 * endpoint-security agent that inspects argv about 1.7 seconds per spawn --
 * a Defender-for-Endpoint exec hook reacts to the literal "--trust-all-tools".
 * Pass `KIRO_PLUGIN_TRUST_ALL_TOOLS: null` to get the product default back.
 */
const TRUST_OFF = { KIRO_PLUGIN_TRUST_ALL_TOOLS: "0" };

function childEnv(env) {
  const merged = { ...process.env, KIRO_PLUGIN_JOBS_DIR: jobsDir, ...TRUST_OFF, ...env };
  // An explicit null means "leave it unset", which is not something spawnSync's
  // env can express on its own.
  for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
  return merged;
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: "utf-8",
    env: childEnv(env),
  });
}

/** Drives the --args-stdin route the slash commands use for free-form text. */
function runWithStdin(args, stdin, env = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args, "--args-stdin"], {
    encoding: "utf-8",
    input: stdin,
    env: childEnv(env),
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

test("--background returns immediately instead of waiting for kiro-cli", () => {
  // Long enough that returning before it finishes cannot be a coincidence. The
  // margin used to be two seconds, which a loaded machine running the rest of
  // the suite alongside this one could eat on process startup alone.
  const kiro = fakeSlowKiro(30);
  const started = Date.now();
  const r = run(["review", "--background"], { KIRO_CLI_PATH: kiro });
  const elapsed = Date.now() - started;
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).status, "started");
  assert.ok(elapsed < 10_000, `expected an immediate return, took ${elapsed}ms`);
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

test("a foreground timeout takes kiro-cli's descendants with it", async () => {
  const marker = join(tmpDir, "descendant-finished");
  const kiro = join(tmpDir, "leaky-stubborn-kiro");
  // Ignores SIGTERM and leaves a descendant behind, the shape of a build step
  // still writing to the repository under --trust-all-tools.
  writeFileSync(
    kiro,
    `#!/bin/sh\ntrap '' TERM\n( sleep 4; touch "${marker}" ) &\nsleep 4\n`,
    { mode: 0o755 }
  );
  const started = Date.now();
  const r = run(["review"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_TIMEOUT_MS: "800" });
  assert.ok(Date.now() - started < 12_000, "the foreground wait was not bounded");
  assert.match(r.stdout, /ERROR/);
  await new Promise((res) => setTimeout(res, 4500));
  assert.equal(existsSync(marker), false, "a descendant outlived the timeout");
});

test("setup's version probe is bounded even against a process that ignores SIGTERM", () => {
  const kiro = join(tmpDir, "hanging-version-kiro");
  writeFileSync(kiro, "#!/bin/sh\ntrap '' TERM\nsleep 20\n", { mode: 0o755 });
  const started = Date.now();
  // The bound itself is what is under test, not its default value: waiting out
  // the shipped 30s to watch it work cost the suite more than every other
  // process test put together.
  const r = run(["setup", "--json"], { KIRO_CLI_PATH: kiro, KIRO_PLUGIN_VERSION_PROBE_MS: "800" });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 8_000, `waited ${elapsed}ms`);
  const info = JSON.parse(r.stdout);
  assert.equal(info.installed, true);
  assert.equal(info.runnable, false);
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

test("a descendant that redirected its own stdio does not outlive the run", async () => {
  const marker = join(tmpDir, "hidden-descendant");
  const kiro = join(tmpDir, "hidden-desc-kiro");
  // stdio redirected away, so it never delays close() and is invisible to the
  // supervisor: the clean exit path was the one that left it running.
  writeFileSync(
    kiro,
    `#!/bin/sh\necho "the review"\n( sleep 3; touch "${marker}" ) >/dev/null 2>&1 &\nexit 0\n`,
    { mode: 0o755 }
  );
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running", 15_000);
  assert.equal(job.status, "completed");
  assert.match(resultOf(job.id), /the review/);
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(existsSync(marker), false, "a descendant outlived the supervisor");
});

function writeStoredJob(id, { status = "completed", ageMs = 0, body = "" } = {}) {
  const ts = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(
    join(jobsDir, `${id}.json`),
    JSON.stringify({ id, kind: "review", status, startedAt: ts, finishedAt: ts, resultBytes: Buffer.byteLength(body) })
  );
  writeFileSync(join(jobsDir, `${id}.out`), body);
}

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

test("a job whose record is removed mid-run is discarded, not refiled", async () => {
  const kiro = fakeSlowKiro(1);
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  unlinkSync(join(jobsDir, `${jobId}.json`));
  await new Promise((r) => setTimeout(r, 2500));
  // It used to be resurrected with kind "task" and a startedAt of now, so a
  // review reappeared as a rescue that had apparently taken no time at all.
  assert.equal(readdirSync(jobsDir).includes(`${jobId}.json`), false);
  assert.equal(run(["status"]).stdout.trim(), "No Kiro jobs found.");
});

test("the PATH lookup for kiro-cli is bounded", () => {
  const bin = join(tmpDir, "slowbin");
  mkdirSync(bin);
  writeFileSync(join(bin, "which"), "#!/bin/sh\ntrap '' TERM\nsleep 20\n", { mode: 0o755 });
  const started = Date.now();
  const r = run(["setup"], { KIRO_CLI_PATH: "", PATH: `${bin}:${process.env.PATH}`, KIRO_PLUGIN_PATH_LOOKUP_MS: "800" });
  const elapsed = Date.now() - started;
  // Unbounded, this blocked for as long as the hung lookup took, before any
  // configured budget could apply.
  assert.ok(elapsed < 8_000, `waited ${elapsed}ms`);
  assert.match(r.stdout, /not installed/);
});

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

test("cancel never signals a live pid that is not one of our runners", () => {
  mkdirSync(jobsDir, { recursive: true });
  // A process of our own, in its own group, that is emphatically not a kiro
  // runner. The identity guard has to stop this before any signal is
  // considered; if it did not, the group kill would land here and this process
  // would be gone. (pid 1 would be the obvious stand-in, but kill(1, 0) is
  // EPERM for anyone but root, so the check itself could not be made.)
  const bystander = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], {
    stdio: "ignore",
    detached: true,
  });
  try {
    writeFileSync(join(jobsDir, "kiro-foreign-aa.json"), JSON.stringify({
      id: "kiro-foreign-aa", kind: "review", status: "running",
      startedAt: new Date().toISOString(), pid: bystander.pid,
    }));
    const r = run(["cancel", "kiro-foreign-aa"]);
    assert.doesNotMatch(r.stdout, /^Cancelled job/);
    assert.match(r.stdout, /already failed|Could not cancel/);
    assert.equal(process.kill(bystander.pid, 0), true, "an unrelated process was signalled");
  } finally {
    try { process.kill(-bystander.pid, "SIGKILL"); } catch { /* already gone */ }
  }
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

test("stdin input is not lost when the writer stalls part way through", () => {
  const kiro = fakeEchoKiro();
  const runner = spawn(process.execPath, [COMPANION, "rescue", "--args-stdin"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv({ KIRO_CLI_PATH: kiro, KIRO_PLUGIN_STDIN_STALL_MS: "1000" }),
  });
  let out = "";
  runner.stdout.setEncoding("utf-8");
  runner.stdout.on("data", (d) => { out += d; });
  // Three chunks, each gap inside the per-stall budget but adding up to more
  // than it. The budget used to cover the whole read, so everything already
  // received was discarded once the total passed it. The budget is shortened
  // here so the shape can be reproduced in under two seconds.
  runner.stdin.write("one ");
  return new Promise((resolve, reject) => {
    setTimeout(() => runner.stdin.write("two "), 600);
    setTimeout(() => {
      runner.stdin.write("three\n");
      runner.stdin.end();
    }, 1200);
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

test("an over-long task is reported, not left as a phantom running job", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(jobsDir, { recursive: true });
  // Long enough to hit the per-argument limit where there is one (Linux caps a
  // single argv entry at MAX_ARG_STRLEN, and spawn then throws E2BIG
  // synchronously), reachable now that free-form text arrives on stdin rather
  // than a command line. macOS has no per-argument cap, so there the same input
  // simply runs. What has to hold on both is the invariant: either the failure
  // is reported or the run happens, and either way no record is left claiming
  // to be running -- the pre-spawn record used to sit "running" with no pid for
  // the whole pidless window, which cancel then refused as "still starting".
  const huge = "x".repeat(300 * 1024);
  const r = runWithStdin(["rescue"], `${huge}\n`, { KIRO_CLI_PATH: kiro });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  if (/ERROR: could not start the Kiro runner/.test(r.stdout)) {
    assert.match(r.stdout, /too long to pass to a command/);
  } else {
    assert.match(r.stdout, /^ARG:chat$/m, `neither reported nor run: ${r.stdout.slice(0, 200)}`);
  }
  const jobs = readJobs();
  assert.equal(jobs.filter((j) => j.status === "running").length, 0, JSON.stringify(jobs));
  assert.match(run(["cancel"]).stdout, /No running jobs to cancel/);
});

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
    const cmdline = cmdlineOf(runnerish.pid);
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

test("a cancelled run stops kiro-cli and is recorded as cancelled, not as a failure", async () => {
  const marker = join(tmpDir, "rewrite-finished");
  const kiro = fakeSlowKiro(3, marker);
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  assert.match(run(["cancel", jobId]).stdout, new RegExp(`Cancelled job ${jobId}`));
  await new Promise((r) => setTimeout(r, 4500));
  assert.equal(existsSync(marker), false, "kiro-cli survived the cancellation");
  // Whether this process's own signal handler or the child's exit event is
  // dispatched first is not ordered, and the two used to disagree: on macOS the
  // exit event won every time and an explicit cancellation was filed as a
  // failure whose transcript blamed a signal the user had sent on purpose.
  const job = JSON.parse(run(["status", jobId]).stdout);
  assert.equal(job.status, "cancelled", `transcript=${JSON.stringify(run(["result", jobId]).stdout)}`);
  assert.doesNotMatch(run(["result", jobId]).stdout, /terminated by SIGTERM/);
});

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

test("a foreground wait gives up on a pid-less record without waiting out the budget", () => {
  const kiro = fakeSlowKiro(30);
  mkdirSync(jobsDir, { recursive: true });
  // The launcher skips the pid write when its re-read fails, so a record can
  // legitimately be "running" with no pid. The cheap liveness check cannot see
  // that, and the wait used to run the whole budget out.
  const child = spawn(process.execPath, [COMPANION, "review"], {
    stdio: ["ignore", "pipe", "pipe"],
    // The reconciling read is what has to notice this, and it runs on a
    // schedule; shortened here so the test does not sit through the default.
    env: childEnv({ KIRO_CLI_PATH: kiro, KIRO_PLUGIN_TIMEOUT_MS: "120000", KIRO_PLUGIN_RECONCILE_MS: "300" }),
  });
  let out = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (d) => { out += d; });

  const started = Date.now();
  return (async () => {
    // Strip the pid and back-date it past the pidless grace, so reconciliation
    // is the only thing that can notice.
    while (Date.now() - started < 8000) {
      const meta = readJobs().find((j) => typeof j.pid === "number");
      if (meta) {
        process.kill(-meta.pid, "SIGKILL");
        writeFileSync(join(jobsDir, `${meta.id}.json`), JSON.stringify({
          id: meta.id, kind: meta.kind, status: "running",
          startedAt: new Date(Date.now() - 600_000).toISOString(),
        }));
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 40_000, `waited ${Date.now() - started}ms of a 120s budget`);
    assert.doesNotMatch(out, /did not finish within/);
  })();
});

