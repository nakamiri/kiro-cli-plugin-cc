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
  if (uid !== undefined) {
    const st = statSync(dir);
    // A pre-created directory owned by somebody else would leak every result.
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

/**
 * A job is marked completed by the detached runner itself. If the runner was
 * killed before it could do that, the record would claim "running" forever, so
 * report the truth on read instead. This is read-side only -- nothing is
 * rewritten, because the runner may still be the one holding the pid.
 */
export function reconcile(job: Job): Job {
  if (job.status !== "running" || job.pid === undefined) return job;
  if (isPidAlive(job.pid)) return job;
  return {
    ...job,
    status: "failed",
    finishedAt: job.finishedAt ?? new Date().toISOString(),
    result: job.result ?? "ERROR: the Kiro runner exited without recording a result (killed or crashed).",
  };
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
