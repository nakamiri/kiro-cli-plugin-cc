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
- **Node.js 18.18 or later**

## What Kiro is allowed to do

Each run is given a permission set that matches what the command is for.
`/kiro-cli:review` can read the repository and run read-only git; it cannot
write a file or run any other command. `/kiro-cli:rescue` can read, write and run
commands, because that is what fixing something takes.

This is enforced by kiro-cli's v3 agent engine, whose permission rules are
per-capability and per-operation:

| Command | Allowed |
| --- | --- |
| `/kiro-cli:review` | `fs_read` anywhere; shell limited to `git diff`, `git status`, `git log`, `git show`, `git rev-parse`, `git ls-files`, `git branch --list`, `git blame` |
| `/kiro-cli:rescue` | `fs_read`, `fs_write` and shell, anywhere in the repository |

The rules live in an agent config the plugin writes to `.kiro/agents/` when a run
starts and removes when it ends, named after the job so two runs never share one
file. A checkout is never left carrying it: cancellation, a timeout and a crash
all tear it down, and a config left by a killed supervisor is swept on the next
run. Nothing is written to your home directory, and an existing `.kiro/`
directory is never removed.

Neither agent inherits your `mcp.json`. A review has no reason to reach a
database or a ticket tracker.

**On the shell allowance for `rescue`**: naming the three capabilities is not a
reduction in blast radius, and is not offered as one. A shell allowance is
arbitrary command execution. What the config buys is that the surface is
declared and reviewable, and that anything outside it -- MCP tools, other
capabilities -- is refused. For `review` the restriction is real: without
`fs_write` and with the shell limited to reporting commands, a review cannot
change your working tree.

### The older engine

`KIRO_PLUGIN_AGENT_ENGINE=v2` runs the previous engine, which behaves exactly as
it always did: `kiro-cli chat --trust-all-tools`, no per-command rules, and
nothing written to `.kiro/`. Use it if your kiro-cli predates the v3 engine.

On v2 only, `KIRO_PLUGIN_TRUST_ALL_TOOLS=0` removes the trust flag altogether.
That is not "ask me first": the plugin always runs `--no-interactive`, so there
is nobody for Kiro to ask, and without trust it analyses and reports while
changing nothing. The variable fails closed -- once set, trust is kept only for
an explicitly affirmative value (`1`, `true`, `yes`, `on`), so a typo reduces
trust rather than silently granting it. It has no effect on v3, where the agent
config is what grants access.

`/kiro-cli:setup` reports the engine in use and, on v3, the exact rules.

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
| `KIRO_PLUGIN_AGENT_ENGINE` | `v3` | `v2` runs the previous engine: `--trust-all-tools`, no per-command rules, nothing written to `.kiro/` |
| `KIRO_PLUGIN_TRUST_ALL_TOOLS` | enabled when unset | **v2 only.** Once set, only `1`/`true`/`yes`/`on` keeps `--trust-all-tools`; anything else drops it, leaving Kiro read-only |
| `KIRO_PLUGIN_JOBS_DIR` | `$TMPDIR/kiro-plugin-cc-jobs-<uid>` (mode 0700) | Where background job records are stored |
| `KIRO_PLUGIN_TIMEOUT_MS` | `300000` | Timeout for foreground runs (capped at 2147483647) |
|  |  | `/kiro-cli:setup --json` reports `recommendedBashTimeoutMs` for this |
| `KIRO_PLUGIN_BACKGROUND_TIMEOUT_MS` | `1800000` | Timeout for background jobs (capped at 2147483647) |
| `KIRO_PLUGIN_MAX_OUTPUT_BYTES` | `10485760` | Cap on captured Kiro output |
| `KIRO_PLUGIN_NODE` | the running `node` | Node binary used to launch a job's supervisor |
| `KIRO_PLUGIN_JOB_TTL_MS` | `604800000` | Age at which a finished job record is pruned |
| `KIRO_PLUGIN_MAX_JOBS` | `50` | Cap on retained finished job records |
| `KIRO_PLUGIN_MAX_JOB_BYTES` | `67108864` | Cap on retained transcript bytes across all records |

Job records contain Kiro's full output, including source code from private
repositories, so the jobs directory is per-user and not world-readable.
Finished records are pruned when a new job starts -- by age, by count and by
total transcript bytes -- so the store stays bounded. A job still running is
never pruned.

A store left at the pre-`0.1.0` path (`$TMPDIR/kiro-plugin-cc-jobs`, without the
per-user suffix) is tightened and its records moved into the current one the
first time any command runs. Files the plugin did not write are left untouched.

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

Hands a task to Kiro CLI. A task is required -- with none given the command
reports an error rather than inventing one.

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

### Tests

`pnpm test` runs `tests/*.test.mjs`, which is what CI runs. Most of it is
in-process: `args.test.mjs`, `jobs.test.mjs` and `store.test.mjs` call the
exported functions directly, and the three `process-*.test.mjs` files spawn real
processes for the things only a process can show -- detachment, signals, pid
identity, pipes and timeouts.

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
