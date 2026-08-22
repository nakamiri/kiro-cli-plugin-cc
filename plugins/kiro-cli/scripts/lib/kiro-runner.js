/**
 * Detached supervisor for a background Kiro run.
 *
 * The companion script spawns this module with `detached: true` and immediately
 * unrefs it, so the slash command returns at once. This process -- not the
 * caller -- owns the Kiro child and writes the terminal job record, which is
 * what makes a background job survive the caller exiting.
 *
 * Usage: node kiro-runner.js <jobId> <kiroPath> [kiroArgs...]
 */
import { spawn } from "node:child_process";
import { loadJob, saveJob } from "./jobs.js";
import { backgroundTimeoutMs, MAX_OUTPUT_BYTES } from "./kiro.js";
const [jobId, kiroPath, ...kiroArgs] = process.argv.slice(2);
if (!jobId || !kiroPath) {
    console.error("kiro-runner: usage: kiro-runner.js <jobId> <kiroPath> [kiroArgs...]");
    process.exit(2);
}
const timeoutMs = backgroundTimeoutMs();
let timedOut = false;
let finalized = false;
let bytes = 0;
let truncated = false;
const chunks = [];
function append(chunk) {
    if (truncated)
        return;
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        chunks.push(`\n\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`);
        return;
    }
    chunks.push(chunk.toString());
}
function finalize(status, result) {
    if (finalized)
        return;
    finalized = true;
    // Re-read so a concurrent `cancel` that already set "cancelled" is not undone.
    const current = loadJob(jobId);
    if (current && current.status !== "running")
        process.exit(0);
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
        process.exit(1);
    }
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
child.stdout?.on("data", append);
child.stderr?.on("data", append);
child.on("error", (err) => {
    clearTimeout(timer);
    finalize("failed", `ERROR: could not run kiro-cli: ${err.message}`);
});
child.on("close", (code) => {
    clearTimeout(timer);
    const output = chunks.join("");
    if (timedOut) {
        finalize("failed", `${output}\n\nERROR: kiro-cli timed out after ${timeoutMs}ms.`);
        return;
    }
    finalize(code === 0 ? "completed" : "failed", output);
});
