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

Then make exactly one `Bash` call.

**Flags only** -- forward each as its own argument:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" review '--base' 'main'
```

**With free-form focus text** -- flags stay in the command line, the text goes
in on stdin, and `--args-stdin` tells the script to pick it up there:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" review '--base' 'main' --args-stdin <<'KIRO_ARGS_a41f7c2e'
the auth paths
KIRO_ARGS_a41f7c2e
```

Use the stdin form whenever there is any free-form text at all. It is not about
convenience: `allowed-tools` pre-approves `Bash(node:*)` for this command, so
whatever lands on that command line runs without a permission prompt, and
getting arbitrary text safely into it depends entirely on your quoting. A single
apostrophe -- "don't break the build" -- unbalances it and the remainder is
word-split and expanded. The heredoc body is not interpreted at all, so there is
nothing to get wrong. Never wrap the arguments in a command substitution.

A foreground review can take up to 300 seconds, and the script waits a little
longer than that before giving up, so set the `Bash` tool timeout to at least
320000 for it.

`--background` makes the script print `{"jobId": "...", "status": "started"}`
immediately. Report the job ID and tell the user to check `/kiro-cli:status`.
