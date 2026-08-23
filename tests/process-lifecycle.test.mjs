// The life of a job: detaching from the caller, recording an outcome, timing
// out, and telling the truth on read when the runner is no longer there. What a
// record means once it is on disk is asserted in jobs.test.mjs; these are the
// cases where a real supervisor process has to produce or fail to produce it.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPANION,
  childEnv,
  cmdlineOf,
  dirs,
  fakeEchoKiro,
  fakeSlowKiro,
  readJobs,
  resultOf,
  run,
  useProcessHarness,
  waitForJob,
} from "./helpers/process-harness.mjs";

useProcessHarness();

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
  const kiro = join(dirs.tmp, "failing-kiro");
  writeFileSync(kiro, '#!/bin/sh\necho "boom" >&2\nexit 3\n', { mode: 0o755 });
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running");
  assert.equal(job.status, "failed");
  assert.match(resultOf(job.id), /boom/);
});

test("a runner that cannot be spawned is recorded as failed, not left crashing", async () => {
  const kiro = fakeEchoKiro();
  const r = run(["review", "--background"], {
    KIRO_CLI_PATH: kiro,
    KIRO_PLUGIN_NODE: join(dirs.tmp, "no-such-node"),
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

test("a runner that cannot start kiro-cli at all still records and sweeps", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(dirs.jobs, { recursive: true });
  // A directory is not executable, and spawn throws synchronously for EACCES-
  // adjacent errnos. Unguarded at the top level that escaped module evaluation,
  // leaving no record behind.
  const notABinary = join(dirs.tmp, "a-directory");
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

test("a foreground timeout takes kiro-cli's descendants with it", async () => {
  const marker = join(dirs.tmp, "descendant-finished");
  const kiro = join(dirs.tmp, "leaky-stubborn-kiro");
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

test("a run that exits just before the deadline is not recorded as a timeout", async () => {
  const kiro = join(dirs.tmp, "just-in-time-kiro");
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

test("a timeout expiring during the flush grace window does not fail a finished run", async () => {
  const kiro = join(dirs.tmp, "quick-leaky-kiro");
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

test("a finished run is still recorded when its record lost the pid mid-flight", async () => {
  const kiro = fakeSlowKiro(3);
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  // Reconciliation would call this "failed"; the runner must not read it that
  // way and throw away the review it just completed.
  writeFileSync(
    join(dirs.jobs, `${jobId}.json`),
    JSON.stringify({ id: jobId, kind: "review", status: "running", startedAt: "2026-01-01T00:00:00.000Z" })
  );
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running", 15_000);
  assert.equal(job.status, "completed");
  assert.match(resultOf(job.id), /slow done/);
});

test("a job whose record is removed mid-run is discarded, not refiled", async () => {
  const kiro = fakeSlowKiro(1);
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  unlinkSync(join(dirs.jobs, `${jobId}.json`));
  await new Promise((r) => setTimeout(r, 2500));
  // It used to be resurrected with kind "task" and a startedAt of now, so a
  // review reappeared as a rescue that had apparently taken no time at all.
  assert.equal(readdirSync(dirs.jobs).includes(`${jobId}.json`), false);
  assert.equal(run(["status"]).stdout.trim(), "No Kiro jobs found.");
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

test("a foreground wait stops when its record is removed underneath it", async () => {
  const kiro = fakeSlowKiro(20);
  mkdirSync(dirs.jobs, { recursive: true });
  const child = spawn(process.execPath, [COMPANION, "review"], {
    env: { ...process.env, KIRO_PLUGIN_JOBS_DIR: dirs.jobs, KIRO_CLI_PATH: kiro, KIRO_PLUGIN_TIMEOUT_MS: "15000" },
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
      unlinkSync(join(dirs.jobs, `${meta.id}.json`));
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

test("a foreground wait gives up on a pid-less record without waiting out the budget", () => {
  const kiro = fakeSlowKiro(30);
  mkdirSync(dirs.jobs, { recursive: true });
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
        writeFileSync(join(dirs.jobs, `${meta.id}.json`), JSON.stringify({
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

test("a verified live runner is trusted however long it has been running", () => {
  mkdirSync(dirs.jobs, { recursive: true });
  // The extra argv entries put "kiro-runner" and the job id in the process's
  // command line, so the identity probe returns "ours".
  const runnerish = spawn(
    process.execPath,
    ["-e", "setTimeout(()=>{}, 60000)", "kiro-runner.js", "kiro-wedged-aa"],
    { stdio: "ignore" },
  );
  try {
    writeFileSync(join(dirs.jobs, "kiro-wedged-aa.json"), JSON.stringify({
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
    assert.ok(readdirSync(dirs.jobs).includes("kiro-wedged-aa.json"), "a live job's record was pruned");
  } finally {
    try { runnerish.kill("SIGKILL"); } catch { /* already gone */ }
  }
});
