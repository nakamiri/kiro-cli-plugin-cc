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
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { loadJobRaw, saveJob, saveJobResult } from "./jobs.js";
import { flushGraceMs, maxOutputBytes } from "./kiro.js";
import { installAgent, isKind, removeAgent } from "./agents.js";
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
 * The run's agent config, on the v3 engine. This process installs it and this
 * process removes it: it is the only one that lives for exactly as long as
 * kiro-cli does, so anywhere else the file would either appear before it was
 * needed or outlast the run that owned it. Every terminal path goes through
 * teardown(), including the signal handlers and the last-resort bail-out, so a
 * cancelled or timed-out run leaves the working directory as it found it.
 */
let installedAgent;
function agentTeardown() {
    if (installedAgent === undefined)
        return;
    const done = installedAgent;
    installedAgent = undefined;
    removeAgent(done);
}
/**
 * kiro-cli may leave a descendant holding its stdout open after exiting, and
 * then EOF never arrives. Once the process itself has exited, wait only this
 * long for the pipes to drain before recording the result.
 */
const FLUSH_GRACE_MS = flushGraceMs();
const maxBytes = maxOutputBytes();
let timedOut = false;
let finalized = false;
let bytes = 0;
let truncated = false;
const chunks = [];
const streamErrors = [];
/** The captured output, with any stream diagnostics appended verbatim. */
function collected() {
    const body = chunks.join("");
    if (streamErrors.length === 0)
        return body;
    return `${body}\n\n[${streamErrors.join("; ")}]`;
}
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
/** Set once the child exists, for sweepGroup's fallback below. */
let spawned;
/**
 * Terminates anything still left in our process group, this process included.
 * Always run once the record is on disk: kiro-cli's descendants share this
 * group, and one that redirected its own stdio away is otherwise invisible --
 * it would outlive the supervisor unbounded under --trust-all-tools.
 */
/**
 * Whether this process leads its own process group. The launcher spawns the
 * runner detached, so it does -- but run directly (debugging, or any future
 * non-detached caller) it does not, and signalling the negated pid would then
 * SIGKILL the caller's whole group: an interactive shell, or everything a Bash
 * tool started. Unknown counts as no.
 */
function leadsOwnGroup() {
    // The launcher sets this because it is the one that passed `detached: true`,
    // which is what makes this process a group leader. Asked rather than measured,
    // because measuring is what went wrong: the probes below are the only way to
    // find out from in here, and the `ps` fallback is a fork on a machine that is,
    // by the time teardown runs, as busy as the run made it. A failed probe
    // defaulted to "no", which skips the group kill entirely and leaves a
    // descendant kiro-cli running with no supervisor. The env is authoritative
    // where it is set; a runner started any other way still measures, which is
    // what keeps a directly-invoked runner from signalling its caller's group.
    if (process.env.KIRO_PLUGIN_RUNNER_DETACHED === "1")
        return true;
    try {
        const stat = readFileSync(`/proc/${process.pid}/stat`, "utf-8");
        // Fields after comm: state, ppid, pgrp, ...
        const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
        const pgrp = Number(fields[2]);
        if (Number.isInteger(pgrp))
            return pgrp === process.pid;
    }
    catch {
        /* not Linux */
    }
    try {
        const out = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
            encoding: "utf-8",
            timeout: 5_000,
            killSignal: "SIGKILL",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return Number(out) === process.pid;
    }
    catch {
        return false;
    }
}
function sweepGroup() {
    // Before the group kill, not after: that kill includes this process, so
    // anything left until later would never run. Every path that ends this
    // process goes through here, which is what makes the config's lifetime the
    // run's lifetime -- completed, failed, cancelled, timed out or bailed out.
    agentTeardown();
    let swept = false;
    if (leadsOwnGroup()) {
        try {
            process.kill(-process.pid, "SIGKILL");
            swept = true;
        }
        catch {
            /* nothing left in the group */
        }
    }
    if (swept)
        return;
    // Without this, a group kill that does not land leaves kiro-cli running with
    // no supervisor, no timeout and nothing left to cancel, while the record
    // already reads cancelled or failed.
    try {
        spawned?.kill("SIGKILL");
    }
    catch { /* already gone */ }
}
function finalize(status, result) {
    if (finalized)
        return;
    finalized = true;
    // Re-read so a concurrent `cancel` that already set "cancelled" is not undone.
    // Raw, deliberately: the reconciled view reports a record that never got its
    // pid write as "failed", and this runner would then discard a finished run.
    // Guarded like the write below: this runs from the signal handler too, and a
    // throw here would lose both the record and the group teardown.
    let current = null;
    try {
        current = loadJobRaw(jobId);
    }
    catch (e) {
        console.error(`kiro-runner: could not read job ${jobId}: ${e.message}`);
        sweepGroup();
        process.exit(1);
    }
    if (current === null) {
        // The launcher always writes the record before spawning us, so its absence
        // means somebody removed it. Writing a fresh one would file this run under
        // invented metadata -- a review recorded as a rescue that took no time at
        // all -- so discard the result instead of resurrecting the job.
        console.error(`kiro-runner: job ${jobId} no longer exists; discarding its result`);
        sweepGroup();
        process.exit(0);
    }
    if (current.status !== "running") {
        // Someone else recorded the outcome first -- most likely `cancel` after its
        // settle window. The record is theirs to keep, but the transcript is ours:
        // exiting without writing it made /kiro-cli:result report "No output was
        // recorded." for a run that had produced a full review.
        try {
            // Record the size too, without touching the outcome that is theirs:
            // otherwise status advertised no output while result returned the lot.
            const bytes = saveJobResult(jobId, result);
            saveJob({ ...current, resultBytes: bytes });
        }
        catch {
            /* nothing more to do */
        }
        // Still tear the group down, or a SIGTERM-ignoring kiro-cli would be left
        // with no supervisor and no timeout.
        sweepGroup();
        process.exit(0);
    }
    const job = {
        ...current,
        status,
        finishedAt: new Date().toISOString(),
    };
    try {
        // Transcript first, then the record that advertises it: a reader must never
        // see a finished job whose output is not there yet.
        job.resultBytes = saveJobResult(jobId, result);
        saveJob(job);
    }
    catch (e) {
        console.error(`kiro-runner: could not record job ${jobId}: ${e.message}`);
        // Failing to write the record is no reason to leave kiro-cli running on.
        sweepGroup();
        process.exit(1);
    }
    // The record is on disk before anything else in the group is torn down.
    sweepGroup();
    process.exit(0);
}
/**
 * Last line of defence. This process is the only supervisor kiro-cli has: if it
 * dies on an unexpected throw, kiro-cli and its descendants are left with no
 * timeout and no cancel target, running under --trust-all-tools. Record what we
 * can and take the group down with us.
 */
