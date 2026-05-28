---
description: Run a Kiro CLI code review against local git state
argument-hint: '[--wait|--background] [--base <ref>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Run a Kiro CLI review through the companion script.

Raw slash-command arguments: `$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Kiro's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, run the review in the foreground.
- If the raw arguments include `--background`, run the review in a Claude background task.
- Otherwise, recommend background for anything beyond 1-2 files.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" review $ARGUMENTS
```
- Return the command stdout verbatim.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" review $ARGUMENTS`,
  description: "Kiro review",
  run_in_background: true
})
```
- Tell the user: "Kiro review started in the background. Check `/kiro:status` for progress."
