// Shared fixtures for the process-level suites: the ones whose subject is a
// spawned process rather than a function's return value. Everything that can be
// asserted without one lives in args.test.mjs, jobs.test.mjs and
// store.test.mjs, which are three orders of magnitude faster.
//
// These suites are split across files on purpose: node:test runs files in
// parallel but the tests inside one file in sequence, and a single file of
// process tests is the whole suite's wall-clock time.
import { after, afterEach, beforeEach } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const COMPANION = resolve(__dirname, "..", "..", "plugins", "kiro-cli", "scripts", "kiro-companion.mjs");
export const RUNNER = resolve(__dirname, "..", "..", "plugins", "kiro-cli", "scripts", "lib", "kiro-runner.js");

/**
 * The current test's directories. A live object rather than two bindings,
 * because beforeEach replaces them for every test and a destructured copy would
 * still point at the previous one.
 */
export const dirs = { tmp: null, jobs: null };

/**
 * Registers the per-test temp directory and the teardown that stops the
 * detached runners a test may have left behind. Call once at the top of a
 * process-level test file.
 */
export function useProcessHarness() {
  const created = [];

  beforeEach(() => {
    dirs.tmp = mkdtempSync(join(tmpdir(), "kiro-process-test-"));
    dirs.jobs = join(dirs.tmp, "jobs");
    created.push(dirs.tmp);
  });

  afterEach(async () => {
    // Tests start detached runners. Left alive they keep their fake kiro-cli
    // running and recreate the jobs directory through ensureJobsDir() as soon
    // as it is removed, which is how stale temp dirs accumulated per run.
    for (const job of safeReadJobs()) {
      if (job.status !== "running" || typeof job.pid !== "number") continue;
      // Only ever signal a real runner. Some fixtures deliberately record
      // process.pid to stand in for a recycled pid, and group-killing that
      // would take this test process down with it.
      if (!isRunnerPid(job.pid)) continue;
      try { process.kill(-job.pid, "SIGKILL"); } catch {
        try { process.kill(job.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
    // A runner already past its record write can still be in its flush grace
    // and recreate the directory through ensureJobsDir(); retry until it stays
    // gone. Remove first and only then wait: now that the sweep above actually
    // kills runners on every platform, the common case needs no wait at all,
    // and paying one unconditionally cost 150ms per test.
    for (let attempt = 0; attempt < 6; attempt++) {
      rmSync(dirs.tmp, { recursive: true, force: true });
      if (!existsSync(dirs.tmp)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  // A runner can outlive its own afterEach by longer than that hook will wait,
  // so sweep once more at the end, when nothing this file started is alive.
  after(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  });
}

/**
 * A process's command line, from /proc where it exists and from ps otherwise.
 * The code under test has this fallback; the harness needs it too, or on macOS
 * every runner identity check answers "no" -- which is how the afterEach sweep
 * stopped killing anything and the suite began leaving detached runners and
 * their temp dirs behind.
 */
export function cmdlineOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").filter(Boolean).join(" ");
  } catch {
    /* not Linux, or the process is gone */
  }
  const ps = spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf-8" });
  return ps.stdout ?? "";
}

export function isRunnerPid(pid) {
  if (pid === process.pid) return false;
  return cmdlineOf(pid).includes("kiro-runner");
}

/**
 * Tool trust is on by default in the product, and off by default here. Nothing
 * in these tests depends on the flag except the ones that assert it, and
 * keeping it out of the runner's argv costs a machine running an
 * endpoint-security agent that inspects argv about 1.7 seconds per spawn -- a
 * Defender-for-Endpoint exec hook reacts to the literal "--trust-all-tools".
 * Pass `KIRO_PLUGIN_TRUST_ALL_TOOLS: null` to get the product default back.
 */
const TRUST_OFF = { KIRO_PLUGIN_TRUST_ALL_TOOLS: "0" };

export function childEnv(env) {
  const merged = { ...process.env, KIRO_PLUGIN_JOBS_DIR: dirs.jobs, ...TRUST_OFF, ...env };
  // An explicit null means "leave it unset", which is not something spawnSync's
  // env can express on its own.
  for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
  return merged;
}

export function run(args, env = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: "utf-8",
    env: childEnv(env),
  });
}

/** Drives the --args-stdin route the slash commands use for free-form text. */
export function runWithStdin(args, stdin, env = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args, "--args-stdin"], {
    encoding: "utf-8",
    input: stdin,
    env: childEnv(env),
  });
}

/** A fake kiro-cli that prints its own argv, one argument per line. */
export function fakeEchoKiro(name = "fake-kiro-cli") {
  const path = join(dirs.tmp, name);
  writeFileSync(
    path,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "kiro-cli 1.2.3"; exit 0; fi\n' +
      'for a in "$@"; do echo "ARG:$a"; done\n',
    { mode: 0o755 }
  );
  return path;
}

export function fakeSlowKiro(seconds, markerPath) {
  const path = join(dirs.tmp, "fake-slow-kiro");
  const marker = markerPath ? `touch "${markerPath}"\n` : "";
  writeFileSync(path, `#!/bin/sh\nsleep ${seconds}\n${marker}echo "slow done"\n`, { mode: 0o755 });
  return path;
}

/** A job's transcript lives beside its record, not inside it. */
export function resultOf(id) {
  return readFileSync(join(dirs.jobs, `${id}.out`), "utf-8");
}

export function readJobs() {
  const jobs = [];
  for (const f of readdirSync(dirs.jobs)) {
    if (!f.endsWith(".json")) continue;
    try {
      jobs.push(JSON.parse(readFileSync(join(dirs.jobs, f), "utf-8")));
    } catch {
      // Some tests deliberately plant unreadable entries; skip them here.
    }
  }
  return jobs;
}

export function safeReadJobs() {
  try {
    return readJobs();
  } catch {
    return [];
  }
}

export async function waitForJob(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = readJobs().find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for job; saw ${JSON.stringify(safeReadJobs())}`);
}

/** A terminal record and its transcript, planted without running anything. */
export function writeStoredJob(id, { status = "completed", ageMs = 0, body = "" } = {}) {
  const ts = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(
    join(dirs.jobs, `${id}.json`),
    JSON.stringify({ id, kind: "review", status, startedAt: ts, finishedAt: ts, resultBytes: Buffer.byteLength(body) })
  );
  writeFileSync(join(dirs.jobs, `${id}.out`), body);
}
