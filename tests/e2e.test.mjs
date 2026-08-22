import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPANION = resolve(__dirname, "..", "plugins", "kiro-cli", "scripts", "kiro-companion.mjs");

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kiro-e2e-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function run(args, env = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      KIRO_PLUGIN_JOBS_DIR: tmpDir,
      ...env,
    },
  });
}

function makeFakeKiro(version = "kiro-cli 1.2.3") {
  const path = join(tmpDir, "fake-kiro-cli");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nexit 0\n`,
    { mode: 0o755 }
  );
  chmodSync(path, 0o755);
  return path;
}

test("E2E: setup --json with fake kiro returns valid JSON", () => {
  const fakeKiro = makeFakeKiro("kiro-cli 9.9.9");
  const r = run(["setup", "--json"], { KIRO_CLI_PATH: fakeKiro });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.installed, true);
  assert.equal(parsed.path, fakeKiro);
  assert.equal(parsed.version, "kiro-cli 9.9.9");
});

test("E2E: setup with no kiro present reports not installed", () => {
  // Force findKiro() to fail by pointing PATH at an empty directory and clearing KIRO_CLI_PATH.
  const r = run(["setup"], { PATH: tmpDir, KIRO_CLI_PATH: "" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /kiro-cli is not installed/);
});

test("E2E: status reports no jobs initially", () => {
  const r = run(["status"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No Kiro jobs found/);
});

test("E2E: result reports no finished jobs initially", () => {
  const r = run(["result"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No finished jobs found/);
});

test("E2E: cancel reports no running jobs initially", () => {
  const r = run(["cancel"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No running jobs to cancel/);
});

test("E2E: unknown command shows usage", () => {
  const r = run(["bogus"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Unknown command: bogus/);
  assert.match(r.stdout, /Usage:/);
});

test("E2E: status with non-existent job ID reports not found", () => {
  const r = run(["status", "fake-id-xyz"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No job found with ID: fake-id-xyz/);
});

test("E2E: cancel with non-existent job ID reports not found", () => {
  const r = run(["cancel", "fake-id-xyz"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No job found with ID: fake-id-xyz/);
});
