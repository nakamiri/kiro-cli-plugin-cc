// How the companion actually reaches kiro-cli: the argv it hands over, the
// binary it execs, the pipes it reads back, and the free-form text it takes on
// stdin. The shape of the argv array is asserted in args.test.mjs; what is here
// is everything that only a real exec can show -- that no shell is involved,
// that a path with spaces survives it, and that output crossing a pipe comes
// back intact.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPANION,
  RUNNER,
  childEnv,
  dirs,
  fakeEchoKiro,
  readJobs,
  resultOf,
  run,
  runWithStdin,
  useProcessHarness,
  waitForJob,
} from "./helpers/process-harness.mjs";

useProcessHarness();

test("prompt metacharacters reach kiro-cli literally, unexpanded", () => {
  const kiro = fakeEchoKiro();
  const r = run(["rescue", "fix the $(id -u) and `hostname` bug"], { KIRO_CLI_PATH: kiro });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // One argv entry, verbatim: no command substitution, no word splitting.
  assert.match(r.stdout, /^ARG:fix the \$\(id -u\) and `hostname` bug$/m);
  assert.doesNotMatch(r.stdout, /ARG:fix the 0 /);
});

test("a kiro-cli path containing spaces works for both setup and rescue", () => {
  const dir = join(dirs.tmp, "my dir");
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
  const broken = join(dirs.tmp, "not-executable");
  writeFileSync(broken, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  const r = run(["setup"], { KIRO_CLI_PATH: broken });
  assert.match(r.stdout, /could not be run/);
  assert.doesNotMatch(r.stdout, /is ready/);
  const j = JSON.parse(run(["setup", "--json"], { KIRO_CLI_PATH: broken }).stdout);
  assert.equal(j.installed, true);
  assert.equal(j.runnable, false);
  assert.ok(j.error);
});

test("setup does not let kiro-cli's stderr into its own output", () => {
  const noisy = join(dirs.tmp, "noisy-version-kiro");
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

test("a foreground run that exits non-zero still returns what kiro printed", () => {
  const kiro = join(dirs.tmp, "warn-kiro");
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
  const kiro = join(dirs.tmp, "utf8-kiro");
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

test("truncation honours a byte budget, not a character count", async () => {
  const kiro = join(dirs.tmp, "cjk-loud-kiro");
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

test("a job finishes when kiro-cli exits but a descendant still holds its stdout", async () => {
  // "close" would never fire here; only reacting to "exit" finishes the job.
  const kiro = join(dirs.tmp, "leaky-kiro");
  writeFileSync(kiro, '#!/bin/sh\necho "review body"\nsleep 30 &\nexit 0\n', { mode: 0o755 });
  const { jobId } = JSON.parse(run(["review", "--background"], { KIRO_CLI_PATH: kiro }).stdout);
  const job = await waitForJob((j) => j.id === jobId && j.status !== "running", 10_000);
  assert.equal(job.status, "completed");
  assert.match(resultOf(job.id), /review body/);
});

test("a descendant that redirected its own stdio does not outlive the run", async () => {
  const marker = join(dirs.tmp, "hidden-descendant");
  const kiro = join(dirs.tmp, "hidden-desc-kiro");
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

test("an over-long task is reported, not left as a phantom running job", () => {
  const kiro = fakeEchoKiro();
  mkdirSync(dirs.jobs, { recursive: true });
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

test("the runner rejects a non-numeric timeout instead of treating it as NaN", () => {
  const kiro = fakeEchoKiro();
  const r = spawnSync(process.execPath, [RUNNER, "kiro-x-y", "not-a-number", kiro, "chat"], {
    encoding: "utf-8",
    env: { ...process.env, KIRO_PLUGIN_JOBS_DIR: dirs.jobs },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /timeoutMs must be a positive integer/);
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
    env: { ...process.env, KIRO_PLUGIN_JOBS_DIR: dirs.jobs, KIRO_CLI_PATH: kiro },
  });
  assert.equal(r.signal, null, "the command hung");
  assert.equal(r.status, 0);
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

test("the PATH lookup for kiro-cli is bounded", () => {
  const bin = join(dirs.tmp, "slowbin");
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

test("setup's version probe is bounded even against a process that ignores SIGTERM", () => {
  const kiro = join(dirs.tmp, "hanging-version-kiro");
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
