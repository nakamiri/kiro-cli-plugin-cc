---
description: Check whether kiro-cli is installed and ready
argument-hint: ''
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" setup --json $ARGUMENTS
```

If the result says kiro-cli is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether to install kiro-cli now.
- Options:
  - `Install kiro-cli (Recommended)`
  - `Skip for now`
- If the user chooses install, run:
```bash
npm install -g @anthropic-ai/kiro-cli
```
- Then rerun setup.

If kiro-cli is already installed:
- Present the setup output to the user.
