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

Run exactly one command, forwarding the arguments unchanged:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" review $ARGUMENTS
```

The script decides the execution mode from the arguments itself:
- `--background` starts a detached job and prints `{"jobId": "...", "status": "started"}` immediately.
  Do not also use `run_in_background` -- the job already outlives the command.
  Report the job ID and tell the user to check `/kiro-cli:status`.
- Otherwise the review runs in the foreground; return the stdout verbatim.

If the arguments contain neither `--wait` nor `--background`, recommend
`--background` for anything beyond 1-2 files.
