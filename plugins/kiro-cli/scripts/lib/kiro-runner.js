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
 * Usage: node kiro-runner.js <jobId> <kiroPath> [kiroArgs...]
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { loadJobRaw, saveJob } from "./jobs.js";
import { backgroundTimeoutMs, maxOutputBytes } from "./kiro.js";
const [jobId, kiroPath, ...kiroArgs] = process.argv.slice(2);
if (!jobId || !kiroPath) {
    console.error("kiro-runner: usage: kiro-runner.js <jobId> <kiroPath> [kiroArgs...]");
    process.exit(2);
}
/**
 * kiro-cli may leave a descendant holding its stdout open after exiting, and
 * then EOF never arrives. Once the process itself has exited, wait only this
 * long for the pipes to drain before recording the result.
 */
const FLUSH_GRACE_MS = 2_000;
const timeoutMs = backgroundTimeoutMs();
const maxBytes = maxOutputBytes();
let timedOut = false;
let finalized = false;
let bytes = 0;
let truncated = false;
const chunks = [];
function append(text, byteLength) {
    if (truncated)
        return;
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
/** Terminates anything still left in our process group, this process included. */
function sweepGroup() {
    try {
        process.kill(-process.pid, "SIGKILL");
    }
    catch {
        /* not a group leader, or nothing left */
    }
}
function finalize(status, result, sweep = false) {
    if (finalized)
        return;
    finalized = true;
    // Re-read so a concurrent `cancel` that already set "cancelled" is not undone.
    // Raw, deliberately: the reconciled view reports a record that never got its
    // pid write as "failed", and this runner would then discard a finished run.
    const current = loadJobRaw(jobId);
    if (current && current.status !== "running") {
        // Someone else recorded the outcome first -- most likely `cancel` after its
        // settle window. Still tear the group down, or a SIGTERM-ignoring kiro-cli
        // would be left with no supervisor and no timeout.
        if (sweep)
            sweepGroup();
        process.exit(0);
    }
    const job = {
        id: jobId,
        kind: current?.kind ?? "task",
        status,
        startedAt: current?.startedAt ?? new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        result,
        ...(current?.pid !== undefined ? { pid: current.pid } : {}),
    };
    try {
        saveJob(job);
    }
    catch (e) {
        console.error(`kiro-runner: could not record job ${jobId}: ${e.message}`);
        // Still tear the group down when asked: failing to write the record is no
        // reason to leave a cancelled kiro-cli running unsupervised.
        if (sweep)
            sweepGroup();
        process.exit(1);
    }
    // The record is on disk before anything else in the group is torn down.
    if (sweep)
        sweepGroup();
    process.exit(0);
}
const child = spawn(kiroPath, kiroArgs, { stdio: ["ignore", "pipe", "pipe"] });
const timer = setTimeout(() => {
    timedOut = true;
    try {
        child.kill("SIGKILL");
    }
    catch { /* already gone */ }
}, timeoutMs);
// setEncoding decodes through a StringDecoder, so a multi-byte character split
// across two pipe reads is not turned into replacement characters.
child.stdout?.setEncoding("utf-8");
child.stderr?.setEncoding("utf-8");
child.stdout?.on("data", (d) => append(d, Buffer.byteLength(d)));
child.stderr?.on("data", (d) => append(d, Buffer.byteLength(d)));
let settled = false;
function settle(code, signal) {
    if (settled)
        return;
    settled = true;
    clearTimeout(timer);
    const output = chunks.join("");
    if (timedOut) {
        finalize("failed", `${output}\n\nERROR: kiro-cli timed out after ${timeoutMs}ms.`, true);
        return;
    }
    if (signal) {
        finalize("failed", `${output}\n\nERROR: kiro-cli was terminated by ${signal}.`);
        return;
    }
    finalize(code === 0 ? "completed" : "failed", output);
}
let graceTimer;
// "exit" is the authoritative signal that kiro-cli finished; "close" only tells
// us the pipes drained, which a lingering descendant can delay indefinitely.
child.on("exit", (code, signal) => {
    graceTimer = setTimeout(() => settle(code, signal), FLUSH_GRACE_MS);
});
child.on("close", (code, signal) => {
    if (graceTimer)
        clearTimeout(graceTimer);
    settle(code, signal);
});
child.on("error", (err) => {
    clearTimeout(timer);
    if (graceTimer)
        clearTimeout(graceTimer);
    settled = true;
    // An error can also arrive after a successful spawn (for instance EPERM from
    // the timeout kill), so keep whatever kiro produced and sweep the group.
    const output = chunks.join("");
    const detail = `ERROR: could not run kiro-cli: ${err.message}`;
    finalize("failed", output ? `${output}\n\n${detail}` : detail, true);
});
// `cancel` signals this whole group; handling the signal lets us record the
// outcome instead of dying silently and leaving the job to be reconciled.
for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
        clearTimeout(timer);
        if (graceTimer)
            clearTimeout(graceTimer);
        settled = true;
        // Sweep the group as the timeout path does: kiro-cli was signalled too, but
        // if it or a build/test grandchild ignores SIGTERM it would keep writing to
        // the repository under --trust-all-tools while the job reads "cancelled".
        finalize("cancelled", `${chunks.join("")}\n\n[cancelled]`, true);
    });
}
