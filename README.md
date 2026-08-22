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

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `KIRO_CLI_PATH` | resolved via `which kiro-cli` | Explicit path to the `kiro-cli` binary |
| `KIRO_PLUGIN_TRUST_ALL_TOOLS` | enabled when unset | Once set, only `1`/`true`/`yes`/`on` keeps `--trust-all-tools`; anything else drops it |
| `KIRO_PLUGIN_JOBS_DIR` | `$TMPDIR/kiro-plugin-cc-jobs-<uid>` (mode 0700) | Where background job records are stored |
| `KIRO_PLUGIN_TIMEOUT_MS` | `300000` | Timeout for foreground runs |
| `KIRO_PLUGIN_BACKGROUND_TIMEOUT_MS` | `1800000` | Timeout for background jobs |
| `KIRO_PLUGIN_MAX_OUTPUT_BYTES` | `10485760` | Cap on captured Kiro output |

Job records contain Kiro's full output, including source code from private
repositories, so the jobs directory is per-user and not world-readable.

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
| `src/jobs.ts` | Background job records: storage, validation, liveness |
| `src/kiro-runner.ts` | Detached supervisor that owns a background Kiro run |

**Note**: The compiled output in `plugins/kiro-cli/scripts/lib/` is committed to the repository so that Claude Code can run the plugin without a build step on the user's machine. After modifying any TypeScript source, run `pnpm build` and commit the regenerated files.

## License

MIT
