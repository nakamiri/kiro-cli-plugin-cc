---
description: Run a Kiro CLI code review against local git state
argument-hint: '[--wait|--background] [--base <ref>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Raw slash-command arguments: $ARGUMENTS

Before building any command line, check the `--base` ref if one was given: it
must match `^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$` (`main`, `origin/main`, `v1.2.3`,
`HEAD~3`). If it does not, run nothing at all and tell the user it is not a
usable git ref. Both this command's Bash rules are pre-approved, so an unchecked
ref would run without a permission prompt.

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Kiro's output verbatim to the user.

Choose the execution mode **before** running anything:
- `--wait` present: run in the foreground.
- `--background` present: forward it to the script.
- Neither: check the size of the change first with exactly
  `git diff --stat HEAD` -- that literal command, never with the user's `--base`
  ref substituted into it. `allowed-tools` pre-approves `Bash(git:*)`, so an
  unchecked ref there would run without a permission prompt, and this is only an
  estimate of how much has changed. (Plain `git diff --stat`, without `HEAD`,
  shows only unstaged work, so a fully staged change reads as nothing at all.)
  Beyond 1-2 files, add `--background` to the arguments and tell the user why.
  Otherwise run in the foreground.

"Background" here always means passing `--background` to the script, never the
`Bash` tool's `run_in_background`: the script detaches the job itself and needs
to print the job ID back to you.

Run the review with exactly one `Bash` call. The read-only checks above -- the
`git diff --stat HEAD` size check and the timeout probe below -- may each take a
call of their own first; nothing else may.

**Flags only** -- forward each as its own argument:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" review '--base' 'main'
```

**With free-form focus text** -- flags stay in the command line, the text goes
in on stdin, and `--args-stdin` tells the script to pick it up there:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" review '--base' 'main' --args-stdin <<'KIRO_ARGS_<pick-your-own>'
the auth paths
KIRO_ARGS_<pick-your-own>
```

Pick the heredoc delimiter yourself, per call, and check it: it must not appear
on a line of its own anywhere in the text you are passing. A fixed, published
delimiter is not a defence -- text containing that exact line closes the heredoc
early and everything after it runs as shell commands in this same pre-approved
call. Use something like `KIRO_ARGS_` plus a few random characters, and if the
text does contain it, lengthen the delimiter until it does not.

Use the stdin form whenever there is any free-form text at all. It is not about
convenience: `allowed-tools` pre-approves `Bash(node:*)` for this command, so
whatever lands on that command line runs without a permission prompt, and
getting arbitrary text safely into it depends entirely on your quoting. A single
apostrophe -- "don't break the build" -- unbalances it and the remainder is
word-split and expanded. The heredoc body is not interpreted at all, so there is
nothing to get wrong. Never wrap the arguments in a command substitution.

The `--base` ref is the one piece of user input that has to stay on the command
line, which is why it is checked before anything is built (see the top of this
file). The script rejects anything outside that set too, but by then the command
line has already been assembled.

A foreground review runs until the script's own budget expires, and the script
waits a little beyond that before giving up, so the `Bash` tool timeout has to
be larger than both. With the default budget that is 320000. The budget is
configurable (`KIRO_PLUGIN_TIMEOUT_MS`), so if it may have been changed, read
`recommendedBashTimeoutMs` first and use that instead of assuming the default:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kiro-companion.mjs" setup --json
```

Run the script directly, as above. All you need from it is one number;
`/kiro-cli:setup` exists to report readiness to the user, and running it here
would put its install advice in front of them mid-review.

`--background` makes the script print `{"jobId": "...", "status": "started"}`
immediately. Report the job ID and tell the user to check `/kiro-cli:status`.
