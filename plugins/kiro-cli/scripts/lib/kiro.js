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
            timeout: 10_000,
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
    if (!Number.isFinite(n) || n < 1)
        return fallback;
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
 * Upper bound on the transcript bytes kept across all retained records. The
 * count cap alone is not a size bound: fifty runs at the default output cap
 * would be half a gigabyte.
 */
export function maxRetainedJobBytes() {
    return positiveIntEnv("KIRO_PLUGIN_MAX_JOB_BYTES", 64 * 1024 * 1024);
}
