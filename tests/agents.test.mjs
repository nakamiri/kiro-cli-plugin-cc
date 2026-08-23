// The run-scoped agent config: what it allows, and that it exists for exactly as
// long as the run does.
//
// It is the only thing standing between a review and a writable repository, and
// kiro-cli will not help us notice if it goes missing: `--agent` takes a name,
// an unknown name is a warning on stderr, and the run then proceeds under the
// default agent, which can do anything. So the file's presence, contents and
// removal are all asserted here rather than inferred from a run succeeding.
import { test, beforeEach, afterEach, after } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  agentConfig,
  agentName,
  agentPath,
  describeRules,
  installAgent,
  isKind,
  removeAgent,
  sweepStaleAgents,
} from "../plugins/kiro-cli/scripts/lib/agents.js";

let cwd;
const created = [];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "kiro-agents-test-"));
  created.push(cwd);
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

const JOB = "kiro-mt5wxech-phvz";
const mtimeOf = (p) => statSync(p).mtimeMs;

// --- what the rules say ---

test("review may read anything and run only git commands that cannot mutate", () => {
  const rules = agentConfig("review", JOB).permissions.rules;
  const shell = rules.find((r) => r.capability === "shell");
  assert.deepEqual(rules.map((r) => r.capability), ["fs_read", "shell"]);
  assert.equal(rules.find((r) => r.capability === "fs_read").match[0], "**");
  // Absent rather than denied: there is no rule that could grant it.
  assert.equal(rules.some((r) => r.capability === "fs_write"), false, "review can write");
  // Every allowed command is a git subcommand that only reports.
  for (const pattern of shell.match) {
    assert.match(pattern, /^git /, `not a git command: ${pattern}`);
    assert.doesNotMatch(pattern, /^git (commit|push|checkout|reset|clean|apply|rm|mv|stash|restore)/, `mutates: ${pattern}`);
  }
  // And nothing that would let anything else through.
  assert.equal(shell.match.includes("*"), false, "review has a blanket shell allowance");
  assert.equal(agentConfig("review", JOB).tools.includes("fs_write"), false);
});

test("rescue is allowed to change the repository, and says so", () => {
  // Not a reduction in blast radius and not presented as one: a shell allowance
  // is arbitrary command execution. What the config adds is that the surface is
  // declared, and that MCP tools are excluded from it.
  const rules = agentConfig("rescue", JOB).permissions.rules;
  assert.deepEqual(rules.map((r) => r.capability).sort(), ["fs_read", "fs_write", "shell"]);
  assert.deepEqual(rules.find((r) => r.capability === "shell").match, ["*"]);
});

test("neither agent inherits the user's MCP servers or pre-approves a tool", () => {
  for (const kind of ["review", "rescue"]) {
    const config = agentConfig(kind, JOB);
    // A review has no reason to reach a database or a ticket tracker.
    assert.equal(config.includeMcpJson, false, `${kind} pulls in mcp.json`);
    assert.deepEqual(config.mcpServers, {});
    // allowedTools is the older engine's pre-approval list; naming a tool there
    // would auto-approve every use of it, whatever the rules below say.
    assert.deepEqual(config.allowedTools, [], `${kind} pre-approves tools`);
  }
});

test("setup can describe the rules without anyone opening the file", () => {
  assert.deepEqual(describeRules("review")[0], "fs_read: **");
  assert.match(describeRules("review")[1], /^shell: git diff\*/);
  assert.ok(describeRules("rescue").some((line) => line.startsWith("fs_write: ")));
});

test("only the two kinds this plugin runs are kinds", () => {
  assert.equal(isKind("review"), true);
  assert.equal(isKind("rescue"), true);
  for (const v of ["task", "", "REVIEW", "setup"]) assert.equal(isKind(v), false, `accepted ${v}`);
});

// --- the name is per run, not per kind ---

test("the config is named after the job, so two runs cannot share one file", () => {
  // A fixed name per kind would have the first run to finish delete the file out
  // from under the second -- which, because an unknown agent falls back to the
  // unrestricted default rather than failing, would quietly continue with no
  // restrictions at all.
  assert.notEqual(agentName("review", "kiro-a-1"), agentName("review", "kiro-a-2"));
  assert.notEqual(agentName("review", JOB), agentName("rescue", JOB));
  // And the name inside the file is the name kiro-cli will be asked for.
  assert.equal(agentConfig("review", JOB).name, agentName("review", JOB));
  assert.ok(agentPath("review", JOB, cwd).endsWith(join(".kiro", "agents", `${agentName("review", JOB)}.json`)));
});

