// Cancellation, which is the only place this plugin sends signals. Every case
// here turns on something that exists only for a real process: a process group,
// a pid that may have been recycled, a child that ignores SIGTERM, a runner
// nobody has reaped yet. cancel's refusals on a record it cannot act on are
// asserted without a process in jobs.test.mjs.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyPid } from "../plugins/kiro-cli/scripts/lib/jobs.js";
import {
  RUNNER,
  dirs,
  fakeSlowKiro,
  run,
  useProcessHarness,
  waitForJob,
} from "./helpers/process-harness.mjs";

useProcessHarness();

test("cancel stops a running background job and its kiro-cli child", async () => {
  // The marker is only written once the sleep finishes, so its absence proves
  // the kiro-cli child itself was killed -- not merely the runner above it.
  const marker = join(dirs.tmp, "kiro-finished");
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

test("a cancelled run stops kiro-cli and is recorded as cancelled, not as a failure", async () => {
  const marker = join(dirs.tmp, "rewrite-finished");
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

test("cancel keeps the output the runner had already captured", async () => {
  const kiro = join(dirs.tmp, "chatty-kiro");
  const emitted = join(dirs.tmp, "emitted");
  // Waits for kiro to have actually printed its first line rather than guessing
  // at how long that takes: under a loaded machine running the other suites
  // alongside this one, a fixed pause cancelled before there was any output to
  // keep, and the test failed for a reason it was not about.
  writeFileSync(kiro, `#!/bin/sh\necho "partial findings so far"\ntouch "${emitted}"\nsleep 30\n`, { mode: 0o755 });
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  for (let i = 0; i < 100 && !existsSync(emitted); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(emitted), "kiro-cli never got as far as printing anything");
  assert.match(run(["cancel", jobId]).stdout, /Cancelled job/);
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running", 10_000);
  assert.equal(job.status, "cancelled");
  // Previously the launcher overwrote the runner's record with a stale snapshot.
  assert.match(run(["result", jobId]).stdout, /partial findings so far/);
});

test("cancelling a job whose runner is an unreaped zombie records it", async () => {
  const kiro = fakeSlowKiro(30);
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  const job = await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  // Kill it out from under cancel, leaving the reparented runner unreaped --
  // the usual state in a container, where isPidAlive still says yes.
  process.kill(-job.pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 400));
  const raw = JSON.parse(readFileSync(join(dirs.jobs, `${jobId}.json`), "utf-8"));
  assert.equal(raw.status, "running", "the record should still read running on disk");

  const out = run(["cancel", jobId]).stdout;
  // The "dead" verdict was handled in reconciliation but not here, so this said
  // the runner was still alive, or that signalling had been refused.
  assert.doesNotMatch(out, /still alive after/);
  assert.doesNotMatch(out, /was refused/);
  assert.match(out, /Cancelled job|already failed/);
});

test("cancel never signals a live pid that is not one of our runners", () => {
  mkdirSync(dirs.jobs, { recursive: true });
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
    writeFileSync(join(dirs.jobs, "kiro-foreign-aa.json"), JSON.stringify({
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
  writeFileSync(join(dirs.jobs, "kiro-zzstillborn-aa.json"), JSON.stringify({
    id: "kiro-zzstillborn-aa", kind: "review", status: "running",
    startedAt: new Date(Date.now() + 1000).toISOString(),
  }));
  const r = run(["cancel"]);
  assert.match(r.stdout, new RegExp(`Cancelled job ${jobId}`));
  assert.doesNotMatch(r.stdout, /still starting/);
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
  writeFileSync(join(dirs.jobs, `${other}.json`), JSON.stringify({
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

test("only the runner's first mention of the script decides which job it is", async () => {
  // Adjacency on its own is forgeable. Where argv boundaries are approximated --
  // the `ps` probe, on any platform without /proc -- a prompt reading
  // "... kiro-runner.js <id> ..." splits into exactly the pair the check wants,
  // and one process then answered "ours" for two different job ids at once.
  // cancel's only guard before signalling a negated pid is that answer.
  //
  // Passing the pair as separate arguments reproduces the same shape on /proc,
  // so this holds CI to it too; tests/macos covers the prompt-shaped original.
  const child = spawn(process.execPath, [
    "-e", "setTimeout(() => {}, 30000)",
    RUNNER, "kiro-firstref-real", "1000", "/bin/kiro-cli", "chat",
    "look", "at", RUNNER, "kiro-firstref-fake", "as", "well",
  ], { stdio: "ignore", detached: true });
  // Or the test file waits out the fixture's own timer before it will exit.
  child.unref();
  try {
    assert.equal(classifyPid(child.pid, "kiro-firstref-real"), "ours");
    assert.equal(classifyPid(child.pid, "kiro-firstref-fake"), "foreign");
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

test("cancel reports an unreadable record rather than a bare errno", async () => {
  const kiro = fakeSlowKiro(20);
  const { jobId } = JSON.parse(run(["rescue", "--background", "go"], { KIRO_CLI_PATH: kiro }).stdout);
  await waitForJob((j) => j.id === jobId && typeof j.pid === "number");
  // Replace the record with a directory: readFileSync then raises EISDIR on
  // every read cancel makes after the signal has already landed.
  const meta = join(dirs.jobs, `${jobId}.json`);
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
  const marker = join(dirs.tmp, "caller-survived");
  const harness = join(dirs.tmp, "harness.mjs");
  // The harness runs in its own process group, so a regression here kills only
  // it. It invokes the runner *not* detached -- so the runner does not lead the
  // group -- with a kiro path that cannot be spawned, forcing a sweep.
  writeFileSync(harness, `
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
spawnSync(process.execPath, [${JSON.stringify(RUNNER)}, "kiro-direct-aa", "5000", ${JSON.stringify(join(dirs.tmp, "not-a-binary-at-all"))}, "chat"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(marker)}, "yes");
`);
  const child = spawn(process.execPath, [harness], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, KIRO_PLUGIN_JOBS_DIR: dirs.jobs },
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(existsSync(marker), true, `the caller was killed by the sweep (exit ${code})`);
});
