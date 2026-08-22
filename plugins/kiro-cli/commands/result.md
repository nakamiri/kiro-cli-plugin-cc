---
description: Show the stored final output for a finished Kiro job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run exactly one command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" result "$(cat <<'KIRO_ARGS_a41f7c2e'
$ARGUMENTS
KIRO_ARGS_a41f7c2e
)"
```

The quoted heredoc delimiter is what makes this safe: the shell performs no
expansion at all inside the body, so arguments containing `$(...)`, backticks,
quotes or apostrophes are passed through as plain text. Do not replace it with
an inline `'$ARGUMENTS'` -- a single quote in the arguments would end the
quoting and the rest would run as shell commands.

Present the full command output to the user. Do not summarize or condense it.
