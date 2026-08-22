---
description: Show active and recent Kiro jobs for this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Raw slash-command arguments: $ARGUMENTS

Work out the command line first, then make exactly one `Bash` call.

- No arguments: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" status`
- A job ID: it must match `^kiro-[0-9a-z]+-[0-9a-z]+$`. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" status '<job-id>'` with the
  ID single-quoted.
- Anything else: run nothing, and tell the user it is not a valid job ID.

Validate before you build the command line, not after. `allowed-tools`
pre-approves `Bash(node:*)` here, so whatever ends up on it runs without a
permission prompt -- but an argument that matches the job-ID pattern contains no
shell metacharacters, so checking it first is what makes quoting sufficient.
Never pass text through unchecked, and never wrap it in a command substitution.

If the user did not pass a job ID:
- Render the command output as a Markdown table.
- Keep it compact.

If the user did pass a job ID:
- Present the full command output to the user.
