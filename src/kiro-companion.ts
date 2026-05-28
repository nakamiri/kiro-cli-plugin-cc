import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface Job {
  id: string;
  kind: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  result?: string;
  pid?: number;
}

export function getJobsDir(): string {
  return process.env.KIRO_PLUGIN_JOBS_DIR || join(tmpdir(), "kiro-plugin-cc-jobs");
}

function ensureJobsDir(): void {
  const dir = getJobsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function genId(): string {
  return `kiro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function saveJob(job: Job): void {
  ensureJobsDir();
  writeFileSync(join(getJobsDir(), `${job.id}.json`), JSON.stringify(job, null, 2));
}

export function loadJob(id: string): Job | null {
  const p = join(getJobsDir(), `${id}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Job;
}

export function listJobs(): Job[] {
  ensureJobsDir();
  return readdirSync(getJobsDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(getJobsDir(), f), "utf-8")) as Job)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function findKiro(): string | null {
  if (process.env.KIRO_CLI_PATH) return process.env.KIRO_CLI_PATH;
  try {
    const p = execSync("which kiro-cli", { encoding: "utf-8" }).trim();
    return p || null;
  } catch {
    return null;
  }
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

function runKiro(args: string[], background = false): string {
  const kiro = findKiro();
  if (!kiro) {
    return "ERROR: kiro-cli is not installed or not in PATH. Run `/kiro:setup` for help.";
  }

  if (background) {
    const job: Job = { id: genId(), kind: args[0] ?? "task", status: "running", startedAt: new Date().toISOString() };
    saveJob(job);

    const prompt = args.join(" ");
    const child = spawn(kiro, ["chat", "--no-interactive", "--trust-all-tools", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    job.pid = child.pid;
    saveJob(job);

    let output = "";
    child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
    child.on("close", (code: number | null) => {
      job.status = code === 0 ? "completed" : "failed";
      job.finishedAt = new Date().toISOString();
      job.result = output;
      saveJob(job);
    });
    child.unref();

    return JSON.stringify({ jobId: job.id, status: "started" });
  }

  try {
    const prompt = args.join(" ");
    const result = execSync(`${kiro} chat --no-interactive --trust-all-tools ${JSON.stringify(prompt)}`, {
      encoding: "utf-8",
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result;
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return `ERROR: ${err.stderr || err.message || "kiro-cli failed"}`;
  }
}

// --- Commands ---

export function setup(args: string[]): string {
  const kiro = findKiro();
  const json = args.includes("--json");
  const info = {
    installed: !!kiro,
    path: kiro,
    version: null as string | null,
  };
  if (kiro) {
    try {
      info.version = execSync(`${kiro} --version`, { encoding: "utf-8" }).trim();
    } catch { /* ignore */ }
  }
  if (json) return JSON.stringify(info);
  if (!info.installed) return "❌ kiro-cli is not installed.\n\nSee https://kiro.dev to download and install Kiro CLI.";
  return `✓ kiro-cli is ready\n  Path: ${info.path}\n  Version: ${info.version ?? "unknown"}`;
}

export function review(args: string[]): string {
  const prompt = buildReviewPrompt(args);
  const bg = hasFlag(args, "--background");
  return runKiro([prompt], bg);
}

export function rescue(args: string[]): string {
  const bg = hasFlag(args, "--background");
  const task = buildRescuePrompt(args);
  return runKiro([task], bg);
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
  if (job.status === "running") return `Job ${id} is still running. Use /kiro:status to check progress.`;
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
  if (job.pid) {
    try { process.kill(job.pid); } catch { /* already dead */ }
  }
  job.status = "cancelled";
  job.finishedAt = new Date().toISOString();
  saveJob(job);
  return `Cancelled job ${job.id}`;
}

// --- Main ---

export function dispatch(command: string | undefined, args: string[]): string {
  switch (command) {
    case "setup": return setup(args);
    case "review": return review(args);
    case "rescue": case "task": return rescue(args);
    case "status": return status(args);
    case "result": return result(args);
    case "cancel": return cancel(args);
    default: return `Unknown command: ${command}\nUsage: kiro-companion <setup|review|rescue|status|result|cancel> [args...]`;
  }
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

// Also handle being invoked through the .mjs shim that imports this file.
function isMainOrShim(): boolean {
  if (isMain()) return true;
  // The .mjs shim lives one level up at scripts/kiro-companion.mjs
  if (!process.argv[1]) return false;
  try {
    const invoked = fileURLToPath(pathToFileURL(process.argv[1]).href);
    return invoked.endsWith("kiro-companion.mjs");
  } catch {
    return false;
  }
}

if (isMainOrShim()) {
  const [command, ...commandArgs] = process.argv.slice(2);
  console.log(dispatch(command, commandArgs));
}
