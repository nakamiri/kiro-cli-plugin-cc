import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Job, isPidAlive, listJobs, loadJob, pidCommandLine, saveJob } from "./jobs.js";
import { chatArgs, findKiro, foregroundTimeoutMs, maxOutputBytes, trustAllTools } from "./kiro.js";

export type { Job };
export { getJobsDir, isPidAlive, listJobs, loadJob, pidCommandLine, saveJob } from "./jobs.js";
export { findKiro, trustAllTools } from "./kiro.js";

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
      base = args[i + 1] ?? "HEAD";
      i++;
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

  const child = spawn(process.execPath, [runnerPath(), job.id, kiro, ...chatArgs(prompt)], {
    stdio: "ignore",
    detached: true,
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
  saveJob(job);
  return JSON.stringify({ jobId: job.id, status: "started" });
}

function runForeground(kiro: string, prompt: string): string {
  try {
    // execFile, not execSync: the prompt is never handed to a shell, so
    // $(...), backticks and quotes in it cannot be interpreted as syntax.
    return execFileSync(kiro, chatArgs(prompt), {
      encoding: "utf-8",
      timeout: foregroundTimeoutMs(),
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
  // loadJob/listJobs reconcile dead runners to "failed", so a job that still
  // reads "running" here has a live pid -- we never signal a recycled one.
  if (job.status !== "running") {
    return `Job ${job.id} is already ${job.status}; nothing to cancel.`;
  }
  let note = "";
  if (job.pid !== undefined && isPidAlive(job.pid)) {
    const cmd = pidCommandLine(job.pid);
    if (cmd !== null && !(cmd.includes("kiro-runner") && cmd.includes(job.id))) {
      // The pid was recycled by an unrelated process. Signalling it -- let
      // alone its whole process group -- would hit an innocent bystander.
      note = `\n  Note: pid ${job.pid} now belongs to another process; no signal was sent.`;
    } else if (cmd === null) {
      // Identity could not be confirmed, so use the narrowest possible signal.
      try { process.kill(job.pid, "SIGTERM"); } catch { /* already dead */ }
    } else {
      try {
        // Negated pid: the runner leads the group, so kiro-cli stops with it.
        process.kill(-job.pid, "SIGTERM");
      } catch {
        try { process.kill(job.pid, "SIGTERM"); } catch { /* already dead */ }
      }
    }
  }
  saveJob({ ...job, status: "cancelled", finishedAt: new Date().toISOString() });
  return `Cancelled job ${job.id}${note}`;
}

// --- Main ---

/**
 * Slash commands interpolate `$ARGUMENTS` into a shell command line, so the
 * script is reached either with one argument per token or with everything in a
 * single quoted argument. Splitting on whitespace makes the two equivalent, so
 * flags such as `--background` are recognised in both shapes.
 */
export function tokenizeArgs(args: string[]): string[] {
  return args.flatMap((a) => a.split(/\s+/)).filter((a) => a.length > 0);
}

export function dispatch(command: string | undefined, rawArgs: string[]): string {
  const args = tokenizeArgs(rawArgs);
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
