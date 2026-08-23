// The `ps` half of the pid probe, which only runs where there is no /proc.
//
// jobs.ts reads a process's state and command line from /proc where it exists
// and shells out to `ps -ww -o state=,args=` where it does not. On Linux the
// second path is dead code, so CI never executes it -- and everything the job
// store decides about a running job goes through it: whether a record still
// belongs to our runner, whether a pid has been recycled, whether a killed
// runner can be noticed at once instead of after its whole budget, and whether
// `cancel` is allowed to signal a process group at all.
//
// This file is deliberately outside the `tests/*.test.mjs` glob that `pnpm test`
// and CI use. Run it with `pnpm test:macos` on a machine that has no /proc.
import { test, before } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { classifyPid, isPidAlive, pidInfo } from "../../plugins/kiro-cli/scripts/lib/jobs.js";

const NO_PROC = !existsSync("/proc/self/stat");

before(() => {
  // If this ever fails, the suite is not testing what it says it is: the
  // assertions below would be exercising the /proc path under a macOS name.
  assert.equal(NO_PROC, true, "/proc exists here, so the ps fallback is not the path being tested");
});

/** Everything here needs a real process; nothing here needs a jobs directory. */
const RUNNER_ARGV = (jobId) => ["-e", "setTimeout(()=>{}, 60000)", "/some/path/kiro-runner.js", jobId];

function spawnDetached(args) {
  const child = spawn(process.execPath, args, { stdio: "ignore", detached: true });
  // Unreferenced, or the runner waits out each fixture's own timer before it
  // will exit -- five seconds of teardown for assertions that take twenty
  // milliseconds.
  child.unref();
  return child;
}

function reap(child) {
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
}

test("ps reports a live process's state and full command line", (t) => {
  if (!NO_PROC) return t.skip("has /proc");
  const info = pidInfo(process.pid);
  assert.notEqual(info, null, "the probe could not read this process at all");
  // A state letter, so classifyPid can recognise a zombie without /proc. macOS
  // reports things like "S", "R+", "S+".
  assert.match(info.state, /^[A-Za-z]/, `no state letter: ${JSON.stringify(info.state)}`);
  assert.doesNotMatch(info.state, /^Z/, "this process is not a zombie");
  // And an argv, which is what the identity check matches on.
  assert.ok(info.argv.length > 0, "no command line");
  assert.ok(info.argv.some((a) => a.includes("pid-probe.test.mjs")), `argv does not look like ours: ${info.argv.join(" ")}`);
});

test("a pid nothing owns cannot be probed at all", (t) => {
  if (!NO_PROC) return t.skip("has /proc");
  // 2^22 is above the default pid_max, so it can never be live. ps exits
  // non-zero for it, which the probe reports as "nothing could be read" rather
  // than inventing a process with an empty command line.
  assert.equal(isPidAlive(4194304), false);
  assert.equal(pidInfo(4194304), null);
  // That answer is "unknown", and it is only reachable from a caller that has
  // not already checked liveness -- reconcile consults classifyPid only for a
  // pid that answers kill(pid, 0), and treats a dead one as a runner that
  // exited without recording. cancel refuses an unproven pid outright.
  assert.equal(classifyPid(4194304, "kiro-macos006-aa"), "unknown");
});

test("the identity check finds our runner in a ps command line", (t) => {
  if (!NO_PROC) return t.skip("has /proc");
  // ps returns one string, so argument boundaries are approximated by
  // whitespace. That is enough only because the two entries matched on -- the
  // runner's path and the job id -- are adjacent and contain no spaces.
  const child = spawnDetached(RUNNER_ARGV("kiro-macos001-aa"));
  try {
    assert.equal(classifyPid(child.pid, "kiro-macos001-aa"), "ours");
    // Positional, not a substring search anywhere in the line: a runner whose
    // prompt merely mentioned another job's id used to be taken for that job,
    // and on a recycled pid that had cancel signalling the wrong group.
    assert.equal(classifyPid(child.pid, "kiro-macos002-aa"), "foreign");
  } finally {
    reap(child);
  }
});

test("a process that is plainly not a runner reads as foreign", (t) => {
  if (!NO_PROC) return t.skip("has /proc");
  const child = spawnDetached(["-e", "setTimeout(()=>{}, 60000)"]);
  try {
    assert.equal(classifyPid(child.pid, "kiro-macos003-aa"), "foreign");
  } finally {
    reap(child);
  }
});

