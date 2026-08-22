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

## Tool trust

By default the plugin invokes `kiro-cli chat --trust-all-tools`, which lets Kiro
read and write files and run commands in your repository without prompting. That
is what makes `/kiro-cli:rescue` able to actually fix things, but it means a
Kiro run has the same reach over your working tree as you do.

To require Kiro's own per-tool confirmations instead:

```bash
export KIRO_PLUGIN_TRUST_ALL_TOOLS=0
```

The variable fails closed: once it is set, trust is kept only for an explicitly
affirmative value (`1`, `true`, `yes`, `on`), so a typo reduces trust rather
than silently granting it.

`/kiro-cli:setup` reports which mode is active.

### How arguments reach the script

The slash commands pass flags as ordinary arguments and any free-form text on
stdin, via `--args-stdin`:

```bash
node .../kiro-companion.mjs review '--base' 'main' --args-stdin <<'EOF'
the auth paths
EOF
```

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
| `KIRO_PLUGIN_TRUST_ALL_TOOLS` | enabled when unset | Once set, only `1`/`true`/`yes`/`on` keeps `--trust-all-tools`; anything else drops it |
| `KIRO_PLUGIN_JOBS_DIR` | `$TMPDIR/kiro-plugin-cc-jobs-<uid>` (mode 0700) | Where background job records are stored |
| `KIRO_PLUGIN_TIMEOUT_MS` | `300000` | Timeout for foreground runs (capped at 2147483647) |
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

Hands a task to Kiro CLI.

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

**Note**: The compiled output in `plugins/kiro-cli/scripts/lib/` is committed to the repository so that Claude Code can run the plugin without a build step on the user's machine. After modifying any TypeScript source, run `pnpm build` and commit the regenerated files.

## License

MIT
