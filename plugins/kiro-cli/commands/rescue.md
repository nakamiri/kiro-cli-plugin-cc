---
description: Delegate a task to Kiro CLI for investigation or fixing
argument-hint: '[--background|--wait] [task description]'
allowed-tools: Bash(node:*), Bash(git:*), Agent
---

Invoke the `kiro-cli:kiro-rescue` subagent via the `Agent` tool (`subagent_type: "kiro-cli:kiro-rescue"`), forwarding the raw user request as the prompt.

Raw user request: $ARGUMENTS

Execution mode:
- Forward `--background` / `--wait` verbatim; the companion script handles both.
- With `--background` the script returns a job ID immediately, so do not run the
  subagent itself in the background.

Operating rules:
- The subagent forwards to `node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" rescue ...`.
- Return the Kiro output verbatim to the user.
- Do not paraphrase, summarize, or add commentary.
- If the user did not supply a request, ask what Kiro should investigate or fix.
