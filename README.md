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

## Install

```bash
# Add the marketplace
/plugin marketplace add nakamiri/kiro-cli-plugin-cc

# Install the plugin
/plugin install kiro-cli@kiro-cli-plugin

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

**Note**: The compiled output in `plugins/kiro-cli/scripts/lib/` is committed to the repository so that Claude Code can run the plugin without a build step on the user's machine. After modifying any TypeScript source, run `pnpm build` and commit the regenerated files.

## License

MIT
