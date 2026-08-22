import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface Job {
  id: string;
  kind: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  result?: string;
  pid?: number;
}

/**
 * Job records hold Kiro's full output, which for a private repository is source
 * code and review commentary. The directory is therefore per-user and 0700 --
 * never the shared, world-readable default that `mkdir` would produce.
 */
export function getJobsDir(): string {
  if (process.env.KIRO_PLUGIN_JOBS_DIR) return process.env.KIRO_PLUGIN_JOBS_DIR;
  const uid = process.getuid?.();
  const suffix = uid === undefined ? (process.env.USERNAME || "user") : String(uid);
  return join(tmpdir(), `kiro-plugin-cc-jobs-${suffix}`);
}

export function ensureJobsDir(): string {
  const dir = getJobsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const uid = process.getuid?.();
  // Ownership and mode are only enforced for the directory the plugin picks
  // itself. An operator who points KIRO_PLUGIN_JOBS_DIR at a directory of
  // their own has already made that call, and silently chmod-ing a shared
  // directory out from under them would be worse than honouring it. Records
  // are written 0600 either way.
  if (uid !== undefined && !process.env.KIRO_PLUGIN_JOBS_DIR) {
    const st = statSync(dir);
    // A pre-created directory in the shared temp path would leak every result.
    if (st.uid !== uid) {
      throw new Error(`jobs directory ${dir} is owned by another user (uid ${st.uid}); refusing to use it`);
    }
    // `mkdir -p` leaves the mode of an existing directory alone.
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }
  return dir;
}

function jobPath(id: string): string {
  return join(getJobsDir(), `${id}.json`);
}

export function saveJob(job: Job): void {
  const dir = ensureJobsDir();
  const target = join(dir, `${job.id}.json`);
  // Write-then-rename: a reader never sees a half-written record.
  const tmp = join(dir, `.${job.id}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o600 });
    renameSync(tmp, target);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

/** Returns null for anything that is not a readable, well-formed job record. */
function readJobFile(path: string): Job | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const job = parsed as Partial<Job>;
  if (typeof job.id !== "string" || typeof job.kind !== "string" || typeof job.startedAt !== "string") return null;
  if (job.status !== "running" && job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") {
    return null;
  }
  return job as Job;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to another user.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** How long a record may claim "running" without ever having recorded a pid. */
const PIDLESS_GRACE_MS = 60_000;

/**
 * Best-effort command line for `pid`, or null when it cannot be determined.
 * Used to confirm a recorded pid is still our runner and not a recycled one
 * before any signal is sent.
 */
export function pidCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").filter(Boolean).join(" ");
  } catch {
    /* not Linux, or the process is gone */
  }
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * A job is marked completed by the detached runner itself. If the runner was
 * killed before it could do that, the record would claim "running" forever, so
 * report the truth on read instead. This is read-side only -- nothing is
 * rewritten, because the runner may still be the one holding the pid.
 */
export function reconcile(job: Job): Job {
  if (job.status !== "running") return job;
  if (job.pid === undefined) {
    // The launcher writes the record before it knows the runner's pid, so there
    // is nothing to check liveness against in that window. A record that never
    // gained a pid means the launcher died in it.
    const age = Date.now() - Date.parse(job.startedAt);
    if (!Number.isFinite(age) || age <= PIDLESS_GRACE_MS) return job;
    return {
      ...job,
      status: "failed",
      finishedAt: job.finishedAt ?? new Date().toISOString(),
      result: job.result ?? "ERROR: the job was never started (its launcher exited before recording a runner).",
    };
  }
  if (isPidAlive(job.pid)) return job;
  return {
    ...job,
    status: "failed",
    finishedAt: job.finishedAt ?? new Date().toISOString(),
    result: job.result ?? "ERROR: the Kiro runner exited without recording a result (killed or crashed).",
  };
}

/** The record exactly as stored, with no liveness interpretation applied. */
export function loadJobRaw(id: string): Job | null {
  return readJobFile(jobPath(id));
}

export function loadJob(id: string): Job | null {
  const job = readJobFile(jobPath(id));
  return job ? reconcile(job) : null;
}

export function listJobs(): Job[] {
  const dir = ensureJobsDir();
  const jobs: Job[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const job = readJobFile(join(dir, f));
    if (job) jobs.push(reconcile(job));
  }
  return jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
