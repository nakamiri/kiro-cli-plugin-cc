---
description: Cancel an active background Kiro job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Raw slash-command arguments: $ARGUMENTS

Work out the command line first, then make exactly one `Bash` call.

- No arguments: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" cancel`
- A job ID: it must match `^kiro-[0-9a-z]+-[0-9a-z]+$`. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" cancel '<job-id>'` with the
  ID single-quoted.
- Anything else: run nothing, and tell the user it is not a valid job ID.

Quoting matters here. `allowed-tools` pre-approves `Bash(node:*)` for this
command, so whatever ends up on that command line runs without a permission
prompt. Never paste the raw arguments in unchecked, and never wrap them in a
command substitution -- that stops the prefix rule from matching and turns
every invocation into a prompt.

Report the command output to the user verbatim.