function bailOut(what, err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`kiro-runner: ${what}: ${message}`);
    try {
        finalize("failed", `${collected()}\n\nERROR: the Kiro supervisor failed (${what}): ${message}`);
    }
    catch {
        sweepGroup();
        process.exit(1);
    }
}
process.on("uncaughtException", (err) => { bailOut("uncaught exception", err); });
process.on("unhandledRejection", (err) => { bailOut("unhandled rejection", err); });
// The config has to exist before kiro-cli reads it and must not exist any longer
// than that, so it is written here, one statement before the spawn. `--agent`
// names it; the kind comes from the record rather than from argv, so the two
// sides cannot disagree about which config a job is running under.
if (kiroArgs.includes("--v3")) {
    const record = (() => {
        try {
            return loadJobRaw(jobId);
        }
        catch {
            return null;
        }
    })();
    const kind = record?.kind;
    if (kind === undefined || !isKind(kind)) {
        // Refused rather than run: an unknown agent name makes kiro-cli warn on
        // stderr and fall back to its default agent, which is unrestricted. A run
        // that cannot be given its permissions must not proceed as though it had.
        bailOut("could not determine what this job is", new Error(`job ${jobId} has no usable kind`));
    }
    else {
        try {
            installedAgent = installAgent(kind, jobId, process.cwd());
        }
        catch (e) {
            bailOut("could not install the agent config for this run", e);
        }
    }
}
let child;
try {
    child = spawn(kiroPath, kiroArgs, { stdio: ["ignore", "pipe", "pipe"] });
}
catch (e) {
    // spawn throws synchronously for most errnos. Unguarded that escaped module
    // evaluation, so no record was written and the group was never swept -- the
    // same failure the launcher guards on its own spawn.
    bailOut("could not start kiro-cli", e);
    throw e; // unreachable: bailOut exits
}
spawned = child;
/** How long to wait for the timeout kill to produce an exit before giving up. */
const TIMEOUT_ESCAPE_MS = 5_000;
let escapeTimer;
/**
 * Whether the child is provably gone. Only meaningful from the timeout escape
 * path: reaching it means node never delivered an exit, so a pid that still
 * answers kill(pid, 0) has not been reaped and the SIGKILL cannot be said to
 * have landed. EPERM is "still there, under another uid", which is exactly the
 * case that produced no exit in the first place.
 */
