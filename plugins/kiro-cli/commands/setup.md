---
description: Check whether kiro-cli is installed and ready
argument-hint: ''
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" setup*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs setup*)
---

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" setup --json
```

If the result says kiro-cli is unavailable:
- Tell the user to install Kiro CLI from https://kiro.dev

If kiro-cli is already installed:
- Present the setup output to the user.
