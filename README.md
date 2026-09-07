# Kiro CLI plugin for Claude Code

Use Kiro CLI from inside Claude Code for code reviews or to delegate tasks.

## What You Get

- `/kiro-cli:review` — run a Kiro CLI code review on your current changes
- `/kiro-cli:rescue` — delegate investigation or fix work to Kiro CLI
- `/kiro-cli:status` — show running and recent Kiro jobs
- `/kiro-cli:result` — show the final output of a completed job
- `/kiro-cli:cancel` — cancel an active background job
- `/kiro-cli:setup` — check whether kiro-cli is installed and ready

## Requirements

- **Kiro CLI** installed and authenticated (`kiro-cli`)
- **Node.js 24 or later**

## Who can start a run

Four of the commands run only when you type them. Two do not: `/kiro-cli:setup`
and `/kiro-cli:rescue` are also reachable by Claude itself, so Claude can decide
on its own to check that kiro-cli is ready, or to hand a task to Kiro.

`setup` only reports. `rescue` does not -- it starts a Kiro run with tool trust,
which can write to your working tree. Taking the trust away does not stop Claude
from starting a rescue; it means the run it starts can only analyse and report.

A command's `allowed-tools` is a grant, not a limit: the tools it names are
pre-approved for the turn that runs the command, and that grant reaches the
subagent the command delegates to. So a model-reachable command is also a way
for Claude to hand itself those tools without asking. Both of these name the
companion script exactly rather than allowing `node` in general, which keeps
that grant to the one program the command actually runs. `rescue` grants `Agent`
as well, because delegating to its subagent is the whole of what it does. That
one is not narrowed: it names no `subagent_type`, so the turn can start any
subagent, not only `kiro-cli:kiro-rescue`. The four typed-only commands, `review`
in particular, still pre-approve `node` broadly -- but only from the turn you
started by typing them.

## Tool trust

By default the plugin invokes `kiro-cli chat --trust-all-tools`, which lets Kiro
read and write files and run commands in your repository without prompting. That
is what makes `/kiro-cli:rescue` able to actually fix things, but it means a
Kiro run has the same reach over your working tree as you do.

To take that away:

```bash
export KIRO_PLUGIN_TRUST_ALL_TOOLS=0
```

This is not "ask me first". The plugin always runs `kiro-cli chat
--no-interactive`, so there is nobody for Kiro to ask: without tool trust it
analyses and reports, and changes nothing. That is what you want for
`/kiro-cli:review`, and it makes `/kiro-cli:rescue` advisory -- it will explain
what it would do rather than do it.

The variable fails closed: once it is set, trust is kept only for an explicitly
affirmative value (`1`, `true`, `yes`, `on`), so a typo reduces trust rather
than silently granting it.

`/kiro-cli:setup` reports which mode is active.

### How arguments reach the script

The slash commands pass flags as ordinary arguments and any free-form text on
stdin, via `--args-stdin`:

```bash
node .../kiro-companion.mjs review '--base' 'main' --args-stdin <<'KIRO_ARGS_xyz'
the auth paths
KIRO_ARGS_xyz
```

The delimiter is chosen per call and checked against the text, so a request that
happens to contain it cannot close the heredoc early.

A slash command can only interpolate its arguments into a shell command line,
and getting arbitrary text through that intact depends entirely on quoting it
correctly -- one apostrophe in "don't break the build" unbalances it. A heredoc
body is not interpreted at all, so there is nothing to get wrong.

### Terminal control sequences

kiro-cli colours its output and moves the cursor even under `--no-interactive`,
so a run emits SGR colours, `?25l`/`?25h` and `1G`. That output is read in Claude
Code rather than a terminal, where the sequences are literal `ESC[0m` noise, so
they are removed as the output is captured -- a real review came to 7218 bytes
raw and 5820 stripped. Newlines and tabs are kept; the other control characters
go with the sequences.

`KIRO_PLUGIN_STRIP_ANSI=0` stores the raw bytes instead, for when the sequences
are what you are looking at.

### Prompts are visible in the process list

