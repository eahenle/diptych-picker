# Getting started

Diptych Picker is a local-first image preference game. It can run as a
deterministic offline demo or use an interactive Codex CLI session to generate
new challengers.

## Requirements

- macOS or Linux
- Node.js 24 or newer
- npm 11 or newer
- Codex CLI only for generated-image mode

The application binds to `127.0.0.1` and is designed for one user on one
machine. Read [Security](../SECURITY.md) before changing that boundary.

## Install

```bash
git clone https://github.com/eahenle/diptych-picker.git
cd diptych-picker
npm ci
```

`package-lock.json` is authoritative. Use `npm ci` for reproducible installs.

## Try the offline demo

```bash
npm run demo
```

Open <http://127.0.0.1:3000>. The demo uses the bundled seed images and a
deterministic local worker. It makes no model or network calls after dependency
installation.

Demo state is stored separately under `.local-data/demo`. To choose another
port or state directory:

```bash
PORT=3001 DIPTYCH_DEMO_DATA_DIR=.local-data/my-demo npm run demo
```

Start by selecting A or B. The winner remains exactly where it is and only the
losing image changes. The [User guide](USER_GUIDE.md) covers ties, favorites,
preferences, prompt cards, saves, and the rest of the interface.

## Run with generated challengers

Install and authenticate the Codex CLI:

```bash
npm install --global @openai/codex
codex login
npm run codex:play
```

The launcher requests eight total agent threads: one interactive root
supervisor, one persistent mailbox monitor, up to three fresh image workers,
and spare capacity for bounded supporting work. Open
<http://127.0.0.1:3000> after the CLI reports readiness.

Confirm that the running server is agent-backed:

```bash
curl -sS -D - http://127.0.0.1:3000/api/game -o /dev/null \
  | tr -d '\r' \
  | grep -i '^x-diptych-generation-provider: agent$'
```

The web application never receives an API key and never launches a model
process. Authentication and generation remain in the interactive CLI session.
See [Agent mode](AGENT_MODE.md) for the process and recovery model.

## Run the app without launching Codex

If a compatible mailbox worker is already running:

```bash
npm run run:production
```

This builds and serves the optimized app with the `agent` provider. It does not
start a monitor or generate images on its own.

## Verify a checkout

```bash
npm run check
npm run build
npm run test:e2e
```

The browser suite uses isolated mock state and does not touch the normal local
game.

## Where to go next

- [User guide](USER_GUIDE.md) — all gameplay and editing features
- [Examples](../examples/README.md) — reproducible feature scenarios and API scripts
- [Configuration](CONFIGURATION.md) — environment variables and precedence
- [Data and recovery](DATA_AND_RECOVERY.md) — local files, backup, restore, and privacy
- [Local API](API.md) — loopback endpoints and request examples
- [Contributing](../CONTRIBUTING.md) — development and pull-request workflow