function childIsGone() {
    const pid = spawned?.pid;
    if (typeof pid !== "number")
        return true;
    try {
        process.kill(pid, 0);
        return false;
    }
    catch (e) {
        return e.code !== "EPERM";
    }
}
/** Set when the timeout's SIGKILL could not be shown to have landed. */
let killUnverified = null;
const timer = setTimeout(() => {
    timedOut = true;
    try {
        child.kill("SIGKILL");
    }
    catch { /* already gone */ }
    // A SIGKILL that does not land -- EPERM against a child that changed uid, or
    // a process wedged in an uninterruptible wait -- produces no exit and no
    // close, so nothing else here would ever record the outcome or tear the group
    // down. Every other terminal path escalates; this one has to as well.
    escapeTimer = setTimeout(() => {
        // One more attempt, then check. Recording "timed out" while kiro-cli is
        // still running is the same overclaim `cancel` refuses to make: the record
        // reads finished while the process keeps writing to the repository with its
        // tools trusted. Say so in the transcript instead.
        try {
            child.kill("SIGKILL");
        }
        catch { /* already gone */ }
        if (!childIsGone()) {
            killUnverified =
                `WARNING: kiro-cli (pid ${child.pid}) could not be shown to have stopped after SIGKILL, ` +
                    "so it may still be running with its tools trusted. The supervisor sweeps its process " +
                    "group on the way out, but it cannot verify that either -- check for a stray process.";
        }
        settle(null, "SIGKILL");
    }, TIMEOUT_ESCAPE_MS);
}, timeoutMs);
// setEncoding decodes through a StringDecoder, so a multi-byte character split
// across two pipe reads is not turned into replacement characters.
child.stdout?.setEncoding("utf-8");
child.stderr?.setEncoding("utf-8");
child.stdout?.on("data", (d) => append(d, Buffer.byteLength(d)));
child.stderr?.on("data", (d) => append(d, Buffer.byteLength(d)));
// A stream error would otherwise be an unhandled 'error' event, and this
// process must not die without tearing its group down.
// Kept out of the capped body: charged at zero bytes they escaped the budget,
// and once truncation had begun they were dropped altogether, so a job could
// report success while hiding that output had been lost.
child.stdout?.on("error", (err) => { streamErrors.push(`stdout error: ${err.message}`); });
child.stderr?.on("error", (err) => { streamErrors.push(`stderr error: ${err.message}`); });
let settled = false;
function settle(code, signal) {
    if (settled)
        return;
    settled = true;
    clearTimeout(timer);
    if (escapeTimer)
        clearTimeout(escapeTimer);
    const output = collected();
    // A child that exited on its own reports a code and no signal, so it beat the
    // deadline however close it was -- a run that finished successfully a moment
    // before the timer fired was being recorded as a timeout. Only a killed or
    // unaccounted-for child is treated as timed out.
    if (timedOut && !(code !== null && signal === null)) {
        const detail = `ERROR: kiro-cli timed out after ${timeoutMs}ms.`;
        finalize("failed", killUnverified === null ? `${output}\n\n${detail}` : `${output}\n\n${detail}\n${killUnverified}`);
        return;
    }
    if (signal) {
        // SIGTERM and SIGINT reach the child only because somebody signalled this
        // process group, and `cancel` is the only thing that does -- the timeout
        // path kills with SIGKILL and is caught above. Which of the two arrives
        // first is not ordered: this process gets the same signal and records
        // "cancelled" from its own handler, but if the child's exit event is
        // dispatched first (which is what happens on macOS, consistently) that
        // handler never runs, and an explicit cancellation was recorded as a
        // failure whose transcript blamed a signal the user had sent on purpose.
        if (signal === "SIGTERM" || signal === "SIGINT") {
            finalize("cancelled", `${output}\n\n[cancelled]`);
            return;
        }
        finalize("failed", `${output}\n\nERROR: kiro-cli was terminated by ${signal}.`);
        return;
    }
    if (code === 0 && streamErrors.length > 0) {
        // The transcript is provably incomplete. Reporting it as a finished review
        // would hand back output we know is missing pieces.
        finalize("failed", `${output}\n\nERROR: kiro-cli exited cleanly but its output could not be read in full.`);
        return;
    }
    finalize(code === 0 ? "completed" : "failed", output);
}
let graceTimer;
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
    const output = collected();
    const detail = `ERROR: could not run kiro-cli: ${err.message}`;
    finalize("failed", output ? `${output}\n\n${detail}` : detail);
});
// `cancel` signals this whole group; handling the signal lets us record the
// outcome instead of dying silently and leaving the job to be reconciled.
for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
        clearTimeout(timer);
        if (graceTimer)
            clearTimeout(graceTimer);
        settled = true;
        finalize("cancelled", `${collected()}\n\n[cancelled]`);
    });
}
