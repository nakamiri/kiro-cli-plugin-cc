import { execFileSync } from "node:child_process";

/**
 * Kiro is given full tool trust when the variable is unset, which is the
 * documented default. Once it is set, only an explicitly affirmative value
 * keeps trust on: an unrecognised value such as "off" or "disabled" clearly
 * means the operator wanted trust reduced, so fail closed rather than open.
 */
export function trustAllTools(): boolean {
  const v = process.env.KIRO_PLUGIN_TRUST_ALL_TOOLS;
  if (v === undefined) return true;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

export function chatArgs(prompt: string): string[] {
  const args = ["chat", "--no-interactive"];
  if (trustAllTools()) args.push("--trust-all-tools");
  // A prompt such as "--verbose builds are broken" would otherwise be parsed
  // as an option. Only emitted when needed, so the common path is unchanged.
  if (prompt.startsWith("-")) args.push("--");
  args.push(prompt);
  return args;
}

export function findKiro(): string | null {
  if (process.env.KIRO_CLI_PATH) return process.env.KIRO_CLI_PATH;
  try {
    // execFile, not a shell: nothing here is interpolated into a command line.
    const p = execFileSync("which", ["kiro-cli"], { encoding: "utf-8" }).trim();
    return p || null;
  } catch {
    return null;
  }
}

/** setTimeout stores its delay in a signed 32-bit int and silently wraps past this. */
const MAX_TIMER_MS = 2_147_483_647;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_TIMER_MS);
}

/** Foreground runs block the caller, so they get the shorter budget. */
export function foregroundTimeoutMs(): number {
  return positiveIntEnv("KIRO_PLUGIN_TIMEOUT_MS", 300_000);
}

export function backgroundTimeoutMs(): number {
  return positiveIntEnv("KIRO_PLUGIN_BACKGROUND_TIMEOUT_MS", 1_800_000);
}

export function maxOutputBytes(): number {
  return positiveIntEnv("KIRO_PLUGIN_MAX_OUTPUT_BYTES", 10 * 1024 * 1024);
}