Kiro CLI takes its prompt as a command-line argument, so for the duration of a
run the review request or task description is visible to any other user on the
same host via `ps` or `/proc/<pid>/cmdline`. This is inherent to invoking
`kiro-cli chat <prompt>` and is not something the plugin can hide. Job records
and transcripts on disk are not exposed this way -- they are 0600 in a 0700
per-user directory. On a shared host, keep sensitive context out of the prompt.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `KIRO_CLI_PATH` | resolved via `which kiro-cli` | Explicit path to the `kiro-cli` binary |
| `KIRO_PLUGIN_TRUST_ALL_TOOLS` | enabled when unset | Once set, only `1`/`true`/`yes`/`on` keeps `--trust-all-tools`; anything else drops it, leaving Kiro read-only |
| `KIRO_PLUGIN_JOBS_DIR` | `$TMPDIR/kiro-plugin-cc-jobs-<uid>` (mode 0700) | Where background job records are stored |
| `KIRO_PLUGIN_TIMEOUT_MS` | `300000` | Timeout for foreground runs (capped at 2147483647) |
|  |  | `/kiro-cli:setup --json` reports `recommendedBashTimeoutMs` for this |
| `KIRO_PLUGIN_BACKGROUND_TIMEOUT_MS` | `1800000` | Timeout for background jobs (capped at 2147483647) |
| `KIRO_PLUGIN_MAX_OUTPUT_BYTES` | `10485760` | Cap on captured Kiro output |
| `KIRO_PLUGIN_NODE` | the running `node` | Node binary used to launch a job's supervisor |
| `KIRO_PLUGIN_JOB_TTL_MS` | `604800000` | Age at which a finished job record is pruned |
| `KIRO_PLUGIN_MAX_JOBS` | `50` | Cap on retained finished job records |
| `KIRO_PLUGIN_MAX_JOB_BYTES` | `67108864` | Cap on retained transcript bytes across all records |
| `KIRO_PLUGIN_STRIP_ANSI` | enabled when unset | Set to `0` to store Kiro's output with its terminal control sequences intact |

The rest are internal timings. They exist so the test suite can shorten them --
the 30s version probe and the 10s PATH lookup alone cost it 40 seconds -- and
are documented because a value that changes behaviour should be findable.

| Variable | Default | Purpose |
| --- | --- | --- |
| `KIRO_PLUGIN_VERSION_PROBE_MS` | `30000` | How long `setup` waits for `kiro-cli --version` |
| `KIRO_PLUGIN_PATH_LOOKUP_MS` | `10000` | How long the `PATH` lookup for `kiro-cli` may take |
| `KIRO_PLUGIN_CANCEL_SETTLE_MS` | `2000` | How long `cancel` lets a signalled runner record its own outcome |
| `KIRO_PLUGIN_RECONCILE_MS` | `5000` | How often a foreground wait pays for a full reconciling read |
| `KIRO_PLUGIN_FLUSH_GRACE_MS` | `2000` | How long the supervisor waits for the pipes to drain after kiro-cli exits |
| `KIRO_PLUGIN_STDIN_STALL_MS` | `5000` | How long a single stall while reading stdin is tolerated |

All six are capped at 2147483647, the `setTimeout` limit.

Job records contain Kiro's full output, including source code from private
repositories, so the jobs directory is per-user and not world-readable.
Finished records are pruned when a new job starts -- by age, by count and by
total transcript bytes -- so the store stays bounded. A job still running is
never pruned.

A store left at the pre-`0.1.0` path (`$TMPDIR/kiro-plugin-cc-jobs`, without the
per-user suffix) is tightened and its records moved into the current one the
first time a command opens the store. `setup` never does, so a session that only
checks readiness leaves the old path alone. Files the plugin did not write are
left untouched.

## Install

```bash
# Add the marketplace
/plugin marketplace add nakamiri/kiro-cli-plugin-cc

# Install the plugin
/plugin install kiro-cli@kiro-cli-plugin-cc

# Reload
/reload-plugins
```

Then run:

```
/kiro-cli:setup
```

If kiro-cli is not installed, see https://kiro.dev to download and install Kiro CLI.

The marketplace entry pins the plugin to a release tag, so what you install is
that tag rather than the tip of `main`. Changes merged to `main` reach you when
they are released.

### Moving to a newer release

Update the marketplace first. `/plugin update` on its own reports nothing to do,
because the release tag it would install is named in a `marketplace.json` that
Claude Code holds a local clone of, and that clone is still on the old release:

```bash
/plugin marketplace update kiro-cli-plugin-cc
/reload-plugins
```

The marketplace name is `kiro-cli-plugin-cc`, not the `owner/repo` slug that
added it. Updating the marketplace usually installs the new release with it --
`1 plugin bumped` in the output means it did, and `/plugin update
kiro-cli@kiro-cli-plugin-cc` finishes the job when it does not. `/reload-plugins`
is enough to pick up either; the session does not have to be restarted.

## Usage

### `/kiro-cli:review`

Runs a Kiro CLI code review on your current work.