test("ps is asked for an untruncated line, so a long argv still matches", (t) => {
  if (!NO_PROC) return t.skip("has /proc");
  // Without -ww, BSD and macOS truncate to the terminal width, which drops the
  // tail of a long command line -- and with it the job id the match depends on.
  const padding = "x".repeat(300);
  const child = spawnDetached([
    "-e", "setTimeout(()=>{}, 60000)", padding, "/some/path/kiro-runner.js", "kiro-macos004-aa",
  ]);
  try {
    const info = pidInfo(child.pid);
    assert.ok(info.argv.join(" ").includes("kiro-macos004-aa"), "the line came back truncated");
    assert.equal(classifyPid(child.pid, "kiro-macos004-aa"), "ours");
  } finally {
    reap(child);
  }
});

test("an unreaped zombie is dead, not alive and not foreign", async (t) => {
  if (!NO_PROC) return t.skip("has /proc");
  // kill(pid, 0) keeps succeeding for a zombie, so liveness alone cannot tell.
  // Reading the state letter is what lets a killed runner be noticed at once
  // instead of waiting out its budget; where that was /proc-only, the same
  // runner was called "foreign" -- asserting a pid recycling that never
  // happened -- or "ours", leaving the job uncancellable until it expired.
  //
  // Holding a zombie still long enough to look at needs a parent that never
  // waits, and the obvious candidates cannot: a shell reaps a background job as
  // soon as it reports the job's status, and Node reaps anything it spawned.
  // `exec` is the way out -- the shell forks the child, then replaces its own
  // image with `sleep`, which keeps the child's parent alive at the same pid and
  // never calls waitpid. Nothing here is beyond /bin/sh and sleep.
  const holder = spawn("/bin/sh", ["-c", "sleep 30 & echo $! ; exec sleep 30"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    const pid = await new Promise((resolve, reject) => {
      let out = "";
      // Cleared on both paths: an outstanding timer keeps the event loop alive,
      // and the runner then waits it out before reporting -- five seconds of
      // nothing after assertions that take twenty milliseconds.
      const giveUp = setTimeout(() => reject(new Error(`no pid from the holder; saw ${JSON.stringify(out)}`)), 5000);
      holder.stdout.setEncoding("utf-8");
      holder.stdout.on("data", (d) => {
        out += d;
        const n = Number(out.trim());
        if (Number.isInteger(n) && n > 0) {
          clearTimeout(giveUp);
          resolve(n);
        }
      });
      holder.on("error", (e) => {
        clearTimeout(giveUp);
        reject(e);
      });
    });
    process.kill(pid, "SIGKILL");
    // ps needs a moment to see the new state.
    let info = null;
    for (let i = 0; i < 60; i++) {
      info = pidInfo(pid);
      if (info?.state?.startsWith("Z")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(info?.state?.startsWith("Z"), `never became a zombie: ${JSON.stringify(info)}`);
    assert.equal(isPidAlive(pid), true, "a zombie still answers kill(pid, 0)");
    // State is checked before the command line, which for a zombie macOS reports
    // as "<defunct>" -- read as an argv, that is somebody else's process.
    assert.equal(classifyPid(pid, "kiro-macos005-aa"), "dead");
  } finally {
    try { holder.kill("SIGKILL"); } catch { /* already gone */ }
  }
});

test("the runner learns its own process group without /proc", (t) => {
  if (!NO_PROC) return t.skip("has /proc");
  // leadsOwnGroup() decides whether the runner may sweep its group by negated
  // pid. Reading /proc/self/stat is the Linux path; here it has to come from
  // `ps -o pgid=`, and an unknown answer must count as "no" -- signalling the
  // negated pid when this process does not lead its group would take the
  // caller's whole group down, an interactive shell included.
  const r = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf-8" });
  assert.equal(r.status, 0, `ps failed: ${r.stderr}`);
  const pgid = Number(r.stdout.trim());
  assert.ok(Number.isInteger(pgid) && pgid > 0, `unparseable pgid: ${JSON.stringify(r.stdout)}`);
  // node --test runs each file in a child process, which is not a group leader.
  assert.notEqual(pgid, process.pid, "expected not to lead our own group here");
});

test("macOS imposes no per-argument exec limit, so an enormous prompt runs", (t) => {
  if (process.platform !== "darwin") return t.skip("not macOS");
  // The Linux path through the same code is E2BIG from spawn, which
  // process-invocation.test.mjs asserts as an invariant that holds either way.
  // Recording the platform difference here keeps that test honest: if macOS ever
  // gains the limit, this fails and says so instead of the generic test quietly
  // taking its other branch for ever.
  const huge = "x".repeat(300 * 1024);
  const r = spawnSync("/bin/echo", [huge], { encoding: "utf-8" });
  assert.equal(r.error, undefined, `exec refused a 300KB argument: ${r.error?.message}`);
  assert.equal(r.status, 0);
});
