/**
 * Detached supervisor for a background Kiro run.
 *
 * The companion script spawns this module with `detached: true` and immediately
 * unrefs it, so the slash command returns at once. This process -- not the
 * caller -- owns the Kiro child and writes the terminal job record, which is
 * what makes a background job survive the caller exiting.
 *
 * Kiro is deliberately left in this process's group: `cancel` signals the group
 * by negated pid, and that is what stops kiro-cli along with the supervisor.
 *
 * Foreground runs go through it too: it is the only place that owns a process
 * group, so it is the only place that can guarantee a timeout takes kiro-cli's
 * descendants down with it.
 *
 * Usage: node kiro-runner.js <jobId> <timeoutMs> <kiroPath> [kiroArgs...]
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { loadJobRaw, saveJob, saveJobResult, type Job } from "./jobs.js";
import { maxOutputBytes } from "./kiro.js";

const [jobId, timeoutArg, kiroPath, ...kiroArgs] = process.argv.slice(2);

if (!jobId || !timeoutArg || !kiroPath) {
  console.error("kiro-runner: usage: kiro-runner.js <jobId> <timeoutMs> <kiroPath> [kiroArgs...]");
  process.exit(2);
}

// Validated like the rest of argv: an unusable value would reach setTimeout as
// NaN, which fires at once and reports a timeout that never happened.
const timeoutMs = Math.floor(Number(timeoutArg));
if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
  console.error(`kiro-runner: timeoutMs must be a positive integer, got ${timeoutArg}`);
  process.exit(2);
}

/**
 * kiro-cli may leave a descendant holding its stdout open after exiting, and
 * then EOF never arrives. Once the process itself has exited, wait only this
 * long for the pipes to drain before recording the result.
 */
const FLUSH_GRACE_MS = 2_000;

const maxBytes = maxOutputBytes();
let timedOut = false;
let finalized = false;
let bytes = 0;
let truncated = false;
const chunks: string[] = [];

function append(text: string, byteLength: number): void {
  if (truncated) return;
  const remaining = maxBytes - bytes;
  bytes += byteLength;
  if (bytes > maxBytes) {
    truncated = true;
    // Keep the part of this chunk that still fits. The budget is in bytes, so
    // slice the buffer, not the string -- one CJK character is three bytes.
    // The decoder drops a trailing partial sequence instead of emitting U+FFFD.
    if (remaining > 0) {
      chunks.push(new StringDecoder("utf-8").write(Buffer.from(text, "utf-8").subarray(0, remaining)));
    }
    chunks.push(`\n\n[output truncated at ${maxBytes} bytes]`);
    return;
  }
  chunks.push(text);
}

/**
 * Terminates anything still left in our process group, this process included.
 * Always run once the record is on disk: kiro-cli's descendants share this
 * group, and one that redirected its own stdio away is otherwise invisible --
 * it would outlive the supervisor unbounded under --trust-all-tools.
 */
function sweepGroup(): void {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    /* not a group leader, or nothing left */
  }
}

function finalize(status: Job["status"], result: string): void {
  if (finalized) return;
  finalized = true;
  // Re-read so a concurrent `cancel` that already set "cancelled" is not undone.
  // Raw, deliberately: the reconciled view reports a record that never got its
  // pid write as "failed", and this runner would then discard a finished run.
  // Guarded like the write below: this runs from the signal handler too, and a
  // throw here would lose both the record and the group teardown.
  let current: Job | null = null;
  try {
    current = loadJobRaw(jobId!);
  } catch (e) {
    console.error(`kiro-runner: could not read job ${jobId}: ${(e as Error).message}`);
    sweepGroup();
    process.exit(1);
  }
  if (current && current.status !== "running") {
    // Someone else recorded the outcome first -- most likely `cancel` after its
    // settle window. Still tear the group down, or a SIGTERM-ignoring kiro-cli
    // would be left with no supervisor and no timeout.
    sweepGroup();
    process.exit(0);
  }
  const job: Job = {
    id: jobId!,
    kind: current?.kind ?? "task",
    status,
    startedAt: current?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...(current?.pid !== undefined ? { pid: current.pid } : {}),
  };
  try {
    // Transcript first, then the record that advertises it: a reader must never
    // see a finished job whose output is not there yet.
    job.resultBytes = saveJobResult(jobId!, result);
    saveJob(job);
  } catch (e) {
    console.error(`kiro-runner: could not record job ${jobId}: ${(e as Error).message}`);
    // Failing to write the record is no reason to leave kiro-cli running on.
    sweepGroup();
    process.exit(1);
  }
  // The record is on disk before anything else in the group is torn down.
  sweepGroup();
  process.exit(0);
}

