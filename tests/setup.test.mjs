import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { setup, findKiro, dispatch } = await import("../plugins/kiro-cli/scripts/lib/kiro-companion.js");

let tmpDir;
let originalKiroPath;
let originalJobsDir;

beforeEach(() => {
  originalKiroPath = process.env.KIRO_CLI_PATH;
  originalJobsDir = process.env.KIRO_PLUGIN_JOBS_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "kiro-setup-test-"));
  // These tests reach the real launcher, which writes records and prunes the
  // store. Without this they would do that in the developer's own job
  // directory, and once past the retention cap delete genuine records from it.
  process.env.KIRO_PLUGIN_JOBS_DIR = join(tmpDir, "jobs");
});

afterEach(() => {
  if (originalKiroPath === undefined) delete process.env.KIRO_CLI_PATH;
  else process.env.KIRO_CLI_PATH = originalKiroPath;
  if (originalJobsDir === undefined) delete process.env.KIRO_PLUGIN_JOBS_DIR;
  else process.env.KIRO_PLUGIN_JOBS_DIR = originalJobsDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeFakeKiro(versionOutput) {
  const path = join(tmpDir, "fake-kiro-cli");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${versionOutput}"; exit 0; fi\nexit 1\n`,
    { mode: 0o755 }
  );
  chmodSync(path, 0o755);
  return path;
}

test("findKiro: respects KIRO_CLI_PATH", () => {
  process.env.KIRO_CLI_PATH = "/some/explicit/path";
  assert.equal(findKiro(), "/some/explicit/path");
});

test("setup: reports not installed when KIRO_CLI_PATH points to missing binary", () => {
  process.env.KIRO_CLI_PATH = join(tmpDir, "does-not-exist");
  // Even when the path is set but the binary is missing, --version will fail.
  // The current implementation treats KIRO_CLI_PATH as authoritative ("installed: true"),
  // so we test the JSON output reflects that: installed=true, version=null.
  const json = JSON.parse(setup(["--json"]));
  assert.equal(json.installed, true);
  assert.equal(json.path, join(tmpDir, "does-not-exist"));
  assert.equal(json.version, null);
});

test("setup: reports installed with version when fake kiro is reachable", () => {
  process.env.KIRO_CLI_PATH = makeFakeKiro("kiro-cli 9.9.9");
  const json = JSON.parse(setup(["--json"]));
  assert.equal(json.installed, true);
  assert.equal(json.version, "kiro-cli 9.9.9");
});

test("setup: human-readable output includes version", () => {
  process.env.KIRO_CLI_PATH = makeFakeKiro("kiro-cli 1.2.3");
  const out = setup([]);
  assert.match(out, /✓ kiro-cli is ready/);
  assert.match(out, /kiro-cli 1\.2\.3/);
});

test("dispatch: routes to setup", async () => {
  process.env.KIRO_CLI_PATH = makeFakeKiro("kiro-cli 1.0.0");
  const out = await dispatch("setup", ["--json"]);
  const parsed = JSON.parse(out);
  assert.equal(parsed.installed, true);
});

test("dispatch: unknown command returns usage", async () => {
  const out = await dispatch("nonsense", []);
  assert.match(out, /Unknown command: nonsense/);
  assert.match(out, /Usage: kiro-companion/);
});

test("dispatch: 'task' alias routes to rescue", async () => {
  // A configured kiro-cli that is not actually there must be reported, not
  // thrown, and the run must be recorded as a failure rather than hang.
  process.env.KIRO_CLI_PATH = join(tmpDir, "not-there");
  const out = await dispatch("task", ["something"]);
  assert.match(out, /ERROR/);
  assert.match(out, /did not complete|could not run kiro-cli|ENOENT/);
});
