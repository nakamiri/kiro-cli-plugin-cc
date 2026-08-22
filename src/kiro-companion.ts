import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Job, isPidAlive, listJobs, loadJob, loadJobRaw, pidCommandLine, pruneJobs, readJobResult, saveJob } from "./jobs.js";
import { backgroundTimeoutMs, chatArgs, findKiro, foregroundTimeoutMs, nodeBinary, trustAllTools } from "./kiro.js";

export type { Job };
export { getJobsDir, isPidAlive, listJobs, loadJob, loadJobRaw, pidCommandLine, pruneJobs, readJobResult, saveJob, saveJobResult } from "./jobs.js";
export { findKiro, nodeBinary, trustAllTools } from "./kiro.js";

const NOT_INSTALLED = "ERROR: kiro-cli is not installed or not in PATH. Run `/kiro-cli:setup` for help.";

function genId(): string {
  return `kiro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function buildReviewPrompt(args: string[]): string {
  let base = "HEAD";
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--background" || a === "--wait") continue;
    if (a === "--base") {
      const next = args[i + 1];
      // A flag is never a git ref: "--base --background" used to make
      // "--background" the ref while still detaching the job.
      if (next !== undefined && !next.startsWith("-")) {
        base = next;
        i++;
      }
      continue;
    }
    filtered.push(a);
  }
  const extra = filtered.join(" ").trim();
  let prompt = `Review the code changes. Compare against ${base}.`;
  if (extra) prompt += ` Focus on: ${extra}`;
  prompt += " Provide a thorough code review covering correctness, security, performance, and style.";
  return prompt;
}

export function buildRescuePrompt(args: string[]): string {
  const filtered = args.filter((a) => !["--background", "--wait"].includes(a));
  const task = filtered.join(" ").trim();
  return task || "Investigate and fix the current issue.";
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
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
  const job: Job = { id: genId(), kind, status: "running", startedAt: new Date().toISOString() };
  saveJob(job);
  // Once per job, which is the natural point to keep the store bounded.
  pruneJobs();

  const child = spawn(
    nodeBinary(),
    [runnerPath(), job.id, String(timeoutMs), kiro, ...chatArgs(prompt)],
    { stdio: "ignore", detached: true },
  );
  // spawn reports EAGAIN/EMFILE/EACCES asynchronously. Without a listener that
  // event is fatal, and it would fire after dispatch() had already returned --
  // outside its try/catch, so the command died with a stack trace.
  child.on("error", (err) => {
    try {
      // Re-read first. This can also fire after a successful spawn, and during
      // a foreground wait the runner may already have recorded a result --
      // writing the pre-spawn snapshot over it would discard the run.
      const current = loadJobRaw(job.id);
      if (current && current.status !== "running") return;
      saveJob({
        ...(current ?? job),
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
    saveJob(job);
  } catch (e) {
    // Without the pid on record the job is untrackable: cancel would report
    // success without signalling anything while Kiro edited the repository.
    // Stop it now rather than leave it running unattended.
    try { process.kill(-child.pid, "SIGKILL"); } catch {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    return `ERROR: started the Kiro runner but could not record it, so it was stopped: ${(e as Error).message}`;
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
  let seen = false;
  for (;;) {
    // Raw: the reconciling read runs a full identity probe, which forks ps on
    // every platform without /proc -- around 1500 times over a long review.
    // A dead runner is caught by the cheap liveness check below instead.
    let job = loadJobRaw(id);
    if (job) seen = true;
    else if (seen) {
      // It was there and now it is not -- pruning from a concurrent job start,
      // or somebody clearing the store. Waiting out the budget and calling it a
      // timeout would be a lie, and would throw away a run that had finished.
      return `ERROR: the record for job ${id} disappeared while waiting for it; its output is not available.`;
    }
    if (job && job.status === "running" && job.pid !== undefined && !isPidAlive(job.pid)) {
      job = loadJob(id);
    }
    if (job && job.status !== "running") {
      const body = readJobResult(id) ?? job.note ?? "";
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
  const info = {
    installed: !!kiro,
    path: kiro,
    version: null as string | null,
    runnable: false,
    trustAllTools: trustAllTools(),
    error: null as string | null,
  };
  if (kiro) {
    try {
      info.version = execFileSync(kiro, ["--version"], {
        encoding: "utf-8",
        timeout: 30_000,
        // Without this the timeout only sends SIGTERM and then keeps waiting.
        killSignal: "SIGKILL",
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
    : "tool trust disabled";
  return `✓ kiro-cli is ready\n  Path: ${info.path}\n  Version: ${info.version}\n  Tool trust: ${trust}`;
}

export function review(args: string[]): Promise<string> {
  return runKiro("review", buildReviewPrompt(args), hasFlag(args, "--background"));
}

export function rescue(args: string[]): Promise<string> {
  return runKiro("rescue", buildRescuePrompt(args), hasFlag(args, "--background"));
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
    const jobs = listJobs().filter((j) => j.status === "completed");
    if (jobs.length === 0) return "No completed jobs found.";
    const latest = jobs[0]!;
    return readJobResult(latest.id) ?? latest.note ?? "No result stored.";
  }
  const job = loadJob(id);
  if (!job) return `No job found with ID: ${id}`;
  if (job.status === "running") return `Job ${id} is still running. Use /kiro-cli:status to check progress.`;
  return readJobResult(id) ?? job.note ?? "No result stored.";
}

export function cancel(args: string[]): string {
  const id = args[0];
  let job: Job | null;
  if (!id) {
    const running = listJobs().filter((j) => j.status === "running");
    if (running.length === 0) return "No running jobs to cancel.";
    job = running[0]!;
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
  let signalled = false;
  if (isPidAlive(job.pid)) {
    // reconcile() rejects a pid that demonstrably belongs to something else, so
    // a recycled pid never reaches here -- but it treats an unreadable command
    // line as a match, because refusing on that basis would fail every healthy
    // job. That leaves identity unproven, and an unproven pid is not something
    // to send a signal to, let alone signal a whole group of.
    if (pidCommandLine(job.pid) === null) {
      // Signalling an unidentifiable pid could hit anything, but recording a
      // cancellation we did not perform is worse: Kiro would keep working under
      // --trust-all-tools while the user was told it had stopped, and its
      // result would be discarded when the runner found a terminal record.
      return (
        `Could not cancel job ${job.id}: its runner (pid ${job.pid}) cannot be identified on ` +
        `this platform, so no signal was sent and the job is still running.`
      );
    } else {
      try {
        // Negated pid: the runner leads the group, so kiro-cli stops with it.
        process.kill(-job.pid, "SIGTERM");
        signalled = true;
      } catch {
        try { process.kill(job.pid, "SIGTERM"); signalled = true; } catch { /* already dead */ }
      }
    }
  }

  if (signalled) {
    const settled = awaitRunnerRecord(job.id);
    // The runner got there first and kept the partial output; leave it alone.
    if (settled && settled.status !== "running") {
      return `Cancelled job ${job.id} (recorded as ${settled.status})`;
    }
  }
  // Nothing to signal, or the runner died without recording: record it here,
  // preserving whatever the stored record already holds.
  const base = loadJobRaw(job.id) ?? job;
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
  console.log(await dispatch(command, commandArgs));
}
