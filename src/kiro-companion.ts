import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Job, isPidAlive, listJobs, loadJob, loadJobRaw, pidCommandLine, saveJob } from "./jobs.js";
import { chatArgs, findKiro, foregroundTimeoutMs, maxOutputBytes, nodeBinary, trustAllTools } from "./kiro.js";

export type { Job };
export { getJobsDir, isPidAlive, listJobs, loadJob, loadJobRaw, pidCommandLine, saveJob } from "./jobs.js";
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
 * Starts Kiro in a detached supervisor process and returns immediately. The
 * supervisor -- not this process -- records the terminal job state, so the job
 * completes even if the caller exits the moment this returns.
 */
function startBackgroundJob(kind: string, kiro: string, prompt: string): string {
  const job: Job = { id: genId(), kind, status: "running", startedAt: new Date().toISOString() };
  saveJob(job);

  const child = spawn(nodeBinary(), [runnerPath(), job.id, kiro, ...chatArgs(prompt)], {
    stdio: "ignore",
    detached: true,
  });
  // spawn reports EAGAIN/EMFILE/EACCES asynchronously. Without a listener that
  // event is fatal, and it would fire after dispatch() had already returned --
  // outside its try/catch, so the command died with a stack trace.
  child.on("error", (err) => {
    try {
      saveJob({
        ...job,
        status: "failed",
        finishedAt: new Date().toISOString(),
        result: `ERROR: could not start the Kiro runner: ${err.message}`,
      });
    } catch {
      /* nothing more we can do from here */
    }
  });
  child.unref();

  if (child.pid === undefined) {
    saveJob({
      ...job,
      status: "failed",
      finishedAt: new Date().toISOString(),
      result: "ERROR: could not spawn the Kiro runner process.",
    });
    return JSON.stringify({ jobId: job.id, status: "failed" });
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
  return JSON.stringify({ jobId: job.id, status: "started" });
}

function runForeground(kiro: string, prompt: string): string {
  try {
    // execFile, not execSync: the prompt is never handed to a shell, so
    // $(...), backticks and quotes in it cannot be interpreted as syntax.
    return execFileSync(kiro, chatArgs(prompt), {
      encoding: "utf-8",
      timeout: foregroundTimeoutMs(),
      // Without this the timeout is advisory: execFileSync sends SIGTERM and
      // then goes on waiting, so a child that ignores it blocks indefinitely.
      killSignal: "SIGKILL",
      maxBuffer: maxOutputBytes(),
    });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    // kiro may have printed a complete review and still exited non-zero (or hit
    // the timeout). Returning only the error would throw that work away.
    const body = typeof err.stdout === "string" ? err.stdout : "";
    const reason = (typeof err.stderr === "string" ? err.stderr : "").trim() || err.message || "kiro-cli failed";
    return body ? `${body}\nERROR: ${reason}` : `ERROR: ${reason}`;
  }
}

function runKiro(kind: string, prompt: string, background: boolean): string {
  const kiro = findKiro();
  if (!kiro) return NOT_INSTALLED;
  return background ? startBackgroundJob(kind, kiro, prompt) : runForeground(kiro, prompt);
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
      info.version = execFileSync(kiro, ["--version"], { encoding: "utf-8", timeout: 30_000 }).trim();
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

export function review(args: string[]): string {
  return runKiro("review", buildReviewPrompt(args), hasFlag(args, "--background"));
}

export function rescue(args: string[]): string {
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
  return JSON.stringify(jobs.slice(0, 10), null, 2);
}

export function result(args: string[]): string {
  const id = args[0];
  if (!id) {
    const jobs = listJobs().filter((j) => j.status === "completed");
    if (jobs.length === 0) return "No completed jobs found.";
    return jobs[0]!.result ?? "No result stored.";
  }
  const job = loadJob(id);
  if (!job) return `No job found with ID: ${id}`;
  if (job.status === "running") return `Job ${id} is still running. Use /kiro-cli:status to check progress.`;
  return job.result ?? "No result stored.";
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
  let signalled = false;
  if (job.pid !== undefined && isPidAlive(job.pid)) {
    // reconcile() already refuses to call a job "running" when its pid demonstrably
    // belongs to something else, so a recycled pid never reaches this point. It
    // cannot rule out a pid whose command line is unreadable, though, and
    // signalling a whole group on an unverifiable pid is too broad.
    if (pidCommandLine(job.pid) === null) {
      try { process.kill(job.pid, "SIGTERM"); signalled = true; } catch { /* already dead */ }
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
export function dispatch(command: string | undefined, args: string[]): string {
  try {
    switch (command) {
      case "setup": return setup(args);
      case "review": return review(args);
      case "rescue": case "task": return rescue(args);
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
  console.log(dispatch(command, commandArgs));
}
