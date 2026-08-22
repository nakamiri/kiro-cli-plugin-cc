import { execFileSync } from "node:child_process";
/** Kiro is given full tool trust by default; set to 0/false/no to opt out. */
export function trustAllTools() {
    const v = process.env.KIRO_PLUGIN_TRUST_ALL_TOOLS;
    return !(v === "0" || v === "false" || v === "no");
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
export function findKiro() {
    if (process.env.KIRO_CLI_PATH)
        return process.env.KIRO_CLI_PATH;
    try {
        // execFile, not a shell: nothing here is interpolated into a command line.
        const p = execFileSync("which", ["kiro-cli"], { encoding: "utf-8" }).trim();
        return p || null;
    }
    catch {
        return null;
    }
}
function positiveIntEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
/** Foreground runs block the caller, so they get the shorter budget. */
export function foregroundTimeoutMs() {
    return positiveIntEnv("KIRO_PLUGIN_TIMEOUT_MS", 300_000);
}
export function backgroundTimeoutMs() {
    return positiveIntEnv("KIRO_PLUGIN_BACKGROUND_TIMEOUT_MS", 1_800_000);
}
export function maxOutputBytes() {
    return positiveIntEnv("KIRO_PLUGIN_MAX_OUTPUT_BYTES", 10 * 1024 * 1024);
}
