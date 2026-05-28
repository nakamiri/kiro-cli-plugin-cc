import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildReviewPrompt, buildRescuePrompt, hasFlag } from "../plugins/kiro/scripts/lib/kiro-companion.js";

test("buildReviewPrompt: defaults to HEAD when no --base", () => {
  const p = buildReviewPrompt([]);
  assert.match(p, /Compare against HEAD\./);
  assert.match(p, /correctness, security, performance, and style/);
});

test("buildReviewPrompt: respects --base argument", () => {
  const p = buildReviewPrompt(["--base", "main"]);
  assert.match(p, /Compare against main\./);
});

test("buildReviewPrompt: extra args become focus instructions", () => {
  const p = buildReviewPrompt(["--base", "main", "check", "auth", "logic"]);
  assert.match(p, /Compare against main\./);
  assert.match(p, /Focus on: check auth logic/);
});

test("buildReviewPrompt: strips --background and --wait flags", () => {
  const p = buildReviewPrompt(["--background", "review", "this"]);
  assert.doesNotMatch(p, /--background/);
  assert.match(p, /Focus on: review this/);
});

test("buildReviewPrompt: no Focus section when no extra args", () => {
  const p = buildReviewPrompt(["--base", "develop", "--wait"]);
  assert.doesNotMatch(p, /Focus on:/);
});

test("buildRescuePrompt: joins task text", () => {
  const p = buildRescuePrompt(["fix", "the", "flaky", "test"]);
  assert.equal(p, "fix the flaky test");
});

test("buildRescuePrompt: strips execution flags", () => {
  const p = buildRescuePrompt(["--background", "investigate", "the", "bug"]);
  assert.equal(p, "investigate the bug");
});

test("buildRescuePrompt: returns default when no task given", () => {
  const p = buildRescuePrompt([]);
  assert.equal(p, "Investigate and fix the current issue.");
});

test("buildRescuePrompt: returns default when only flags given", () => {
  const p = buildRescuePrompt(["--background", "--wait"]);
  assert.equal(p, "Investigate and fix the current issue.");
});

test("hasFlag: detects presence of flag", () => {
  assert.equal(hasFlag(["--background", "task"], "--background"), true);
  assert.equal(hasFlag(["task"], "--background"), false);
});