const child = spawn(kiroPath, kiroArgs, { stdio: ["ignore", "pipe", "pipe"] });

const timer = setTimeout(() => {
  timedOut = true;
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}, timeoutMs);

// setEncoding decodes through a StringDecoder, so a multi-byte character split
// across two pipe reads is not turned into replacement characters.
child.stdout?.setEncoding("utf-8");
child.stderr?.setEncoding("utf-8");
child.stdout?.on("data", (d: string) => append(d, Buffer.byteLength(d)));
child.stderr?.on("data", (d: string) => append(d, Buffer.byteLength(d)));
// A stream error would otherwise be an unhandled 'error' event, and this
// process must not die without tearing its group down.
child.stdout?.on("error", (err) => { append(`\n[stdout error: ${err.message}]\n`, 0); });
child.stderr?.on("error", (err) => { append(`\n[stderr error: ${err.message}]\n`, 0); });

let settled = false;

function settle(code: number | null, signal: NodeJS.Signals | null): void {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  const output = chunks.join("");
  if (timedOut) {
    finalize("failed", `${output}\n\nERROR: kiro-cli timed out after ${timeoutMs}ms.`);
    return;
  }
  if (signal) {
    finalize("failed", `${output}\n\nERROR: kiro-cli was terminated by ${signal}.`);
    return;
  }
  finalize(code === 0 ? "completed" : "failed", output);
}

let graceTimer: NodeJS.Timeout | undefined;

// "exit" is the authoritative signal that kiro-cli finished; "close" only tells
// us the pipes drained, which a lingering descendant can delay indefinitely.
child.on("exit", (code, signal) => {
  // Clear it here, not just in settle(): the grace timer delays settle() by up
  // to FLUSH_GRACE_MS, and a timeout expiring inside that window would relabel
  // an already-successful run as a timeout and sweep the group uninvited.
  clearTimeout(timer);
  graceTimer = setTimeout(() => settle(code, signal), FLUSH_GRACE_MS);
});

child.on("close", (code, signal) => {
  if (graceTimer) clearTimeout(graceTimer);
  settle(code, signal);
});

child.on("error", (err) => {
  clearTimeout(timer);
  if (graceTimer) clearTimeout(graceTimer);
  settled = true;
  // An error can also arrive after a successful spawn (for instance EPERM from
  // the timeout kill), so keep whatever kiro produced and sweep the group.
  const output = chunks.join("");
  const detail = `ERROR: could not run kiro-cli: ${err.message}`;
  finalize("failed", output ? `${output}\n\n${detail}` : detail);
});

// `cancel` signals this whole group; handling the signal lets us record the
// outcome instead of dying silently and leaving the job to be reconciled.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
    settled = true;
    finalize("cancelled", `${chunks.join("")}\n\n[cancelled]`);
  });
}

/**
 * Last line of defence. This process is the only supervisor kiro-cli has: if it
 * dies on an unexpected throw, kiro-cli and its descendants are left with no
 * timeout and no cancel target, running under --trust-all-tools. Record what we
 * can and take the group down with us.
 */
function bailOut(what: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kiro-runner: ${what}: ${message}`);
  try {
    finalize("failed", `${chunks.join("")}\n\nERROR: the Kiro supervisor failed (${what}): ${message}`);
  } catch {
    sweepGroup();
    process.exit(1);
  }
}

process.on("uncaughtException", (err) => { bailOut("uncaught exception", err); });
process.on("unhandledRejection", (err) => { bailOut("unhandled rejection", err); });
