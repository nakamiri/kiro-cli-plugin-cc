---
description: Run a Kiro CLI code review against local git state
argument-hint: '[--wait|--background] [--base <ref>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Run a Kiro CLI review through the companion script.

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Kiro's output verbatim to the user.

Run exactly one command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" review "$(cat <<'KIRO_ARGS_a41f7c2e'
$ARGUMENTS
KIRO_ARGS_a41f7c2e
)"
```

The quoted heredoc delimiter is what makes this safe: the shell performs no
expansion at all inside the body, so arguments containing `$(...)`, backticks,
quotes or apostrophes are passed through as plain text. Do not replace it with
an inline `'$ARGUMENTS'` -- a single quote in the arguments would end the
quoting and the rest would run as shell commands.

The script decides the execution mode from those arguments itself:
- `--background` starts a detached job and prints `{"jobId": "...", "status": "started"}`
  immediately. Do not also use `run_in_background` -- the job already outlives
  the command. Report the job ID and tell the user to check `/kiro-cli:status`.
- Otherwise the review runs in the foreground; return the stdout verbatim.

If the arguments contain neither `--wait` nor `--background`, recommend
`--background` for anything beyond 1-2 files.
