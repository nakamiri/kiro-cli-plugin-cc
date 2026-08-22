---
description: Run a Kiro CLI code review against local git state
argument-hint: '[--wait|--background] [--base <ref>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Raw slash-command arguments: $ARGUMENTS

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Kiro's output verbatim to the user.

Choose the execution mode **before** running anything:
- `--wait` present: run in the foreground.
- `--background` present: run in the background.
- Neither: check the size of the change first (`git diff --stat`). Beyond 1-2
  files, add `--background` and tell the user why. Otherwise run in the
  foreground.

Then make exactly one `Bash` call, forwarding the arguments as separate
single-quoted arguments, for example:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" review '--base' 'main' 'the auth paths'
```

Quoting matters here. `allowed-tools` pre-approves `Bash(node:*)` for this
command, so whatever ends up on that command line runs without a permission
prompt. Never paste the raw arguments in unchecked, and never wrap them in a
command substitution -- that stops the prefix rule from matching and turns
every invocation into a prompt. Concretely:

- Single-quote each argument you forward.
- Write an embedded single quote as `'\''`.
- If an argument spans lines, or you cannot quote it confidently, forward it
  through a heredoc with a quoted delimiter instead and accept the permission
  prompt that comes with it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" review "$(cat <<'KIRO_ARGS_a41f7c2e'
<the arguments>
KIRO_ARGS_a41f7c2e
)"
```

A foreground review can take up to 300 seconds, so set the `Bash` tool timeout
to at least 310000 for it.

`--background` starts a detached job and prints
`{"jobId": "...", "status": "started"}` immediately. Do not also use
`run_in_background` -- the job already outlives the command. Report the job ID
and tell the user to check `/kiro-cli:status`.
