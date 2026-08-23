/**
 * Kiro agent configs, which are how this plugin narrows what Kiro may do.
 *
 * kiro-cli's v3 engine has a capability-based permission system: rules name a
 * capability, a set of glob patterns and an effect, and anything not allowed is
 * refused -- which under --no-interactive means refused outright, since there is
 * nobody to approve it. That is fine-grained in a way the trust flags are not:
 * `--trust-all-tools` is all or nothing, and `--trust-tools` is per tool, so
 * trusting the shell at all trusts every command it could run. A rule can allow
 * `git diff` and refuse `touch`, which is what lets a review read a repository
 * without being able to change it. Verified against kiro-cli 2.19.1.
 *
 * kiro-cli discovers agents by name from two places only: the global agent
 * directory, and `.kiro/agents/` in the working directory. This plugin uses the
 * second and treats the file as belonging to the run, not to the repository: it
 * is written before kiro-cli starts and removed when the run ends, so a checkout
 * is never left carrying configuration it did not ask for. Nothing here writes
 * to the user's home.
 *
 * `--agent` takes a name, never a path, and an unknown name is a warning on
 * stderr followed by a silent fall back to the default agent -- which would run
 * with no restrictions while looking as though it had them. Nothing here relies
 * on kiro-cli reporting that: the file is confirmed on disk before it is named,
 * and the run is refused if it could not be written.
 */
import { existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function isKind(value) {
    return value === "review" || value === "rescue";
}
/**
 * One config per run, named after the job.
 *
 * A fixed name per kind would be shorter, but two runs of the same kind would
 * then share one file: the first to finish would delete it out from under the
 * second, which -- because an unknown agent falls back to the default rather
 * than failing -- would quietly continue with no restrictions at all. The job id
 * makes creation and removal unambiguous, and makes a leftover file say which
 * run left it.
 */
export function agentName(kind, jobId) {
    return `kiro-plugin-${kind}-${jobId}`;
}
/** Matches only the names this plugin generates, for the stale sweep below. */
const GENERATED_AGENT_RE = /^kiro-plugin-(review|rescue)-kiro-[0-9a-z]+-[0-9a-z]+\.json$/;
/** Read-only git. Enough to see what changed, and nothing that can change it. */
const READ_ONLY_GIT = [
    "git diff*",
    "git status*",
    "git log*",
    "git show*",
    "git rev-parse*",
    "git ls-files*",
    "git branch --list*",
    "git blame*",
];
/**
 * `review` reads and reports; it has no business writing. fs_write is absent
 * rather than denied, and the shell is allowed only for git commands that cannot
 * mutate anything -- without that a review cannot obtain its own diff, and with
 * a blanket shell allowance "read-only" would be a claim rather than a property.
 * Kiro will say so itself: asked to work around a refused write, it answers that
 * it will not route around the block with a shell command.
 *
 * `rescue` is asked to change the repository, so it gets the write and the
 * shell. That is the same blast radius as the trust-all flag, and saying so
 * plainly is the point: what the config adds is that the surface is declared,
 * and that MCP tools are excluded from it.
 */
const RULES = {
    review: [
        { capability: "fs_read", match: ["**"], effect: "allow" },
        { capability: "shell", match: READ_ONLY_GIT, effect: "allow" },
    ],
    rescue: [
        { capability: "fs_read", match: ["**"], effect: "allow" },
        { capability: "fs_write", match: ["**"], effect: "allow" },
        { capability: "shell", match: ["*"], effect: "allow" },
    ],
};
const TOOLS = {
    review: ["fs_read", "execute_bash"],
    rescue: ["fs_read", "fs_write", "execute_bash"],
};
const DESCRIPTIONS = {
    review: "Code review by Kiro CLI, invoked from Claude Code. Reads the repository and read-only git; cannot write.",
    rescue: "Delegated task for Kiro CLI, invoked from Claude Code. Reads, writes and runs commands in this repository.",
};
export function agentConfig(kind, jobId) {
    return {
        name: agentName(kind, jobId),
        description: DESCRIPTIONS[kind],
        prompt: null,
        mcpServers: {},
        tools: TOOLS[kind],
        toolAliases: {},
        // Empty on purpose: this is the pre-approval list the older engine uses, and
        // naming a tool here would auto-approve every use of it. The permission
        // rules below are what grant access under the v3 engine.
        allowedTools: [],
        resources: [],
        toolsSettings: {},
        // The plugin's own surface, not the user's MCP servers. A review has no
        // reason to reach a database or a ticket tracker.
        includeMcpJson: false,
        model: null,
        permissions: { rules: RULES[kind] },
    };
}
function agentsDir(cwd) {
    return join(cwd, ".kiro", "agents");
}
export function agentPath(kind, jobId, cwd) {
    return join(agentsDir(cwd), `${agentName(kind, jobId)}.json`);
}
/**
 * Writes the run's config into the working directory. Raises rather than
 * returning a partial result: the caller has to be able to tell the difference
 * between "restricted as intended" and "running unrestricted", and kiro-cli
 * will not make that distinction for it.
 */
export function installAgent(kind, jobId, cwd) {
    const dir = agentsDir(cwd);
    // Recorded newest-last so teardown can remove them in reverse. Only ones this
    // call brought into being: a `.kiro` that was already there stays.
    const createdDirs = [];
    for (const d of [join(cwd, ".kiro"), dir]) {
        if (!existsSync(d))
            createdDirs.push(d);
    }
    mkdirSync(dir, { recursive: true });
    const path = agentPath(kind, jobId, cwd);
    // 0600: the rules say what this run may do, and nothing else needs to read it.
    writeFileSync(path, `${JSON.stringify(agentConfig(kind, jobId), null, 2)}\n`, { mode: 0o600 });
    return { name: agentName(kind, jobId), path, createdDirs };
}
/**
 * Removes the run's config, and any directory this run had to create for it.
 * Best effort throughout: teardown must not be able to fail a job, and a file
 * that is already gone is the outcome we wanted.
 */
export function removeAgent(installed) {
    try {
        unlinkSync(installed.path);
    }
    catch {
        /* already gone */
    }
    // Reverse order, and only if empty: a directory that has anything else in it
    // belongs to the repository, whoever created it.
    for (const dir of [...installed.createdDirs].reverse()) {
        try {
            if (readdirSync(dir).length === 0)
                rmdirSync(dir);
        }
        catch {
            /* not empty, or not there */
        }
    }
}
/**
 * Removes configs left behind by a run that died before it could tear down --
 * SIGKILL, a power cut, a supervisor that crashed. Only names this plugin
 * generates are ever removed, so a hand-written agent in the same directory is
 * left alone, and only once past `maxAgeMs`, so a config belonging to a run
 * still in flight is not taken away from it.
 */
export function sweepStaleAgents(cwd, maxAgeMs, statMtimeMs) {
    const dir = agentsDir(cwd);
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return 0;
    }
    let removed = 0;
    for (const name of names) {
        if (!GENERATED_AGENT_RE.test(name))
            continue;
        const path = join(dir, name);
        try {
            if (Date.now() - statMtimeMs(path) < maxAgeMs)
                continue;
            unlinkSync(path);
            removed += 1;
        }
        catch {
            /* gone, or not ours to remove */
        }
    }
    return removed;
}
/** What a rule set allows, for `setup` to show without anyone opening a file. */
export function describeRules(kind) {
    return RULES[kind].map((r) => `${r.capability}: ${r.match.join(", ")}`);
}
