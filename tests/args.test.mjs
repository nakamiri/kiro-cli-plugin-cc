// Argument parsing, prompt building and settings: everything whose answer is a
// pure function of its input. These used to be asserted by spawning the CLI and
// reading a fake kiro-cli's echoed argv, which cost 0.3-2s per case for a
// question that a direct call answers in microseconds.
//
// What is deliberately *not* here: that the plugin passes argv without a shell,
// that free-form text really arrives on stdin, and that a prompt too long for
// exec is reported. Those are properties of a spawned process, and they live in
// runkiro.test.mjs.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildRescuePrompt,
  buildReviewPrompt,
  hasFlag,
  isSafeRef,
  rescue,
  splitArgs,
  wantsBackground,
} from "../plugins/kiro-cli/scripts/lib/kiro-companion.js";
import {
  agentEngine,
  backgroundTimeoutMs,
  chatArgs,
  foregroundTimeoutMs,
  jobTtlMs,
  maxOutputBytes,
  maxRetainedJobs,
  trustAllTools,
} from "../plugins/kiro-cli/scripts/lib/kiro.js";
import { isValidJobId, reconcile } from "../plugins/kiro-cli/scripts/lib/jobs.js";

/** A stand-in for the run-scoped agent name the launcher derives from the job. */
const AGENT = "kiro-plugin-review-kiro-aaaa0000-aa";

