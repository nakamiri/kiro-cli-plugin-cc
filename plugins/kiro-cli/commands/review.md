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
- `--background` present: forward it to the script.
- Neither: check the size of the change first (`git diff --stat`). Beyond 1-2
  files, add `--background` to the arguments and tell the user why. Otherwise
  run in the foreground.

"Background" here always means passing `--background` to the script, never the
`Bash` tool's `run_in_background`: the script detaches the job itself and needs
to print the job ID back to you.

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

- Forward each flag as its own argument: `'--background'`, `'--base' 'main'`.
  The script matches flags against whole arguments, so a flag buried inside a
  larger string is treated as prompt text, not as a flag.
- Put all remaining free-form text in one final argument.
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

`--background` makes the script print `{"jobId": "...", "status": "started"}`
immediately. Report the job ID and tell the user to check `/kiro-cli:status`.
