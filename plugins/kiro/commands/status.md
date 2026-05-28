---
description: Show active and recent Kiro jobs for this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" status $ARGUMENTS`

If the user did not pass a job ID:
- Render the command output as a Markdown table.
- Keep it compact.

If the user did pass a job ID:
- Present the full command output to the user.
