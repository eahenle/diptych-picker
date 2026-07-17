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

## Challenger buffer and generation loop

An ordinary new game starts with two displayed candidates and a durable FIFO of five ready challengers. A selection consumes the FIFO head immediately, preloads that one image in the browser, and swaps only the losing card. Ready and in-flight candidates stay valid when the winner changes, so older work drains in FIFO order instead of being discarded.

Each selection restores the configured buffer deficit by writing `refill` requests under `.local-data/agent-mailbox/`. The persistent coordinator claims up to three independent refills at a time, delegates one standalone image to one fresh subagent per request, validates each result independently, and publishes immutable PNGs under `.local-data/assets/`. Keep the interactive Codex session and `$run-diptych-picker` coordinator alive while playing if you want generated refills to arrive in the background.

The selected winner is never sent through an image-editing model. Its candidate ID, URL, bytes, metadata, side, object identity in the active browser state, and `<img>` node remain unchanged.

If Codex closes during a job, the current images, ready queue, pool, and mailbox remain on disk. Reopen `codex` in the repository and run the skill again; startup recovery resumes unfinished refill batches and ordinary jobs. Completion and failure helpers are idempotent, and opposite terminal outcomes cannot both win.

## Curated and learned pools

Seven standalone curated PNGs and their strict manifest live under `public/seed-assets/`. A normal new game shuffles seven distinct eligible candidates: two are displayed and five fill the ready FIFO. Curated files are immutable at runtime.

Every comparison updates both candidates with Elo K=32. Generated candidates become eligible for the learned pool after comparison even when they have no wins, so a small pool preserves breadth instead of discarding useful alternatives prematurely. The effective curated-plus-learned pool is bounded by `CANDIDATE_POOL_SIZE` (50 by default); once full, a stronger candidate displaces only a strictly lower-rated lowest member, while rating history and immutable assets remain durable. Existing sessions backfill eligible rated candidates into available pool capacity.

If `GENERATE_INITIAL_CANDIDATES=true`, the browser instead shows an initializing screen with no candidate `<img>` elements. The app enqueues two jobs sharing one batch ID. The coordinator claims both sides and delegates exactly two image workers in parallel, then the app verifies both immutable assets before presenting round 1. Refreshing does not enqueue duplicates, and a failed pair offers a retry.

## Depleted-buffer fallback

When no ready challenger exists, the service may draw an eligible local-pool candidate immediately. A second fallback waits for half the measured generation-turnaround EMA, clamped between `CHALLENGER_FALLBACK_MIN_MS` and `CHALLENGER_FALLBACK_MAX_MS`. A third consecutive fallback is prohibited by default: the exact winner remains visible and only the losing card shows its loading treatment until a refill arrives. Consuming a ready seed or generated challenger resets the fallback counter.

## Local storage

`LOCAL_DATA_DIR` defaults to `.local-data`. It contains:

- `game-state.json`: current round, history, preference seed, and cleanup marker.
- `challenger-state.json`: session ownership, ready FIFO, refill receipts, Elo ratings, learned membership, turnaround EMA, and fallback counters.
- `initial-bootstrap.json`: restart-safe generated-initial batch state.
- `agent-mailbox/`: pending, active, outcome, terminal-result, heartbeat, and ID-tombstone files.
- `agent-work/`: per-job proposal, failure, and generated-image handoff files.
- `assets/`: immutable generated PNGs served through stable `/api/assets/...` URLs.

Game, challenger, and bootstrap repositories use atomic writes and a fixed local lock order. Mailbox IDs remain tombstoned after archival to prevent replay. Asset verification fully decodes PNGs and checks canonical URL, byte count, dimensions, and square format before state changes.

`GET /api/game` and `POST /api/game/start` return a tagged state: `{ status: "ready", game }`, `{ status: "initializing", ... }`, or `{ status: "initialization-error", ... }`.

## Mock mode

Automated tests set `GENERATION_PROVIDER=mock`. This enables a deterministic in-process mailbox worker that creates local PNGs and makes no model, network, or API calls. Normal CLI-backed use leaves `GENERATION_PROVIDER=agent` (or unset).

The buffer and pool defaults can be changed in `.env.local` with `CHALLENGER_BUFFER_SIZE=5` and `CANDIDATE_POOL_SIZE=50`. The turnaround and fallback variables shown in `.env.example` are mainly useful for deterministic pacing tests; their production defaults match the design above.

## Controls

- Click the complete A or B card.
- Press `A` or `1` for the left image.
- Press `B` or `2` for the right image.
- Shape future challengers through **Preferences**, with separate guidance for themes, media, visual style, palette, content range, and things to avoid. The modal stays openable while a selection waits; Save enables as soon as that challenger arrives.
- The quiet **Queue** and **Pool** readouts show ready challengers, active refill work, and reusable-image capacity without exposing mailbox or candidate details.
- **New game** requires confirmation and clears the current round and history.

## Verification

```bash
npm run format:check
npm run lint
npm test
npm run build
npm run test:e2e
```

Playwright starts the app in deterministic mock mode with isolated `.local-data/test` state. Its suite covers five instant FIFO swaps, stale work after a winner change, refresh persistence, double-click suppression, fallback pacing and its hard stop, deferred Preferences save, two independent images, narrow stacked layout without horizontal overflow, and winner-node preservation.

## Architecture

- `.agents/skills/run-diptych-picker/`: persistent coordinator workflow, protocol, and validated mailbox helper scripts.
- `src/domain/game.ts` and `challenger-state.ts`: round transitions, winner identity, FIFO/pool state, Elo, and fallback pacing.
- `src/server/agent-mailbox.ts`: validated durable job/result protocol and restart recovery.
- `src/server/game-service.ts`: transactional selection, buffer/refill coordination, result verification, winner-preserving reconciliation, and cleanup retry.
- `src/server/initial-game.ts`: seed-or-generated initial-pair orchestration.
- `src/server/repository.ts` and `initial-bootstrap.ts`: atomic local persistence behind interfaces.
- `src/server/asset-store.ts`: immutable PNG storage and verification.
- `src/components/game-screen.tsx`: async polling, preload-before-swap, keyboard controls, and exactly two candidate images once ready.
- `GET /api/game/health`: a narrow live snapshot of ready, in-flight, and reusable-pool counts for the UI status readout.
