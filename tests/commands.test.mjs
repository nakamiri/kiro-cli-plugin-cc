// The command files' frontmatter decides two things no other test can see: who
// may start a Kiro run, and what a turn that starts one is handed along the way.
// Both are permission decisions -- f835169 made one of them deliberately and
// 0.3.0 reversed it on purpose -- so an accidental edit should fail here rather
// than ship.
//
// Each block is pinned whole, byte for byte, and nothing here parses YAML.
// Earlier versions of this test did parse it, and each one was defeated by a
// spelling it had not thought of: no space after a colon, a colon folded into a
// value, a `---` inside a description, a lone CR, an unbalanced apostrophe. The
// lesson was that a list of ways a file can be misread is never finished, and
// the direction of the risk is not the reassuring one -- an unreadable
// `allowed-tools` grants nothing, but an unreadable `disable-model-invocation`
// is *absent*, and absent means Claude may start the command itself. Comparing
// the whole block sidesteps all of it: anything that changes what Claude Code
// reads also changes these bytes.
//
// The cost is that editing a description fails this test. That is the intended
// trade. These six blocks carry the permission decisions for the plugin, and
// changing one should be deliberate enough to change the expectation with it.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file, not the working directory: every other suite reaches
// the plugin through a module-relative import, and a cwd-relative path here
// would be the one thing in the suite that cares where it was started from.
const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins/kiro-cli/commands");

/** The one program a model-reachable command may run, as written in a rule. */
const SCRIPT = "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs";

/** Both quotings, because matching is literal and the model may write either. */
const forms = (sub) => [`Bash(node "${SCRIPT}" ${sub}*)`, `Bash(node ${SCRIPT} ${sub}*)`];

/**
 * The exact frontmatter of every command.
 *
 * `rescue` and `setup` are the two Claude may start itself. They carry no
 * `disable-model-invocation`, and in exchange their grant is held down to the
 * companion script's own subcommands -- `rescue` lists setup* as well because
 * agents/kiro-rescue.md reads recommendedBashTimeoutMs before forwarding, and
 * both quotings of the path appear because the rule is matched against the
 * command string literally. The other four are reached only by being typed, and
 * keep the broader grant that has always suited them.
 *
 * If a change here is deliberate, update the block. If it is not, that is what
 * this test is for.
 */
const EXPECTED = {
  cancel: [
    "description: Cancel an active background Kiro job",
    "argument-hint: '[job-id]'",
    "disable-model-invocation: true",
    "allowed-tools: Bash(node:*)",
  ],
  rescue: [
    "description: Delegate a task to Kiro CLI for investigation or fixing",
    "argument-hint: '[--background|--wait] [task description]'",
    `allowed-tools: ${[...forms("rescue"), ...forms("setup"), "Agent"].join(", ")}`,
  ],
  result: [
    "description: Show the stored final output for a finished Kiro job",
    "argument-hint: '[job-id]'",
    "disable-model-invocation: true",
    "allowed-tools: Bash(node:*)",
  ],
  review: [
    "description: Run a Kiro CLI code review against local git state",
    "argument-hint: '[--wait|--background] [--base <ref>]'",
    "disable-model-invocation: true",
    "allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)",
  ],
  setup: [
    "description: Check whether kiro-cli is installed and ready",
    "argument-hint: ''",
    `allowed-tools: ${forms("setup").join(", ")}`,
  ],
  status: [
    "description: Show active and recent Kiro jobs for this repository",
    "argument-hint: '[job-id]'",
    "disable-model-invocation: true",
    "allowed-tools: Bash(node:*)",
  ],
};

/**
 * Every file Claude Code would take as a command, found the way it finds them:
 * walking subdirectories, matching the extension without regard to case, and
 * naming a nested command by its path with `:` between the segments. Listing
 * only `*.md` at the top level would leave `commands/deep/evil.md` and
 * `commands/Evil.MD` outside this test while Claude Code loads both.
 *
 * Read off Claude Code 2.1.263 rather than assumed, along with where the
 * frontmatter block ends.
 */
function discover() {
  const files = new Map();
  for (const entry of readdirSync(COMMANDS_DIR, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    const name = relative(COMMANDS_DIR, full).slice(0, -3).split(sep).join(":");
    // Two files differing only in the case of their extension are two commands
    // to Claude Code, and it prefers the model-reachable one when names clash.
    assert.ok(!files.has(name), `${full} and ${files.get(name)} both read as the command ${name}`);
    files.set(name, full);
  }
  return files;
}

/**
 * The block as it sits on disk: no newline conversion, no trimming. A lone CR
 * is a line break to YAML and Claude Code does not strip one, so normalising
 * here would hide a whole key line from the comparison below.
 */
function block(name, path) {
  const text = readFileSync(path, "utf-8");
  // Cut where Claude Code cuts: the closing `---` is not anchored to the start
  // of a line, so a value containing one ends the block early.
  const m = /^---[ \t]*\n([\s\S]*?)---[ \t]*\n?/.exec(text);
  assert.ok(m, `${name} has no readable frontmatter block`);
  return m[1];
}

const FILES = discover();
const names = [...FILES.keys()].sort();

test("the set of commands is the one this test has decisions for", () => {
  // A command added without a permission decision fails here rather than
  // shipping with whatever frontmatter it happened to be written with.
  assert.deepEqual(names, Object.keys(EXPECTED).sort());
});

test("every command's frontmatter is exactly what it is supposed to be", () => {
  for (const name of names) {
    assert.equal(
      block(name, FILES.get(name)),
      `${EXPECTED[name].join("\n")}\n`,
      `${name} frontmatter differs from the pinned block. If the change is deliberate, ` +
        "update EXPECTED in this file; the two model-reachable commands and the tool " +
        "grant of all six are permission decisions, not incidental text.",
    );
  }
});