/** Runs `fn` with the given env vars set, restoring whatever was there before. */
function withEnv(vars, fn) {
  const saved = new Map();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const NOW = () => new Date().toISOString();
const AGO = (ms) => new Date(Date.now() - ms).toISOString();

// --- review: the base ref ---

test("review defaults to HEAD and says what it covers", () => {
  const p = buildReviewPrompt([]);
  assert.match(p, /Compare against HEAD\./);
  assert.match(p, /correctness, security, performance, and style/);
});

test("an ordinary ref is honoured, in both the separate and joined form", () => {
  for (const ref of ["main", "origin/main", "v1.2.3", "HEAD~3", "HEAD^", "release/2.x"]) {
    assert.ok(isSafeRef(ref), `isSafeRef rejected ${ref}`);
    for (const args of [["--base", ref], [`--base=${ref}`]]) {
      // The joined form used to fall through into the focus text while the
      // compared ref silently stayed HEAD.
      assert.match(buildReviewPrompt(args), new RegExp(`Compare against ${ref.replace(/[.^$*+?()[\]{}|\\/]/g, "\\$&")}\\.`),
        `${args.join(" ")} did not compare against ${ref}`);
      assert.doesNotMatch(buildReviewPrompt(args), /Focus on:/, `${args.join(" ")} leaked into the focus text`);
    }
  }
});

test("--base with nothing usable after it falls back to HEAD", () => {
  // "--base --background" used to make "--background" the ref, and "--base ''"
  // produced "Compare against ." instead of falling back.
  for (const args of [["--base"], ["--base", ""], ["--base="], ["--base", "--background"], ["--base", "--wait"]]) {
    const p = buildReviewPrompt(args);
    assert.match(p, /Compare against HEAD\./, `${JSON.stringify(args)} did not fall back`);
    assert.doesNotMatch(p, /Compare against \./, `${JSON.stringify(args)} produced an empty ref`);
    assert.doesNotMatch(p, /Focus on:/, `${JSON.stringify(args)} leaked a flag into the focus text`);
  }
});

test("a ref that is not a ref is refused rather than passed through", () => {
  // Shell metacharacters, brace expansion, and an unknown flag where a ref was
  // expected. The last one used to keep HEAD silently and reappear as focus
  // text, while --base=-x rejected the very same input.
  for (const ref of ["main; echo pwned", "$(id -u)", "a'b", "back`tick`", "a{b,c}", "-x", "--nope"]) {
    for (const args of [["--base", ref], [`--base=${ref}`]]) {
      assert.throws(
        () => buildReviewPrompt(args),
        /is not a usable git ref/,
        `${JSON.stringify(args)} was accepted`,
      );
    }
  }
});

// --- review: the focus text ---

test("focus text is terminated exactly once, whatever punctuation it brought", () => {
  const cases = [
    [["the auth paths"], /Focus on: the auth paths\. Provide/],
    [["fix the auth paths."], /Focus on: fix the auth paths\. Provide/],
    [["why is auth slow?"], /Focus on: why is auth slow\? Provide/],
    [["check this;"], /Focus on: check this; Provide/],
  ];
  for (const [args, expected] of cases) {
    const p = buildReviewPrompt(args);
    assert.match(p, expected, `${JSON.stringify(args)} -> ${p}`);
    assert.doesNotMatch(p, /[.!?:;]\./, `doubled punctuation for ${JSON.stringify(args)}: ${p}`);
  }
});

test("extra args become focus text alongside a ref", () => {
  const p = buildReviewPrompt(["--base", "main", "check", "auth", "logic"]);
  assert.match(p, /Compare against main\./);
  assert.match(p, /Focus on: check auth logic\./);
});

test("execution flags never reach the prompt, and leave no focus section behind", () => {
  const p = buildReviewPrompt(["--background", "review", "this"]);
  assert.doesNotMatch(p, /--background/);
  assert.match(p, /Focus on: review this\./);
  assert.doesNotMatch(buildReviewPrompt(["--base", "develop", "--wait"]), /Focus on:/);
});

// --- rescue ---

test("a rescue task is the argument text, with execution flags removed", () => {
  assert.equal(buildRescuePrompt(["fix", "the", "flaky", "test"]), "fix the flaky test");
  assert.equal(buildRescuePrompt(["--background", "investigate", "the", "bug"]), "investigate the bug");
});

test("rescue with no task refuses instead of inventing one", async () => {
  // It used to fall back to "Investigate and fix the current issue." and hand
  // that to Kiro under --trust-all-tools: a fabricated task, with the
  // repository writable.
  for (const args of [[], ["--background"], ["--wait"], ["--", ""], ["--"]]) {
    assert.equal(buildRescuePrompt(args), "", `${JSON.stringify(args)} produced a task`);
    assert.match(await rescue(args), /ERROR: no task was given/, `${JSON.stringify(args)} was not refused`);
  }
});

test("a multi-line task keeps its newlines and indentation", () => {
  const task = "line one\n  indented two\nline three";
  assert.equal(buildRescuePrompt(["--", task]), task);
  assert.equal(chatArgs(buildRescuePrompt(["--", task]), AGENT).at(-1), task);
});

// --- literal text after `--` (how free-form text arrives) ---

test("everything after a bare -- is literal text, joined", () => {
  assert.deepEqual(splitArgs(["--base", "main", "--", "the", "auth", "paths"]), {
    flags: ["--base", "main"],
    literal: "the auth paths",
  });
  assert.deepEqual(splitArgs(["--background"]), { flags: ["--background"], literal: "" });
});

test("literal text is never read as a flag nor as a flag's value", () => {
  // Free-form text arrives after `--`, so a task that reads like an option must
  // not become one -- and a --base with no ref of its own must not swallow it.
  assert.match(buildReviewPrompt(["--base", "--", "the auth paths"]), /Compare against HEAD\./);
  assert.match(buildReviewPrompt(["--base", "--", "the auth paths"]), /Focus on: the auth paths\./);
  for (const text of ["--background", "--wait", "--base", "add a --wait flag to the CLI"]) {
    assert.equal(buildRescuePrompt(["--", text]), text, `${text} was rewritten`);
    assert.equal(wantsBackground(["--", text]), false, `${text} was read as a flag`);
  }
});

test("flags in argv still apply when the text is literal", () => {
  const p = buildReviewPrompt(["--base", "main", "--", "the auth paths"]);
  assert.match(p, /Compare against main\./);
  assert.match(p, /Focus on: the auth paths\./);
  assert.doesNotMatch(p, /--args-stdin|--base/);
});

// --- flags ---

test("hasFlag looks only at the flags, not the text", () => {
  assert.equal(hasFlag(["--background", "task"], "--background"), true);
  assert.equal(hasFlag(["task"], "--background"), false);
  assert.equal(hasFlag(["--", "--background"], "--background"), false);
});

test("--background detaches unless --wait overrides it", () => {
  // --wait was documented but parsed nowhere, so asking to wait and getting a
  // detached job was the actual behaviour.
  assert.equal(wantsBackground(["--background"]), true);
  assert.equal(wantsBackground(["--background", "--", "some text"]), true);
  assert.equal(wantsBackground(["--wait", "--background"]), false);
  assert.equal(wantsBackground(["--background", "--wait"]), false);
  assert.equal(wantsBackground([]), false);
});

// --- the argv handed to kiro-cli ---

test("the prompt is one trailing argv entry, verbatim", () => {
  // Passed through a shell, any of these would have been split, expanded or
  // executed. chatArgs is what keeps it a single entry; runkiro.test.mjs proves
  // the spawn itself uses no shell.
  for (const prompt of [
    "fix the $(id -u) and `hostname` bug",
    'a "quoted" thing; echo pwned',
    "line one\n  indented two",
    "a'b",
  ]) {
    const args = chatArgs(prompt, AGENT);
    assert.equal(args.at(-1), prompt, `mangled: ${JSON.stringify(prompt)}`);
    assert.equal(args.filter((a) => a === prompt).length, 1);
  }
});

test("a -- separator is emitted only for a prompt that starts with a dash", () => {
  // "--verbose builds are broken" would otherwise be parsed as an option.
  const dashed = chatArgs("--verbose is broken", AGENT);
  assert.deepEqual(dashed.slice(-2), ["--", "--verbose is broken"]);
  assert.equal(chatArgs("tests are failing", AGENT).includes("--"), false);
});

test("the v2 engine keeps the blanket trust flag, and fails closed", () => {
  // v2 has no way to say less than "everything": the flag is all or nothing, and
  // an unrecognised value such as "off" or "disabled" clearly means the operator
  // wanted trust reduced, so it goes to nothing rather than to everything.
  const v2 = (env, fn) => withEnv({ KIRO_PLUGIN_AGENT_ENGINE: "v2", ...env }, fn);
  assert.equal(v2({ KIRO_PLUGIN_TRUST_ALL_TOOLS: null }, trustAllTools), true);
  assert.ok(v2({ KIRO_PLUGIN_TRUST_ALL_TOOLS: null }, () => chatArgs("x")).includes("--trust-all-tools"));
  for (const v of ["off", "FALSE", "disabled", "0", "no", ""]) {
    assert.equal(v2({ KIRO_PLUGIN_TRUST_ALL_TOOLS: v }, trustAllTools), false, `trust survived ${JSON.stringify(v)}`);
    assert.equal(v2({ KIRO_PLUGIN_TRUST_ALL_TOOLS: v }, () => chatArgs("x")).includes("--trust-all-tools"), false);
  }
  for (const v of ["1", "true", "YES", "on", " on "]) {
    assert.equal(v2({ KIRO_PLUGIN_TRUST_ALL_TOOLS: v }, trustAllTools), true, `trust lost for ${JSON.stringify(v)}`);
  }
  // Non-interactive either way, so trust off is a Kiro that can read but not act.
  assert.equal(v2({}, () => chatArgs("x"))[1], "--no-interactive");
  assert.equal(v2({}, () => chatArgs("x")).includes("--v3"), false);
});

test("the v3 engine names the run's agent instead of trusting everything", () => {
  const args = withEnv({ KIRO_PLUGIN_AGENT_ENGINE: null }, () => chatArgs("x", AGENT));
  assert.equal(agentEngine(), "v3", "v3 should be the default");
  assert.deepEqual(args.slice(0, 5), ["chat", "--no-interactive", "--v3", "--agent", AGENT]);
  assert.equal(args.includes("--trust-all-tools"), false);
  // The trust flag has no say here: the rules are in the config, and leaving the
  // old variable set must not quietly reopen anything.
  const stillRestricted = withEnv({ KIRO_PLUGIN_TRUST_ALL_TOOLS: "1" }, () => chatArgs("x", AGENT));
  assert.equal(stillRestricted.includes("--trust-all-tools"), false);
});

test("a v3 run without an agent is refused, not run unrestricted", () => {
  // An unknown or absent --agent makes kiro-cli warn on stderr and fall back to
  // its default agent, which can do anything. Building argv that would do that
  // is the bug, so it cannot be built.
  assert.throws(() => withEnv({ KIRO_PLUGIN_AGENT_ENGINE: null }, () => chatArgs("x")), /needs an agent config/);
});

test("only v2 is accepted as an opt-out; anything else is v3", () => {
  for (const v of [null, "v3", "V3", "", "nonsense", "3"]) {
    assert.equal(withEnv({ KIRO_PLUGIN_AGENT_ENGINE: v }, agentEngine), "v3", `engine changed for ${JSON.stringify(v)}`);
  }
  for (const v of ["v2", "V2", " v2 "]) {
    assert.equal(withEnv({ KIRO_PLUGIN_AGENT_ENGINE: v }, agentEngine), "v2", `engine not v2 for ${JSON.stringify(v)}`);
  }
});

// --- numeric settings ---

test("an unusable numeric setting falls back rather than collapsing to zero", () => {
  // Flooring after the guard turned any value in (0, 1) into 0, which zeroed
  // the output cap and made every timeout fire immediately.
  for (const v of ["0.5", "0", "-1", "abc", ""]) {
    assert.equal(withEnv({ KIRO_PLUGIN_MAX_OUTPUT_BYTES: v }, maxOutputBytes), 10 * 1024 * 1024, `bad fallback for ${JSON.stringify(v)}`);
    assert.equal(withEnv({ KIRO_PLUGIN_TIMEOUT_MS: v }, foregroundTimeoutMs), 300_000, `bad fallback for ${JSON.stringify(v)}`);
  }
  assert.equal(withEnv({ KIRO_PLUGIN_MAX_JOBS: "7" }, maxRetainedJobs), 7);
});

test("a value past the timer ceiling is clamped, not silently reverted", () => {
  // 2147483648 wrapped in setTimeout and fired at once, reporting a timeout
  // that never happened; 1e400 parses to Infinity and used to revert to default.
  const MAX = 2_147_483_647;
  assert.equal(withEnv({ KIRO_PLUGIN_BACKGROUND_TIMEOUT_MS: "2147483648" }, backgroundTimeoutMs), MAX);
  assert.equal(withEnv({ KIRO_PLUGIN_TIMEOUT_MS: "1e400" }, foregroundTimeoutMs), MAX);
});

test("a retention age longer than the timer ceiling is honoured", () => {
  // It is compared against a timestamp, never used as a delay, so the ceiling
  // must not apply -- it used to, capping retention at about 24.8 days.
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  assert.equal(withEnv({ KIRO_PLUGIN_JOB_TTL_MS: String(thirtyDays) }, jobTtlMs), thirtyDays);
});

// --- job ids ---

test("a job id that escapes the jobs directory is refused", () => {
  for (const id of ["../outside", "../../etc/passwd", "/etc/passwd", "..", "a/b", "a\0b", ""]) {
    assert.equal(isValidJobId(id), false, `accepted ${JSON.stringify(id)}`);
  }
  assert.equal(isValidJobId("kiro-mt5rn2bn-u5tv"), true);
});

// --- reconcile: what a "running" record really means on read ---

test("a running record with no pid is believed only inside the launch window", () => {
  // The launcher records a pid within milliseconds, so a pid-less record from
  // months ago means the launcher died in that window.
  const base = { id: "kiro-aaaa1111-aa", kind: "review", status: "running" };
  assert.equal(reconcile({ ...base, startedAt: NOW() }).status, "running");
  const stale = reconcile({ ...base, startedAt: AGO(10 * 60_000) });
  assert.equal(stale.status, "failed");
  assert.match(stale.note, /never started/);
  // finishedAt is left as stored: synthesizing "now" made one stale record look
  // like the most recently finished job on every read.
  assert.equal(stale.finishedAt, undefined);
});

test("a running record whose pid cannot be alive reads as failed", () => {
  // 2^22 is above the default pid_max, so it can never be live.
  const job = reconcile({
    id: "kiro-aaaa2222-aa", kind: "rescue", status: "running", startedAt: NOW(), pid: 4194304,
  });
  assert.equal(job.status, "failed");
  assert.match(job.note, /without recording a result/);
});

test("a running record whose pid belongs to somebody else says so", () => {
  // Alive, but plainly not our runner: the shape of a pre-reboot record whose
  // pid has been recycled. Calling that a crashed runner sent the reader after
  // the wrong thing -- and signalling it would have hit an unrelated process.
  const job = reconcile({
    id: "kiro-aaaa3333-aa", kind: "review", status: "running", startedAt: NOW(), pid: process.pid,
  });
  assert.equal(job.status, "failed");
  assert.match(job.note, /now belongs to another process/);
  assert.doesNotMatch(job.note, /killed or crashed/);
});

test("a future-dated record does not stay running, but ordinary jitter is tolerated", () => {
  const base = { id: "kiro-aaaa4444-aa", kind: "review", status: "running" };
  // Ordinary jitter between two machines, or between two reads.
  assert.equal(reconcile({ ...base, startedAt: new Date(Date.now() + 2_000).toISOString() }).status, "running");
  // A clock stepped backwards mid-flight. Every elapsed-time test used to come
  // out true, so the record stayed "running": uncancellable and unprunable.
  const ahead = new Date(Date.now() + 3_600_000).toISOString();
  assert.equal(reconcile({ ...base, startedAt: ahead }).status, "failed");
  assert.equal(reconcile({ ...base, startedAt: ahead, pid: 4194304 }).status, "failed");
});

test("a terminal record is returned untouched", () => {
  for (const status of ["completed", "failed", "cancelled"]) {
    const job = { id: "kiro-aaaa5555-aa", kind: "review", status, startedAt: AGO(60_000), finishedAt: AGO(30_000) };
    assert.deepEqual(reconcile(job), job);
  }
});
