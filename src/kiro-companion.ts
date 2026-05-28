import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const JOBS_DIR = join(tmpdir(), "kiro-plugin-cc-jobs");

interface Job {
  id: string;
  kind: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  result?: string;
  pid?: number;
}

function ensureJobsDir(): void {
  if (!existsSync(JOBS_DIR)) mkdirSync(JOBS_DIR, { recursive: true });
}

function genId(): string {
  return `kiro-${Date.now().toString(36)}`;
}

function saveJob(job: Job): void {
  ensureJobsDir();
  writeFileSync(join(JOBS_DIR, `${job.id}.json`), JSON.stringify(job, null, 2));
}

function loadJob(id: string): Job | null {
  const p = join(JOBS_DIR, `${id}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Job;
}

function listJobs(): Job[] {
  ensureJobsDir();
  return readdirSync(JOBS_DIR)
    .filter((f: string) => f.endsWith(".json"))
    .map((f: string) => JSON.parse(readFileSync(join(JOBS_DIR, f), "utf-8")) as Job)
    .sort((a: Job, b: Job) => b.startedAt.localeCompare(a.startedAt));
}

function findKiro(): string | null {
  try {
    const p = execSync("which kiro-cli", { encoding: "utf-8" }).trim();
    return p || null;
  } catch {
    return null;
  }
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

function setup(args: string[]): string {
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

function review(args: string[]): string {
  const prompt = buildReviewPrompt(args);
  const bg = args.includes("--background");
  return runKiro([prompt], bg);
}

function buildReviewPrompt(args: string[]): string {
  const base = args.find((_, i, a) => a[i - 1] === "--base") ?? "HEAD";
  const filtered = args.filter(a => !["--background", "--wait", "--base"].includes(a) && a !== base);
  const extra = filtered.join(" ");
  let prompt = `Review the code changes. Compare against ${base}.`;
  if (extra) prompt += ` Focus on: ${extra}`;
  prompt += " Provide a thorough code review covering correctness, security, performance, and style.";
  return prompt;
}

function rescue(args: string[]): string {
  const bg = args.includes("--background");
  const filtered = args.filter(a => !["--background", "--wait"].includes(a));
  const task = filtered.join(" ") || "Investigate and fix the current issue.";
  return runKiro([task], bg);
}

function status(args: string[]): string {
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

function result(args: string[]): string {
  const id = args[0];
  if (!id) {
    const jobs = listJobs().filter(j => j.status === "completed");
    if (jobs.length === 0) return "No completed jobs found.";
    const latest = jobs[0]!;
    return latest.result ?? "No result stored.";
  }
  const job = loadJob(id);
  if (!job) return `No job found with ID: ${id}`;
  if (job.status === "running") return `Job ${id} is still running. Use /kiro:status to check progress.`;
  return job.result ?? "No result stored.";
}

function cancel(args: string[]): string {
  const id = args[0];
  if (!id) {
    const jobs = listJobs().filter(j => j.status === "running");
    if (jobs.length === 0) return "No running jobs to cancel.";
    const job = jobs[0]!;
    if (job.pid) {
      try { process.kill(job.pid); } catch { /* already dead */ }
    }
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
    saveJob(job);
    return `Cancelled job ${job.id}`;
  }
  const job = loadJob(id);
  if (!job) return `No job found with ID: ${id}`;
  if (job.pid) {
    try { process.kill(job.pid); } catch { /* already dead */ }
  }
  job.status = "cancelled";
  job.finishedAt = new Date().toISOString();
  saveJob(job);
  return `Cancelled job ${job.id}`;
}

// --- Main ---

const [command, ...commandArgs] = process.argv.slice(2);

switch (command) {
  case "setup": console.log(setup(commandArgs)); break;
  case "review": console.log(review(commandArgs)); break;
  case "rescue": case "task": console.log(rescue(commandArgs)); break;
  case "status": console.log(status(commandArgs)); break;
  case "result": console.log(result(commandArgs)); break;
  case "cancel": console.log(cancel(commandArgs)); break;
  default: console.log(`Unknown command: ${command}\nUsage: kiro-companion <setup|review|rescue|status|result|cancel> [args...]`);
}
