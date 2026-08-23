import { execFileSync, spawn } from "node:child_process";
import { readSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Job, type PidVerdict, classifyPid, isPidAlive, listJobs, loadJob, loadJobRaw, pruneJobs, readJobResult, saveJob } from "./jobs.js";
import { backgroundTimeoutMs, chatArgs, findKiro, foregroundTimeoutMs, nodeBinary, trustAllTools } from "./kiro.js";

export type { Job };
export { classifyPid, getJobsDir, isPidAlive, listJobs, loadJob, loadJobRaw, pidArgv, pruneJobs, readJobResult, saveJob, saveJobResult } from "./jobs.js";
export { findKiro, nodeBinary, trustAllTools } from "./kiro.js";

const NOT_INSTALLED = "ERROR: kiro-cli is not installed or not in PATH. Run `/kiro-cli:setup` for help.";

function genId(): string {
  return `kiro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class InvalidArgument extends Error {}

/**
 * Refs that are safe to put on a shell command line: no quotes, no `$`, no
 * backticks, no whitespace, no separators -- and no braces, because `v1.{0..2}`
 * is a brace expansion that becomes several words and would review against the
 * wrong ref. Wide enough for real revisions (`origin/main`, `v1.2.3`,
 * `HEAD~3`), narrow enough that quoting one cannot go wrong. The commands are
 * told to check this before building the command line; enforcing it here makes
 * the contract more than advice. Reflog syntax such as `HEAD@{1}` is the one
 * casualty, which is not a base anyone reviews against.
 */
const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$/;

export function isSafeRef(ref: string): boolean {
  return SAFE_REF_RE.test(ref);
}

/** Flags a review may legitimately be followed by where a ref was expected. */
const KNOWN_FLAGS = new Set(["--wait", "--background", "--base"]);

function requireSafeRef(ref: string): string {
  if (isSafeRef(ref)) return ref;
  throw new InvalidArgument(
    `${ref} is not a usable git ref. Use letters, digits and . _ / @ ^ ~ - only.`,
  );
}

/**
 * Everything after a bare `--` is literal text, never a flag or a flag's value.
 * Free-form text arrives that way (see readArgsFromStdin), so a task that
 * happens to read like an option -- or a `--base` with no ref of its own -- can
 * neither be parsed as one nor swallow the text as its argument.
 */
export function splitArgs(args: string[]): { flags: string[]; literal: string } {
  const sep = args.indexOf("--");
  if (sep === -1) return { flags: args, literal: "" };
  return { flags: args.slice(0, sep), literal: args.slice(sep + 1).join(" ") };
}

export function buildReviewPrompt(rawArgs: string[]): string {
  const { flags: args, literal } = splitArgs(rawArgs);
  let base = "HEAD";
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--background" || a === "--wait") continue;
    // --base=<ref> as well as --base <ref>: the joined form used to fall through
    // into the focus text while the compared ref silently stayed HEAD.
    if (a.startsWith("--base=")) {
      const value = a.slice("--base=".length);
      if (value !== "") base = requireSafeRef(value);
      continue;
    }
    if (a === "--base") {
      const next = args[i + 1];
      // Neither a flag nor an empty string is a git ref: "--base --background"
      // used to make "--background" the ref, and "--base ''" produced the
      // prompt "Compare against ." instead of falling back to HEAD.
      if (next !== undefined && next !== "" && !next.startsWith("-")) {
        base = requireSafeRef(next);
        i++;
      } else if (next !== undefined && next.startsWith("-") && !KNOWN_FLAGS.has(next)) {
        // Not a ref, and not a flag we know either. Left alone it silently kept
        // HEAD and reappeared in the focus text on the next iteration, while
        // the --base=<value> form rejected the very same input.
        requireSafeRef(next);
      }
      continue;
    }
    filtered.push(a);
  }
  const extra = [filtered.join(" ").trim(), literal.trim()].filter(Boolean).join(" ");
  let prompt = `Review the code changes. Compare against ${base}.`;
  // Terminated, so the focus text does not run into the next sentence of the
  // prompt -- but only when it does not already end a sentence itself, or
  // "why is auth slow?" became "why is auth slow?.".
  if (extra) prompt += /[.!?:;]$/.test(extra) ? ` Focus on: ${extra}` : ` Focus on: ${extra}.`;
  prompt += " Provide a thorough code review covering correctness, security, performance, and style.";
  return prompt;
}

/** The task text, or "" when none was given. Never a substitute for one. */
export function buildRescuePrompt(rawArgs: string[]): string {
  const { flags, literal } = splitArgs(rawArgs);
  const filtered = flags.filter((a) => !["--background", "--wait"].includes(a));
  return [filtered.join(" ").trim(), literal.trim()].filter(Boolean).join(" ");
}

export function hasFlag(args: string[], flag: string): boolean {
  // Only before the `--`: literal text that happens to read like a flag is not one.
  return splitArgs(args).flags.includes(flag);
}

/**
 * `--wait` wins over `--background`, which is the precedence the commands
 * document. It was parsed nowhere, so asking to wait and getting a detached
 * job was the actual behaviour.
 */
export function wantsBackground(args: string[]): boolean {
  return hasFlag(args, "--background") && !hasFlag(args, "--wait");
}

/**
 * A signalled runner records its own outcome, including the output it had
 * captured. Give it a moment to do so rather than overwriting it from here.
 */
const CANCEL_SETTLE_MS = 2_000;
const CANCEL_POLL_MS = 50;

/** The command surface is synchronous, so the wait has to be too. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function awaitRunnerRecord(id: string): Job | null {
  const deadline = Date.now() + CANCEL_SETTLE_MS;
  for (;;) {
    const fresh = loadJobRaw(id);
    if (!fresh || fresh.status !== "running") return fresh;
    if (Date.now() >= deadline) return fresh;
    sleepSync(CANCEL_POLL_MS);
  }
}

function runnerPath(): string {
  return fileURLToPath(new URL("./kiro-runner.js", import.meta.url));
}

/**
 * Starts Kiro under a detached supervisor and returns the job, or an error
 * string. Both execution modes go through here: the supervisor owns a process
 * group, which is the only way a timeout can take kiro-cli's descendants with
 * it, and the only way a job survives the caller exiting.
 */
function startRunner(kind: string, kiro: string, prompt: string, timeoutMs: number): Job | string {
  const job: Job = { id: genId(), kind, status: "running", startedAt: new Date().toISOString(), timeoutMs };
  saveJob(job);
  // Once per job, which is the natural point to keep the store bounded.
  pruneJobs();

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      nodeBinary(),
      [runnerPath(), job.id, String(timeoutMs), kiro, ...chatArgs(prompt)],
      { stdio: "ignore", detached: true },
    );
  } catch (e) {
    // spawn does not only report failures asynchronously: an over-long argument
    // throws E2BIG right here, which --args-stdin makes easy to reach. Without
    // this the pre-spawn record sat "running" with no pid -- a phantom job for
    // the whole pidless window, refused by cancel as "still starting".
    const detail =
      `ERROR: could not start the Kiro runner: ${(e as Error).message}` +
      (((e as NodeJS.ErrnoException).code === "E2BIG")
        ? ` The prompt is ${Buffer.byteLength(prompt)} bytes, which is too long to pass to a command.`
        : "");
    saveJob({ ...job, status: "failed", finishedAt: new Date().toISOString(), note: detail });
    return detail;
  }
  // spawn reports EAGAIN/EMFILE/EACCES asynchronously. Without a listener that
  // event is fatal, and it would fire after dispatch() had already returned --
  // outside its try/catch, so the command died with a stack trace.
  child.on("error", (err) => {
    try {
      // Re-read first. This can also fire after a successful spawn, and during
      // a foreground wait the runner may already have recorded a result --
      // writing the pre-spawn snapshot over it would discard the run.
      const current = loadJobRaw(job.id);
      // Gone means somebody removed it; re-creating it would invent a job, which
      // is the policy the runner's finalize states and enforces.
      if (current === null || current.status !== "running") return;
      saveJob({
        ...current,
        status: "failed",
        finishedAt: new Date().toISOString(),
        note: `ERROR: could not start the Kiro runner: ${err.message}`,
      });
    } catch {
      /* nothing more we can do from here */
    }
  });
  child.unref();

  if (child.pid === undefined) {
    const detail = "ERROR: could not spawn the Kiro runner process.";
    saveJob({ ...job, status: "failed", finishedAt: new Date().toISOString(), note: detail });
    return detail;
  }

  // The runner is its own process group leader, so cancel can signal the group.
  job.pid = child.pid;
  try {
    // Re-read first, like the error handler above: a fast run can finalize
    // before this write lands, and the pre-spawn snapshot would then replace a
    // terminal record with "running" and a dead pid -- reporting a completed
    // review as failed. A read that fails is not an answer either way, so it
    // falls through to the write rather than to the "removed" branch below,
    // which would kill a perfectly healthy runner.
    let current: Job | null = null;
    try {
      current = loadJobRaw(job.id);
    } catch {
      saveJob(job);
      return job;
    }
    if (current !== null && current.status !== "running") return current;
    if (current === null) {
      // Removed between the first write and this one. Writing it back would
      // resurrect a job nobody is tracking, so stop the runner instead.
      try { process.kill(-child.pid, "SIGKILL"); } catch {
        try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      return `ERROR: the record for job ${job.id} was removed while it was starting, so the run was stopped.`;
    }
    saveJob(job);
  } catch (e) {
    // Without the pid on record the job is untrackable: cancel would report
    // success without signalling anything while Kiro edited the repository.
    // Stop it now rather than leave it running unattended.
    try { process.kill(-child.pid, "SIGKILL"); } catch {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    const detail = `ERROR: started the Kiro runner but could not record it, so it was stopped: ${(e as Error).message}`;
    // Leave a terminal record, as the two sibling spawn-failure paths do.
    // Without it the pre-spawn record stayed a pid-less "running": a phantom job
    // in status for the whole launch window, refused by cancel as "still
    // starting", exempt from every retention budget, and finally reconciled with
    // a "never started" note that was not what happened.
    try {
      saveJob({ ...job, pid: undefined, status: "failed", finishedAt: new Date().toISOString(), note: detail });
    } catch {
      /* the store is what failed in the first place */
    }
    return detail;
  }
  return job;
}

/** Slack over the runner's own budget before this side stops waiting. */
const FOREGROUND_WAIT_SLACK_MS = 10_000;
const FOREGROUND_POLL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Waits asynchronously on purpose. A synchronous wait (Atomics.wait) never
 * yields to the event loop, so the runner -- still a child of this process in
 * the foreground -- is never reaped: it lingers as a zombie, kill(pid, 0) keeps
 * succeeding, and a runner that died without recording anything would hold the
 * caller for the whole budget before reporting a timeout that never happened.
 */
async function awaitResult(id: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs + FOREGROUND_WAIT_SLACK_MS;
  for (;;) {
    // Raw: the reconciling read runs a full identity probe, which forks ps on
    // every platform without /proc -- around 1500 times over a long review.
    // A dead runner is caught by the cheap liveness check below instead.
    let job: Job | null;
    try {
      job = loadJobRaw(id);
    } catch {
      // Transient: one failed read is not the record going away, and giving up
      // here abandoned a run that was progressing normally.
      await sleep(FOREGROUND_POLL_MS);
      continue;
    }
    if (!job) {
      // startRunner writes the record before this is ever reached, so a missing
      // one means it went away -- pruning from a concurrent job start, or
      // somebody clearing the store. Tracking whether we had seen it first only
      // meant a record already gone on the first poll fell through to the
      // deadline and reported a timeout that never happened.
      return `ERROR: the record for job ${id} disappeared while waiting for it; its output is not available.`;
    }
    if (job && job.status === "running" && job.pid !== undefined && !isPidAlive(job.pid)) {
      job = loadJob(id);
    }
    if (job && job.status !== "running") {
      const body = readJobResult(id) || job.note || "";
      if (job.status === "completed") return body || "No output was recorded.";
      // Keep whatever Kiro produced -- it may be a complete review -- but do
      // not let a failed run read like a successful one.
      const detail = `ERROR: kiro-cli did not complete: job ${id} is ${job.status}.`;
      return body ? `${body}\n\n${detail}` : detail;
    }
    if (Date.now() >= deadline) {
      return `ERROR: Kiro did not finish within ${timeoutMs}ms. It is recorded as job ${id}; check /kiro-cli:status.`;
    }
    await sleep(FOREGROUND_POLL_MS);
  }
}

async function runKiro(kind: string, prompt: string, background: boolean): Promise<string> {
  const kiro = findKiro();
  if (!kiro) return NOT_INSTALLED;
  const timeoutMs = background ? backgroundTimeoutMs() : foregroundTimeoutMs();
  const started = startRunner(kind, kiro, prompt, timeoutMs);
  if (typeof started === "string") return started;
  if (background) return JSON.stringify({ jobId: started.id, status: "started" });
  return awaitResult(started.id, timeoutMs);
}

// --- Commands ---

export function setup(args: string[]): string {
  const kiro = findKiro();
  const json = args.includes("--json");
  const foreground = foregroundTimeoutMs();
  const info = {
    installed: !!kiro,
    path: kiro,
    version: null as string | null,
    runnable: false,
    trustAllTools: trustAllTools(),
    foregroundTimeoutMs: foreground,
    // What a caller must allow a foreground run, budget plus this side's own
    // slack. Reported rather than left to the commands to hard-code, since
    // KIRO_PLUGIN_TIMEOUT_MS is configurable and a stale literal would have the
    // caller kill the run before it could report anything.
    recommendedBashTimeoutMs: foreground + FOREGROUND_WAIT_SLACK_MS + 10_000,
    error: null as string | null,
  };
  if (kiro) {
    try {
      info.version = execFileSync(kiro, ["--version"], {
        encoding: "utf-8",
        timeout: 30_000,
        // Without this the timeout only sends SIGTERM and then keeps waiting.
        killSignal: "SIGKILL",
        // execFileSync echoes the child's stderr to ours unless stdio is given,
        // so a kiro-cli that warns on --version polluted this command's output.
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      info.runnable = true;
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      info.error = (err.stderr || err.message || "unknown error").trim();
    }
  }
  if (json) return JSON.stringify(info);
  if (!info.installed) return "❌ kiro-cli is not installed.\n\nSee https://kiro.dev to download and install Kiro CLI.";
  // A path that resolves but cannot be executed is not "ready" -- say so.
  if (!info.runnable) {
    return `❌ kiro-cli was found at ${info.path} but could not be run.\n  Error: ${info.error}\n\nCheck the path (KIRO_CLI_PATH) and that the file is executable.`;
  }
  const trust = info.trustAllTools
    ? "all tools trusted (set KIRO_PLUGIN_TRUST_ALL_TOOLS=0 to disable)"
    : "no tool trust -- Kiro runs non-interactively, so it can analyse but not change anything";
  return (
    `✓ kiro-cli is ready\n  Path: ${info.path}\n  Version: ${info.version}\n` +
    `  Tool trust: ${trust}\n` +
    `  Foreground budget: ${info.foregroundTimeoutMs}ms ` +
    `(allow ${info.recommendedBashTimeoutMs}ms for a foreground run)`
  );
}

export function review(args: string[]): Promise<string> {
  return runKiro("review", buildReviewPrompt(args), wantsBackground(args));
}

export async function rescue(args: string[]): Promise<string> {
  const task = buildRescuePrompt(args);
  if (task === "") {
    // It used to fall back to "Investigate and fix the current issue." and hand
    // that to Kiro under --trust-all-tools: a fabricated task, with the
    // repository writable, standing in for one the user never gave.
    return "ERROR: no task was given. Say what Kiro should investigate or fix.";
  }
  return runKiro("rescue", task, wantsBackground(args));
}

export function status(args: string[]): string {
  const id = args[0];
  if (id) {
    const job = loadJob(id);
    if (!job) return `No job found with ID: ${id}`;
    return JSON.stringify(job, null, 2);
  }
  const jobs = listJobs();
  if (jobs.length === 0) return "No Kiro jobs found.";
  // Records carry only metadata and a short note, so this stays small however
  // large the transcripts behind them are. /kiro-cli:result hands those over.
  return JSON.stringify(jobs.slice(0, 10), null, 2);
}

export function result(args: string[]): string {
  const id = args[0];
  if (!id) {
    // Any finished run, not just a successful one. Filtering to "completed"
    // meant that after a failed run this quietly handed back an *older* run's
    // transcript, and the failed one was unreachable without its id.
    // listJobs orders by startedAt; what matters here is which run finished
    // last, or two overlapping background jobs hand back the stale transcript.
    const jobs = listJobs()
      .filter((j) => j.status !== "running")
      .sort((a, b) => Date.parse(b.finishedAt ?? b.startedAt) - Date.parse(a.finishedAt ?? a.startedAt));
    if (jobs.length === 0) return "No finished jobs found.";
    const latest = jobs[0]!;
    // `||`, not `??`: a run that printed nothing stores an empty transcript,
    // and returning it verbatim made /kiro-cli:result print a blank line.
    const body = readJobResult(latest.id) || latest.note || "No output was recorded.";
    if (latest.status === "completed") return body;
    return `[job ${latest.id} (${latest.kind}) ${latest.status}]\n\n${body}`;
  }
  const job = loadJob(id);
  if (!job) return `No job found with ID: ${id}`;
  if (job.status === "running") return `Job ${id} is still running. Use /kiro-cli:status to check progress.`;
  const body = readJobResult(id) || job.note || "No output was recorded.";
  // Same provenance line as the no-id path: presented bare, a partial
  // transcript from an aborted run reads as a finished review.
  if (job.status === "completed") return body;
  return `[job ${job.id} (${job.kind}) ${job.status}]\n\n${body}`;
}

export function cancel(args: string[]): string {
  const id = args[0];
  let job: Job | null;
  if (!id) {
    const running = listJobs().filter((j) => j.status === "running");
    if (running.length === 0) return "No running jobs to cancel.";
    // Prefer one that can actually be cancelled. A launcher record that never
    // recorded a pid is the newest for up to a minute, and picking it blocked
    // cancelling an older job that really was running.
    job = running.find((j) => j.pid !== undefined) ?? running[0]!;
  } else {
    job = loadJob(id);
    if (!job) return `No job found with ID: ${id}`;
  }
  // loadJob/listJobs reconcile a dead or never-started runner to "failed", so a
  // job that still reads "running" here has a live pid or is inside the launch
  // window -- either way we are not about to signal a stale one.
  if (job.status !== "running") {
    return `Job ${job.id} is already ${job.status}; nothing to cancel.`;
  }
  if (job.pid === undefined) {
    // Inside the launch window: the launcher has written the record but has not
    // reported a runner yet. Claiming a cancellation we cannot perform would
    // leave Kiro working while the user believed it had stopped.
    return `Could not cancel job ${job.id}: it is still starting and has no runner recorded yet. Try again in a moment.`;
  }

  const pid = job.pid;

  /**
   * What the pid is right now. "gone" and "dead" both mean the runner is no
   * longer doing anything -- the second is a zombie, which isPidAlive still
   * reports as alive and which in a container is the usual state of a runner
   * that was just killed. They are grouped with "foreign" throughout: in none
   * of the three is there anything left to signal.
   */
  const state = (): PidVerdict | "gone" => (isPidAlive(pid) ? classifyPid(pid, job.id) : "gone");
  const finished = (v: PidVerdict | "gone"): boolean => v === "gone" || v === "dead" || v === "foreign";

  const before = state();
  if (before === "unknown") {
    // Signalling an unidentifiable pid could hit anything, but recording a
    // cancellation we did not perform is worse: Kiro would keep working under
    // --trust-all-tools while the user was told it had stopped, and its result
    // would be discarded when the runner found a terminal record.
    return (
      `Could not cancel job ${job.id}: its runner (pid ${pid}) cannot be identified on ` +
      `this platform, so no signal was sent and the job is still running.`
    );
  }

  if (before === "ours") {
    // Negated pid: the runner leads the group, so kiro-cli stops with it.
    let signalError = "";
    let signalled = false;
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGTERM");
        signalled = true;
        break;
      } catch (e) {
        // EPERM, for instance: a runner belonging to another user, which
        // isPidAlive reports as alive. Not something to paper over.
        signalError = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
      }
    }
    if (!signalled) {
      return (
        `Could not cancel job ${job.id}: signalling its runner (pid ${pid}) was refused` +
        `${signalError ? ` (${signalError})` : ""}; it is still running.`
      );
    }

    // The runner records its own outcome, keeping the output captured so far.
    let settled = awaitRunnerRecord(job.id);
    if (settled && settled.status !== "running") {
      return `Cancelled job ${job.id} (recorded as ${settled.status})`;
    }

    // No terminal record inside the settle window, so do not assume the SIGTERM
    // landed: escalate and check.
    const after = state();
    if (after === "ours") {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, "SIGKILL");
          break;
        } catch {
          /* try the narrower target, then give up */
        }
      }
      settled = awaitRunnerRecord(job.id);
      if (settled && settled.status !== "running") {
        return `Cancelled job ${job.id} (recorded as ${settled.status})`;
      }
      const final = state();
      if (final === "unknown") {
        // The probe lost this time. It may well be dead, but saying either that
        // it is still alive or that the job was cancelled would be a guess.
        return (
          `Could not cancel job ${job.id}: its runner (pid ${pid}) could not be verified after ` +
          `SIGKILL, so nothing was recorded; it may already have stopped.`
        );
      }
      if (!finished(final)) {
        return (
          `Could not cancel job ${job.id}: its runner (pid ${pid}) is still alive after ` +
          `SIGTERM and SIGKILL. The job is left running.`
        );
      }
    } else if (after === "unknown") {
      // The probe failed this time round -- it forks ps on platforms without
      // /proc and can lose under load. Unverified is not cancelled.
      return (
        `Could not cancel job ${job.id}: its runner (pid ${pid}) could not be verified after ` +
        `the signal, so nothing was recorded; it may still be running.`
      );
    }
  }

  // Signalled but not yet recorded, or the runner is already gone: record it
  // here, preserving whatever the stored record holds.
  const base = loadJobRaw(job.id);
  if (base === null) {
    // Removed during the settle window. Re-creating it would invent a job.
    return `Job ${job.id} no longer exists; nothing was recorded.`;
  }
  if (base.status !== "running") {
    return `Job ${job.id} is already ${base.status}; nothing to cancel.`;
  }
  saveJob({ ...base, status: "cancelled", finishedAt: new Date().toISOString() });
  return `Cancelled job ${job.id}`;
}

// --- Main ---

/**
 * Arguments are compared and forwarded as whole argv entries, never re-split.
 * Splitting on whitespace would make prompt text that merely mentions a flag
 * ("make --background the default") act as that flag, and would flatten the
 * newlines and indentation of a multi-line task description.
 */
export async function dispatch(command: string | undefined, args: string[]): Promise<string> {
  try {
    switch (command) {
      case "setup": return setup(args);
      case "review": return await review(args);
      case "rescue": case "task": return await rescue(args);
      case "status": return status(args);
      case "result": return result(args);
      case "cancel": return cancel(args);
      default: return `Unknown command: ${command}\nUsage: kiro-companion <setup|review|rescue|status|result|cancel> [args...]`;
    }
  } catch (e) {
    // Slash commands render stdout, so a stack trace on stderr would be invisible.
    return `ERROR: ${(e as Error).message}`;
  }
}

const ARGS_STDIN_FLAG = "--args-stdin";
const STDIN_EAGAIN_BUDGET_MS = 5_000;

/** Reads fd 0 to EOF, tolerating a non-blocking pipe. */
function readAllStdin(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(64 * 1024);
  // Budgets the current stall, not the whole read: a writer that pauses part way
  // through a long body would otherwise lose everything already received.
  let deadline = Date.now() + STDIN_EAGAIN_BUDGET_MS;
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // A pipe that is momentarily empty and non-blocking. Not an error yet.
      if (code === "EAGAIN") {
        if (Date.now() >= deadline) throw new Error("timed out waiting for input on stdin");
        sleepSync(10);
        continue;
      }
      if (code === "EOF") break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
    deadline = Date.now() + STDIN_EAGAIN_BUDGET_MS;
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Slash commands can only interpolate their arguments into a shell command
 * line, and getting free-form text through that intact is entirely down to
 * quoting it correctly -- one apostrophe in "don't break the build" unbalances
 * it, and the rest is word-split and expanded with no permission prompt because
 * the Bash rule is pre-approved. With this flag the text arrives on stdin
 * instead, where nothing can reinterpret it, and only flags stay in argv.
 *
 * It is appended after a `--` so that it cannot be read as a flag or taken as
 * one's value. A read that fails is reported, never silently dropped: `rescue`
 * would otherwise fall back to its generic "investigate the current issue"
 * task and hand that to Kiro with full tool trust.
 *
 * Returns the arguments to dispatch, or an error string to print instead.
 */
function readArgsFromStdin(args: string[]): string[] | string {
  if (!args.includes(ARGS_STDIN_FLAG)) return args;
  const rest = args.filter((a) => a !== ARGS_STDIN_FLAG);
  if (process.stdin.isTTY) {
    return `ERROR: ${ARGS_STDIN_FLAG} was given but stdin is a terminal; pass the text in on stdin.`;
  }
  let text: string;
  try {
    text = readAllStdin();
  } catch (e) {
    return `ERROR: could not read arguments from stdin: ${(e as Error).message}`;
  }
  const trimmed = text.replace(/\n+$/, "");
  return trimmed === "" ? rest : [...rest, "--", trimmed];
}

function isMainOrShim(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    const href = pathToFileURL(invoked).href;
    if (import.meta.url === href) return true;
    // The .mjs shim lives one level up at scripts/kiro-companion.mjs
    return fileURLToPath(href).endsWith("kiro-companion.mjs");
  } catch {
    return false;
  }
}

if (isMainOrShim()) {
  const [command, ...commandArgs] = process.argv.slice(2);
  const parsed = readArgsFromStdin(commandArgs);
  console.log(typeof parsed === "string" ? parsed : await dispatch(command, parsed));
}
