---
description: Cancel an active background Kiro job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" cancel '$ARGUMENTS'`
