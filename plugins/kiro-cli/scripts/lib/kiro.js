import { execFileSync } from "node:child_process";
/**
 * Kiro is given full tool trust when the variable is unset, which is the
 * documented default. Once it is set, only an explicitly affirmative value
 * keeps trust on: an unrecognised value such as "off" or "disabled" clearly
 * means the operator wanted trust reduced, so fail closed rather than open.
 */
export function trustAllTools() {
    const v = process.env.KIRO_PLUGIN_TRUST_ALL_TOOLS;
    if (v === undefined)
        return true;
    return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}
/**
 * Whether to strip terminal control sequences from Kiro's output. On by
 * default: the output is read in Claude Code, not a terminal, so the colours
 * and cursor moves kiro-cli emits are literal noise there. Set to 0 to keep the
 * raw bytes -- useful when the sequences themselves are what you are looking
 * at, or to compare against what kiro-cli actually produced.
 */
export function stripOutputAnsi() {
    const v = process.env.KIRO_PLUGIN_STRIP_ANSI;
    if (v === undefined)
        return true;
    return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}
export function chatArgs(prompt) {
    const args = ["chat", "--no-interactive"];
    if (trustAllTools())
        args.push("--trust-all-tools");
    // A prompt such as "--verbose builds are broken" would otherwise be parsed
    // as an option. Only emitted when needed, so the common path is unchanged.
    if (prompt.startsWith("-"))
        args.push("--");
    args.push(prompt);
    return args;
}
/**
 * Node binary used for the detached runner. Overridable both because a host may
 * want a specific interpreter and because it is the only way to exercise the
 * spawn-failure path in a test.
 */
export function nodeBinary() {
    return process.env.KIRO_PLUGIN_NODE || process.execPath;
}
export function findKiro() {
    if (process.env.KIRO_CLI_PATH)
        return process.env.KIRO_CLI_PATH;
    try {
        // execFile, not a shell: nothing here is interpolated into a command line.
        // Bounded like every other probe -- a hung PATH entry would otherwise block
        // every command before any of the configured budgets could apply.
        const p = execFileSync("which", ["kiro-cli"], {
            encoding: "utf-8",
            timeout: pathLookupTimeoutMs(),
            killSignal: "SIGKILL",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return p || null;
    }
    catch {
        return null;
    }
}
/** setTimeout stores its delay in a signed 32-bit int and silently wraps past this. */
const MAX_TIMER_MS = 2_147_483_647;
function positiveIntEnv(name, fallback, max = Number.MAX_SAFE_INTEGER) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    // Floor first: flooring after the guard turned any value in (0, 1) into 0,
    // which zeroed the output cap and made every timeout fire immediately.
    const n = Math.floor(Number(raw));
    if (Number.isNaN(n) || n < 1)
        return fallback;
    // A value that overflows to Infinity asked for "as much as possible", so give
    // it the ceiling rather than quietly reverting to the default.
    if (!Number.isFinite(n))
        return max;
    return Math.min(n, max);
}
/** Foreground runs block the caller, so they get the shorter budget. */
export function foregroundTimeoutMs() {
    // Clamped: this value becomes a setTimeout delay.
    return positiveIntEnv("KIRO_PLUGIN_TIMEOUT_MS", 300_000, MAX_TIMER_MS);
}
export function backgroundTimeoutMs() {
    return positiveIntEnv("KIRO_PLUGIN_BACKGROUND_TIMEOUT_MS", 1_800_000, MAX_TIMER_MS);
}
export function maxOutputBytes() {
    return positiveIntEnv("KIRO_PLUGIN_MAX_OUTPUT_BYTES", 10 * 1024 * 1024);
}
/**
 * Terminal job records older than this are pruned when a new job starts. It is
 * compared against a timestamp, never used as a timer delay, so the setTimeout
 * ceiling does not apply -- it used to, silently capping any retention longer
 * than about 24.8 days.
 */
export function jobTtlMs() {
    return positiveIntEnv("KIRO_PLUGIN_JOB_TTL_MS", 7 * 24 * 60 * 60 * 1000);
}
/** Upper bound on retained terminal records, whatever their age. */
export function maxRetainedJobs() {
    return positiveIntEnv("KIRO_PLUGIN_MAX_JOBS", 50);
}
/**
 * Upper bound on retained transcript bytes across all retained records. The
 * count cap alone is not a size bound: fifty runs at the default output cap
 * would be half a gigabyte.
 */
export function maxRetainedJobBytes() {
    return positiveIntEnv("KIRO_PLUGIN_MAX_JOB_BYTES", 64 * 1024 * 1024);
}
/*
 * Internal timing seams. The defaults are the product's behaviour and there is
 * no reason for an operator to change them; they are configurable so the tests
 * can exercise the paths that depend on them -- a bounded probe, a settle
 * window, a flush grace -- without spending the whole default budget in real
 * time. Waiting out the 30s version probe and the 10s PATH lookup alone cost
 * the suite 40 seconds. The README lists them all the same, on the grounds that
 * a value which changes behaviour should be findable.
 */
/** How long `setup` waits for `kiro-cli --version` before giving up. */
export function versionProbeTimeoutMs() {
    return positiveIntEnv("KIRO_PLUGIN_VERSION_PROBE_MS", 30_000, MAX_TIMER_MS);
}
/** How long `findKiro` waits for the PATH lookup before reporting nothing. */
export function pathLookupTimeoutMs() {
    return positiveIntEnv("KIRO_PLUGIN_PATH_LOOKUP_MS", 10_000, MAX_TIMER_MS);
}
/**
 * How long `cancel` gives a signalled runner to record its own outcome before
 * writing one from this side.
 */
export function cancelSettleMs() {
    return positiveIntEnv("KIRO_PLUGIN_CANCEL_SETTLE_MS", 2_000, MAX_TIMER_MS);
}
/** How often a foreground wait pays for a full reconciling read. */
export function foregroundReconcileMs() {
    return positiveIntEnv("KIRO_PLUGIN_RECONCILE_MS", 5_000, MAX_TIMER_MS);
}
/**
 * How long the runner waits for the pipes to drain after kiro-cli has exited.
 * A descendant holding stdout open can otherwise delay "close" indefinitely.
 */
export function flushGraceMs() {
    return positiveIntEnv("KIRO_PLUGIN_FLUSH_GRACE_MS", 2_000, MAX_TIMER_MS);
}
/**
 * How long a single stall on stdin is tolerated. Budgets the current stall, not
 * the whole read, so a writer that pauses part way through a long body does not
 * lose what has already arrived.
 */
export function stdinStallMs() {
    return positiveIntEnv("KIRO_PLUGIN_STDIN_STALL_MS", 5_000, MAX_TIMER_MS);
}