```
/kiro-cli:review
/kiro-cli:review --base main
/kiro-cli:review --background
```

`--background` starts a detached job and returns a job ID immediately. The job
keeps running -- and still records its result -- even if the Claude Code session
that started it goes away. Track it with `/kiro-cli:status` and read it with
`/kiro-cli:result`.

Foreground runs go through the same supervisor and are recorded the same way,
so their output is retrievable with `/kiro-cli:result` afterwards.

A job is stored as two files: `<id>.json` holds its metadata and `<id>.out`
holds Kiro's transcript. `/kiro-cli:status` reads only the metadata, so listing
jobs costs the same whether the transcripts behind them are kilobytes or
gigabytes; `/kiro-cli:result` is what reads a transcript.

### `/kiro-cli:rescue`

Hands a task to Kiro CLI. A task is required: with none given the command asks
what Kiro should look at rather than inventing one, and the script underneath
refuses an empty task outright.

```
/kiro-cli:rescue investigate why the tests are failing
/kiro-cli:rescue --background fix the flaky integration test
```

### `/kiro-cli:status`

```
/kiro-cli:status
/kiro-cli:status <job-id>
```

### `/kiro-cli:result`

```
/kiro-cli:result
/kiro-cli:result <job-id>
```

### `/kiro-cli:cancel`

```
/kiro-cli:cancel
/kiro-cli:cancel <job-id>
```

## Development

```bash
pnpm install
pnpm build
pnpm test
```

TypeScript source is in `src/`, compiled output goes to `plugins/kiro-cli/scripts/lib/`.

| Module | Role |
| --- | --- |
| `src/kiro-companion.ts` | CLI entry point and slash-command implementations |
| `src/kiro.ts` | Locating `kiro-cli`, building its argv, timeouts |
| `src/jobs.ts` | Job store: metadata and transcripts, validation, liveness, pruning |
| `src/kiro-runner.ts` | Detached supervisor that owns a Kiro run and its process group |
| `src/ansi.ts` | Stripping terminal control sequences out of Kiro's output |

### Releasing

The marketplace entry points the plugin at a release tag
(`plugins[0].source.ref`), so tagging is what makes a merged change reach users.

1. In one PR, move the version everywhere it is written and the tag it will be
   released under: `version` in `package.json`, `metadata.version` and
   `plugins[0].version` in `.claude-plugin/marketplace.json`, `version` in
   `plugins/kiro-cli/.claude-plugin/plugin.json`, and `plugins[0].source.ref` to
   `v<version>`.
2. Merge it, then tag that commit `v<version>` and push. `release.yml` refuses to
   publish unless the tag and all four version fields agree, and it runs the
   build, the compiled-output check and the suite before creating the release.
3. `claude plugin tag plugins/kiro-cli --push` adds `kiro-cli--v<version>` at the
   same commit. Claude Code lists tags of that shape when it resolves a plugin
   version range.

Between the merge and the tag push, `main` names a tag that does not exist yet,
and an install started in that window fails. Push the tag right after merging.

### Tests

`pnpm test` runs `tests/*.test.mjs`, which is what CI runs. Most of it is
in-process: `ansi`, `args`, `jobs` and `store` call the exported functions
directly. The three `process-*.test.mjs` files spawn real processes for the
things only a process can show -- detachment, signals, pid identity, pipes and
timeouts -- and `e2e.test.mjs` runs the companion as a command.
`setup.test.mjs` sits between the two: it calls the exported functions, but some
of them reach the real launcher. `commands.test.mjs` runs none of the plugin's
code at all -- it reads the command files' frontmatter, which is where the
permission decisions live.

| Command | Runs |
| --- | --- |
| `pnpm test` | `tests/*.test.mjs` — the suite CI runs |
| `pnpm test:macos` | `tests/macos/*.test.mjs` — needs a machine with no `/proc` |
| `pnpm test:all` | both |

`tests/macos/` is outside the `pnpm test` glob on purpose. It covers the `ps`
side of the pid probe: `src/jobs.ts` reads a process's state and command line
from `/proc` where it exists and shells out to `ps` where it does not, and on
Linux that second path is never executed. Running those tests needs a machine
without `/proc`, so they are not part of CI — run them locally on macOS after
touching anything in `src/jobs.ts` that concerns pids, process groups or
liveness.

**Note**: The compiled output in `plugins/kiro-cli/scripts/lib/` is committed to the repository so that Claude Code can run the plugin without a build step on the user's machine. After modifying any TypeScript source, run `pnpm build` and commit the regenerated files.

## License

MIT
