# Diptych Picker

A local-first, iterative two-image preference game. Pick A or B; the exact winner stays on the same side while only the loser is replaced by one independently generated challenger.

## Run with Codex

Install dependencies once:

```bash
npm install
cp .env.example .env.local
```

Then open an interactive Codex CLI session in the repository root:

```bash
codex
```

Ask Codex to run Diptych Picker or invoke `$run-diptych-picker`. The repo-local skill in `.agents/skills/run-diptych-picker/` starts the Next.js app, remains active, monitors the durable mailbox, and uses the current CLI session plus native image-generation subagents as the AI backend. Open <http://localhost:3000> after the skill reports readiness.

The web server never launches `codex`, calls an OpenAI API, or receives an API key. Model choice, authentication, permissions, and subagent execution belong to the interactive CLI session.

## Generation loop

The app writes a request under `.local-data/agent-mailbox/` and immediately returns a generating state. The persistent coordinator claims that request, delegates one standalone image to a fresh subagent, validates the result, and publishes an immutable PNG under `.local-data/assets/`. The browser polls local game state and preloads the challenger before replacing only the loser.

The selected winner is never sent through an image-editing model. Its candidate ID, URL, bytes, metadata, side, object identity in the active browser state, and `<img>` node remain unchanged.

If Codex closes during a job, the current images and mailbox remain on disk. Reopen `codex` in the repository and run the skill again; its startup recovery resumes the active job. Completion and failure helpers are idempotent, and opposite terminal outcomes cannot both win.

## Initial candidates

Two standalone PNGs are documented under `public/seed-assets/`. When both exist, a new game starts from them immediately.

If either seed is absent—or `GENERATE_INITIAL_CANDIDATES=true`—the browser shows an initializing screen with no candidate `<img>` elements. The app enqueues two jobs sharing one batch ID. The coordinator claims both sides and delegates exactly two image workers in parallel, then the app verifies both immutable assets before presenting round 1. Refreshing does not enqueue duplicates, and a failed pair offers a retry.

## Local storage

`LOCAL_DATA_DIR` defaults to `.local-data`. It contains:

- `game-state.json`: current round, history, preference seed, and cleanup marker.
- `initial-bootstrap.json`: restart-safe generated-initial batch state.
- `agent-mailbox/`: pending, active, outcome, terminal-result, heartbeat, and ID-tombstone files.
- `agent-work/`: per-job proposal, failure, and generated-image handoff files.
- `assets/`: immutable generated PNGs served through stable `/api/assets/...` URLs.

Game and bootstrap repositories use atomic writes and local locks. Mailbox IDs remain tombstoned after archival to prevent replay. Asset verification fully decodes PNGs and checks canonical URL, byte count, dimensions, and square format before state changes.

`GET /api/game` and `POST /api/game/start` return a tagged state: `{ status: "ready", game }`, `{ status: "initializing", ... }`, or `{ status: "initialization-error", ... }`.

## Mock mode

Automated tests set `GENERATION_PROVIDER=mock`. This enables a deterministic in-process mailbox worker that creates local PNGs and makes no model, network, or API calls. Normal CLI-backed use leaves `GENERATION_PROVIDER=agent` (or unset).

## Controls

- Click the complete A or B card.
- Press `A` or `1` for the left image.
- Press `B` or `2` for the right image.
- Edit the inspiration seed through **Preferences**.
- **New game** requires confirmation and clears the current round and history.

## Verification

```bash
npm run format:check
npm run lint
npm test
npm run build
npm run test:e2e
```

Playwright starts the app in deterministic mock mode with isolated `.local-data/test` state. Its suite covers generated startup, both winner sides, double-click suppression, refresh restoration, loser-only loading, retry, two independent images, narrow side-by-side layout, and winner-node preservation.

## Architecture

- `.agents/skills/run-diptych-picker/`: persistent coordinator workflow, protocol, and validated mailbox helper scripts.
- `src/domain/game.ts`: explicit candidate, round, history, and tagged startup state.
- `src/server/agent-mailbox.ts`: validated durable job/result protocol and restart recovery.
- `src/server/game-service.ts`: transactional selection, result verification, winner-preserving reconciliation, and cleanup retry.
- `src/server/initial-game.ts`: seed-or-generated initial-pair orchestration.
- `src/server/repository.ts` and `initial-bootstrap.ts`: atomic local persistence behind interfaces.
- `src/server/asset-store.ts`: immutable PNG storage and verification.
- `src/components/game-screen.tsx`: async polling, preload-before-swap, keyboard controls, and exactly two candidate images once ready.
