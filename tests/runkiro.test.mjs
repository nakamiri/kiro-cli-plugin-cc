// Regression tests for how the companion actually invokes kiro-cli: argument
// passing, background detachment, and job-store robustness. The pre-existing
// suites never entered these paths, which is why a shell-injection bug and a
// non-detaching "background" mode both survived.
import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPANION = resolve(__dirname, "..", "plugins", "kiro-cli", "scripts", "kiro-companion.mjs");

let tmpDir;
let jobsDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kiro-runkiro-test-"));
  jobsDir = join(tmpDir, "jobs");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function run(args, env = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: "utf-8",
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
  assert.match(job.result, /slow done/);
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
  assert.match(job.result, /boom/);
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
    JSON.stringify({ id: "done", kind: "review", status: "completed", startedAt: "2026-01-01T00:00:00.000Z", pid: 1, result: "x" })
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
  assert.match(s.result, /without recording a result/);
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
    JSON.stringify({ id: "good", kind: "review", status: "completed", startedAt: "2026-01-02T00:00:00.000Z", result: "ok" })
  );
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

test("an existing jobs directory with loose permissions is tightened", () => {
  if (process.getuid === undefined) return;
  mkdirSync(jobsDir, { recursive: true, mode: 0o777 });
  const r = run(["status"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(statSync(jobsDir).mode & 0o077, 0);
});

test("job records themselves are not world-readable", async () => {
  if (process.getuid === undefined) return;
  const kiro = fakeEchoKiro();
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && j.status !== "running");
  assert.equal(statSync(join(jobsDir, `${jobId}.json`)).mode & 0o077, 0);
});
