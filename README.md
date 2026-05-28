# Kiro CLI plugin for Claude Code

Use Kiro CLI from inside Claude Code for code reviews or to delegate tasks.

## What You Get

- `/kiro:review` — run a Kiro CLI code review on your current changes
- `/kiro:rescue` — delegate investigation or fix work to Kiro CLI
- `/kiro:status` — show running and recent Kiro jobs
- `/kiro:result` — show the final output of a completed job
- `/kiro:cancel` — cancel an active background job
- `/kiro:setup` — check whether kiro-cli is installed and ready

## Requirements

- **Kiro CLI** installed and authenticated (`kiro-cli`)
- **Node.js 18.18 or later**

## Install

```bash
# Add the marketplace (once you have a marketplace URL)
/plugin marketplace add nakamiri/kiro-cli-plugin-cc

# Install the plugin
/plugin install kiro@nakamiri-kiro

# Reload
/reload-plugins
```

Then run:

```
/kiro:setup
```

If kiro-cli is not installed, see https://kiro.dev to download and install Kiro CLI.

## Usage

### `/kiro:review`

Runs a Kiro CLI code review on your current work.

```
/kiro:review
/kiro:review --base main
/kiro:review --background
```

### `/kiro:rescue`

Hands a task to Kiro CLI.

```
/kiro:rescue investigate why the tests are failing
/kiro:rescue --background fix the flaky integration test
```

### `/kiro:status`

```
/kiro:status
/kiro:status <job-id>
```

### `/kiro:result`

```
/kiro:result
/kiro:result <job-id>
```

### `/kiro:cancel`

```
/kiro:cancel
/kiro:cancel <job-id>
```

## Development

```bash
npm install
npm run build
```

TypeScript source is in `src/`, compiled output goes to `plugins/kiro/scripts/lib/`.

## License

MIT
