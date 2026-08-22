---
description: Check whether kiro-cli is installed and ready
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" setup --json $ARGUMENTS
```

If the result says kiro-cli is unavailable:
- Tell the user to install Kiro CLI from https://kiro.dev

If kiro-cli is already installed:
- Present the setup output to the user.