// --- the file's lifetime is the run's lifetime ---

test("installing writes a config only this user can read, and removing takes it away", () => {
  const installed = installAgent("review", JOB, cwd);
  assert.ok(existsSync(installed.path));
  assert.equal(JSON.parse(readFileSync(installed.path, "utf-8")).name, installed.name);
  // The rules say what this run may do; nothing else needs to read them.
  if (process.getuid !== undefined) assert.equal(statSync(installed.path).mode & 0o077, 0);
  removeAgent(installed);
  assert.equal(existsSync(installed.path), false, "the config outlived the run");
  // Both directories were this run's doing, so both go.
  assert.equal(existsSync(join(cwd, ".kiro")), false, "an empty .kiro was left behind");
});

test("a .kiro the repository already had is left where it is", () => {
  // The plugin is a guest in someone else's checkout: it may add a file for the
  // duration of a run, and it may not tidy up things it did not create.
  mkdirSync(join(cwd, ".kiro", "steering"), { recursive: true });
  writeFileSync(join(cwd, ".kiro", "steering", "notes.md"), "operator notes");
  const installed = installAgent("rescue", JOB, cwd);
  removeAgent(installed);
  assert.equal(existsSync(installed.path), false);
  assert.equal(readFileSync(join(cwd, ".kiro", "steering", "notes.md"), "utf-8"), "operator notes");
  assert.ok(existsSync(join(cwd, ".kiro")), ".kiro was removed from under the repository");
});

test("an agents directory shared with a hand-written agent survives", () => {
  const dir = join(cwd, ".kiro", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "my-own-agent.json"), '{"name":"my-own-agent"}');
  const installed = installAgent("review", JOB, cwd);
  removeAgent(installed);
  assert.ok(existsSync(join(dir, "my-own-agent.json")), "somebody else's agent was removed");
  assert.ok(existsSync(dir));
});

test("removing twice, or removing what is already gone, is not an error", () => {
  // Teardown runs from signal handlers and from a last-resort bail-out, so it has
  // to be safe to reach twice and safe to reach after a partial cleanup.
  const installed = installAgent("review", JOB, cwd);
  rmSync(installed.path);
  assert.doesNotThrow(() => removeAgent(installed));
  assert.doesNotThrow(() => removeAgent(installed));
});

// --- what a killed run leaves behind ---

test("a config left by a killed run is swept, once it is old enough", () => {
  // SIGKILL, a power cut, a supervisor that crashed: teardown never ran. The age
  // guard is what keeps the sweep from taking a config away from a run that is
  // still using it.
  const fresh = installAgent("review", "kiro-fresh001-aa", cwd);
  const stale = installAgent("review", "kiro-stale001-aa", cwd);
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(stale.path, old, old);

  assert.equal(sweepStaleAgents(cwd, 30 * 60_000, mtimeOf), 1);
  assert.equal(existsSync(stale.path), false, "a stale config survived");
  assert.ok(existsSync(fresh.path), "a config belonging to a live run was swept");
});

test("the sweep touches only names this plugin generates", () => {
  const dir = join(cwd, ".kiro", "agents");
  mkdirSync(dir, { recursive: true });
  const strangers = ["my-own-agent.json", "kiro-plugin-review.json", "kiro-plugin-review-nope.json", "notes.md"];
  for (const name of strangers) writeFileSync(join(dir, name), "{}");
  const old = new Date(Date.now() - 60 * 60_000);
  for (const name of strangers) utimesSync(join(dir, name), old, old);

  assert.equal(sweepStaleAgents(cwd, 1, mtimeOf), 0);
  for (const name of strangers) assert.ok(existsSync(join(dir, name)), `${name} was removed`);
});

test("sweeping a directory that is not there is not an error", () => {
  assert.equal(sweepStaleAgents(cwd, 1, mtimeOf), 0);
  assert.equal(sweepStaleAgents(join(cwd, "nope"), 1, mtimeOf), 0);
});
