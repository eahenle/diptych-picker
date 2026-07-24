# Diptych Picker

A local-first, iterative two-image preference game. Pick A or B; the exact winner stays on the same side while only the loser is replaced by one independently generated challenger.

## Run with Codex

Install dependencies once:

```bash
npm install
cp .env.example .env.local
```

Launch a dedicated interactive Codex session with eight agent threads and the required monitor-to-worker nesting:

```bash
npm run codex:play
```

Pass another thread count after `--`, or set `DIPTYCH_CODEX_THREADS`:

```bash
npm run codex:play -- 12
DIPTYCH_CODEX_THREADS=12 npm run codex:play
```

The script starts the `codex/personal` profile through `multi-cli`, applies per-launch `features.multi_agent_v2.max_concurrent_threads_per_session` and `agents.max_depth=2` overrides, and sends the initial `$run-diptych-picker` prompt. It reserves one thread for the root, one for the monitor, and up to three for fresh image workers, so the launcher requires at least five total threads. The v2 thread setting is a ceiling rather than a request to create idle agents; all three workers are active only while at least three independent mailbox jobs are pending. The script does not modify global Codex configuration. Open <http://localhost:3000> after the skill reports readiness.

Normal play runs the app as an optimized production server, not through Next's development server. To build and start only the agent-backed app without launching Codex, run:

```bash
npm run run:production
```

The root-level `run-only` launcher builds into the gitignored `.next-run` directory, preserves the tracked Next TypeScript configuration, forces `GENERATION_PROVIDER=agent`, and then starts the production server. `dev-and-play` instructs the runner skill to use this same launcher so both entrypoints share one startup path.

To inspect the exact command without launching Codex, run `./dev-and-play --print-command [thread-count]`.
Inspect the production app command with `./run-only --print-command`.

The web server never launches `codex`, calls an OpenAI API, or receives an API key. Model choice, authentication, permissions, and subagent execution belong to the interactive CLI session.

## Development checks

Install the repository's pre-commit hook once per clone:

```bash
npm run hooks:install
```

The hook runs formatting, lint, TypeScript validation, and unit/integration tests through `npm run check`. Pull requests and pushes to `main` run the same focused check in GitHub Actions.

## Challenger buffer and generation loop

An ordinary new game starts with two displayed candidates and a durable FIFO of five ready challengers. A selection consumes the FIFO head immediately, preloads that one image in the browser, and swaps only the losing card. Ready and in-flight candidates stay valid when the winner changes, so older work drains in FIFO order instead of being discarded.

Each selection restores the configured buffer deficit by writing `refill` requests under `.local-data/agent-mailbox/`. The root Codex session supervises one persistent mailbox-monitor subagent. That monitor claims only as many independent refills as it has fresh image-worker slots, delegates one standalone image per request, validates each result independently, and publishes immutable PNGs under `.local-data/assets/`. Keep the interactive Codex session and `$run-diptych-picker` monitor alive while playing if you want generated refills to arrive in the background.

The selected winner is never sent through an image-editing model. Its candidate ID, URL, bytes, metadata, side, object identity in the active browser state, and `<img>` node remain unchanged.

If Codex closes during a job, the current images, ready queue, pool, and mailbox remain on disk. Reopen the `codex/personal` profile through `multi-cli` in the repository and run the skill again; startup recovery resumes unfinished refill batches and ordinary jobs. Completion and failure helpers are idempotent, and opposite terminal outcomes cannot both win.

### Staged co-proc transport

The optional comma-separated `CO_PROC_GENERATION_CHANNELS` setting enables an
acknowledged persistent-channel pool behind the same durable mailbox interface.
The legacy singular `CO_PROC_GENERATION_CHANNEL` remains accepted. The app first
publishes the complete job to the mailbox, selects one locally idle channel,
waits for its version-1 `ready` frame, then sends a version-2 `gen` frame with
the job ID, kind, absolute durable job and lease paths, a one-use lease token,
and the lease duration. The peer must atomically move the pending job to active
with `npm run agent:claim-lease` before returning a version-2 acknowledgement
containing the matching token and expiry. The app verifies that owner-only
durable lease before accepting delivery.

Concurrent enqueues reserve different ready channels, so three configured
channels can accept three independent dispatches without overcommitting one
worker. A pre-dispatch `busy` frame or unavailable endpoint lets the pool try
another channel. Once a generation frame has been written, a missing
acknowledgement is never retried on a second live channel because that could
duplicate work. A persistent peer renews its lease with
`npm run agent:renew-lease` and supplies `--lease-token` when completing or
failing the job. After durable publication, it sends a version-2 `result` frame
with the same token, terminal status, and exact normalized `completed/` or
`failed/` result path. The app validates that correlation and eagerly ingests
the strict durable result. The mailbox monitor skips live leases and
automatically takes over expired leases during its ordinary polling loop,
without requiring an app or monitor restart.

Set `CO_PROC_RUNTIME_ROOT` only when `co-proc` uses a non-default runtime root.
`CO_PROC_GENERATION_READY_TIMEOUT_MS` and
`CO_PROC_GENERATION_ACK_TIMEOUT_MS` tune the bounded handshake and default to
100 and 500 milliseconds. `CO_PROC_GENERATION_LEASE_MS` defaults to 120000 and
accepts 10000 through 600000 milliseconds; peers must renew before expiry. The
adapter revalidates owner-only directory, metadata, process, FIFO, lease, and
terminal-result state. Exclusive outcome reservations and immutable terminal
files remain the restart boundary, while live claim, result signaling, and
publication are token-owned with expiry-based mailbox fallback.

## Curated and learned pools

Seven standalone curated PNGs and their strict manifest live under `public/seed-assets/`. A normal new game shuffles seven distinct eligible candidates: two are displayed and five fill the ready FIFO. Curated files are immutable at runtime.

Every comparison updates both candidates with Elo K=32. Generated candidates become eligible for the learned pool after comparison even when they have no wins, so a small pool preserves breadth instead of discarding useful alternatives prematurely. The effective curated-plus-learned pool is bounded by the current game's reusable-pool capacity (`CANDIDATE_POOL_SIZE`, 50 by default); once full, a stronger candidate displaces only a strictly lower-rated lowest member, while rating history and immutable assets remain durable. Existing sessions backfill eligible rated candidates into available pool capacity, and lowering the live capacity retains the strongest members.

If `GENERATE_INITIAL_CANDIDATES=true`, the browser instead shows an initializing screen with no candidate `<img>` elements. The app enqueues two jobs sharing one batch ID. The coordinator claims both sides and delegates exactly two image workers in parallel, then the app verifies both immutable assets before presenting round 1. Refreshing does not enqueue duplicates, and a failed pair offers a retry.

## Depleted-buffer fallback

When no ready challenger exists, the service keeps the exact winner visible and waits three seconds after the selection before drawing a random eligible local-pool candidate. It may repeat that per-selection fallback up to ten times while generation catches up; after the tenth consecutive pool draw, only the losing card shows its loading treatment until a refill arrives. Consuming a ready seed or generated challenger resets the fallback counter and delay.

## Local storage

`LOCAL_DATA_DIR` defaults to `.local-data`. It contains:

- `game-state.json`: current round, history, preference seed, and cleanup marker.
- `challenger-state.json`: session ownership, ready FIFO, refill receipts, Elo ratings, learned membership, turnaround EMA, and fallback counters.
- `initial-bootstrap.json`: restart-safe generated-initial batch state.
- `agent-mailbox/`: pending, active, outcome, terminal-result, heartbeat, and ID-tombstone files.
- `agent-work/`: per-job proposal, failure, and generated-image handoff files.
- `assets/`: immutable generated PNGs named `<sha256-of-bytes>.png` and served through stable `/api/assets/...` URLs. Legacy UUID-named assets remain readable.

Game, challenger, and bootstrap repositories use atomic writes and a fixed local lock order. Mailbox IDs remain tombstoned after archival to prevent replay. Asset verification fully decodes PNGs and checks canonical URL, byte count, dimensions, and square format before state changes.

`GET /api/game` and `POST /api/game/start` return a tagged state: `{ status: "ready", game }`, `{ status: "initializing", ... }`, or `{ status: "initialization-error", ... }`.

The git-ignored `output/artifacts/` directory is the discoverable export location. Every completed generated PNG is copied there under its SHA-256 filename. `GET /api/game/snapshot` writes the exact JSON response there under `<sha256-of-bytes>.json` and downloads the same file in the browser; the UI reports the server-side path after export.

The versioned JSON save contains the restorable round, history, preference profile, ready queue, Elo ratings, and pool membership. `PUT /api/game/snapshot` validates the complete document and every referenced immutable local image before replacing state. In-flight job IDs are deliberately excluded; restored games start a fresh session and request any missing refill capacity safely. Save files therefore reload on installations that still have their referenced local image library.

## Mock mode

Automated tests set `GENERATION_PROVIDER=mock`. This enables a deterministic in-process mailbox worker that creates local PNGs and makes no model, network, or API calls. Normal CLI-backed use leaves `GENERATION_PROVIDER=agent` (or unset).

The buffer and pool defaults can be changed in `.env.local` with `CHALLENGER_BUFFER_SIZE=5` and `CANDIDATE_POOL_SIZE=50`. Each game's Preferences modal can override its ready-queue target, reusable-pool capacity, champion streak limit, and consecutive fallback-draw limit within safe bounds. Those rules persist in save exports; **New game → Start fresh** restores the configured defaults. The turnaround and fallback variables shown in `.env.example` are mainly useful for deterministic pacing tests; their production defaults match the design above.

## Controls

- **Export** writes the exact current game to `output/artifacts/<sha256>.json`, downloads the same file, and reports the path without interrupting play.
- **Load** opens a restore dialog with the option to export the current game first, then choose a prior JSON save.

- Click the complete A or B card.
- Read each established candidate's rounded Elo score from its lower-left overlay. `✦` marks a first appearance; `⊖` warns that losing the current comparison would remove that candidate from the reusable pool.
- Select the **Round** metric to review up to fifty recent decisions, newest first, with winner and rejected-candidate thumbnails and no generation prompts. Select an available thumbnail to inspect the immutable image at full size. Favorite exceptional candidates from history or the pool; favorites persist independently of Elo and pool membership. The header's **Favorites** control opens every saved candidate in deterministic Elo order, including images that have left the reusable pool, with inspection, removal, and variation-exploration actions.
- In **Favorites**, select three to five generated images to draft a prompt card from their shared transferable qualities. Curated seeds and private uploads are ineligible. The writer preserves every source image and returns a review-only proposal; accepting it in Preferences creates an immutable card with all source candidate IDs recorded.
- Every expanded image offers **Explore variations**. The app privately runs that candidate through the same source-analysis path, opens the resulting profile as an editable draft, and saves no change until you confirm it. Generated descendants retain the canonical parent plus a fingerprint of the exact preference profile used.
- Press `A` or `1` for the left image.
- Press `B` or `2` for the right image.
- Press `C` or `3` to declare a neutral tie and replace both images.
- Press `D` or `4` for **Both lose**. Both candidates receive a loss without an Elo change, leave the reusable pool, and count as negative adaptive evidence when generated.
- Shape future challengers through **Preferences**, with separate guidance for themes, inspiration, media, visual style, palette, content range, and things to avoid. **Analyze image** accepts a private PNG, JPEG, or WebP source and fills those fields with transferable content, composition, medium, style, palette, and constraint guidance; the result remains an unsaved draft for review and never requests a depicted person's identity or exact likeness. The title-row freedom slider applies to the entire profile: **Frozen** prevents model edits, **Guided** permits restrained leaderboard-driven revisions every 15 completed rounds, and **Unfettered** permits broad revisions every 5 rounds. A cadence meter shows progress and explains when the next winning generated candidate is eligible to update the profile. Both adaptive levels remain winner-gated and base revisions primarily on bounded, display-safe leaderboard evidence—aggregate rank, Elo, repeated wins/losses, favorites, and a cached visual synthesis of the current top four pool images—while recent decisions remain secondary novelty context. Pool leaders reuse the same content-addressed normalization and strict profile-analysis machinery as uploaded sources; analysis reruns only when the ordered leading cohort changes, never modifies a source image, and never directly overwrites user-entered preferences. Separate bounded provenance lists record winning and rejected generated outcomes. Saving or adopting changed profile fields clears candidates buffered under the earlier brief, replaces their capacity with jobs carrying the new seed, and discards any earlier-brief result after its already-running worker exits; provenance-only updates leave buffered work stable. Image workers must treat the current composed preference seed as authoritative. The modal stays openable while a selection waits; Save queues the edited profile with animated feedback and applies it automatically when the challenger arrives. Its optional **Prompt deck** stores immutable archetype/style cards and draws future jobs by positive weight; card-backed winners gain 10% weight and all card-backed wins/rejections remain attributable. Four new rejects inside the latest twelve deck verdicts automatically request two editor alternatives, which remain review-only until accepted as immutable child cards or discarded. Two active cards can also be selected for a balanced model-assisted blend; the returned direction remains review-only and records both immutable parents when accepted.
- Expand **Game rules** in Preferences to tune the current game's ready queue (1–10), reusable pool (2–50), champion retirement streak (2–50), and consecutive fallback limit (1–50). Applying changes is independent from saving the preference profile: pool reductions trim the weakest members immediately, queue growth schedules available refill capacity, and the next comparison uses the new streak and fallback limits.
- Preferences keeps a bounded revision timeline for confirmed manual saves, variation branches, and model-authored rewrites. Expand it to review when each revision occurred and which fields changed, then restore any entry as an editable or Frozen draft without changing the game until Save is confirmed. Named presets capture the current draft for later reuse; applying one is also draft-only, and same-name saves replace the prior preset.
- The quiet **Queue** readout shows ready challengers and total in-flight refill work. Select it to distinguish jobs actively generating from jobs waiting for a worker and to see whether old-profile work is draining. Ready plus in-flight refill jobs stays within the configured queue target. Select **Pool** to open the reusable-image leaderboard, ranked by Elo with each candidate's thumbnail, concept, style, win–loss record, and curated/generated provenance; prompts and mailbox details remain private.
- Background moderation blocks are classified separately from operational failures. The app keeps replacing blocked refill work, while a persistent notice explains what happened and offers **Adjust preferences** or **Dismiss** instead of failing silently.
- **New game** opens a save/restore dialog. Export the exact current game, load a prior JSON save, or start fresh; starting fresh clears the round, history, and preference profile while retaining learned pool ratings and immutable images.

## Verification

```bash
npm run format:check
npm run lint
npm test
npm run build
npm run test:e2e
```

Playwright starts the app in deterministic mock mode with isolated `.local-data/test` state. Its suite covers game export/restore, source analysis, preference revisions and presets, editable persisted game rules, weighted prompt cards, two-card blending, favorite-set card writing, five instant FIFO swaps, stale work after a winner change, refresh persistence, double-click suppression, fallback pacing and its hard stop, deferred Preferences save, two independent images, narrow stacked layout without horizontal overflow, expanded-image controls, and winner-node preservation.

## Architecture

- `.agents/skills/run-diptych-picker/`: persistent coordinator workflow, protocol, and validated mailbox helper scripts.
- `src/domain/game.ts` and `challenger-state.ts`: round transitions, winner identity, FIFO/pool state, Elo, and fallback pacing.
- `src/server/agent-mailbox.ts`: validated durable job/result protocol and restart recovery.
- `src/server/preference-profile-schema.ts`: shared strict, request, and backward-compatible persisted preference validation.
- `src/server/co-proc-generation-transport.ts`: opt-in live NDJSON notification over secure attachable `co-proc` endpoints, with durable mailbox fallback.
- `src/server/game-service.ts`: transactional lock, persistence, mailbox, reconciliation, and cleanup orchestration.
- `src/server/prompt-card-reconciler.ts`: durable editor, blender, and favorite-set writer recovery, terminal reconciliation, and suggestion creation.
- `src/server/leaderboard-profile-reconciler.ts`: adaptive leaderboard analysis scheduling, durable result recovery, and current-cohort cache selection.
- `src/server/game-comparison.ts` and `game-refill.ts`: comparison rating/receipt rules and deterministic refill context, planning, and work validation.
- `src/server/game-snapshot.ts`: versioned save validation, asset verification, fresh-session restore, and stale-job exclusion.
- `src/server/initial-game.ts`: seed-or-generated initial-pair orchestration.
- `src/server/repository.ts` and `initial-bootstrap.ts`: atomic local persistence behind interfaces.
- `src/server/asset-store.ts`: immutable PNG storage and verification.
- `src/components/game-screen.tsx`: the rendered game shell, keyboard wiring, and exactly two candidate images once ready.
- `src/components/use-selection-controller.ts` and `use-game-session-polling.ts`: preload-before-swap selection recovery plus bootstrap, health, and background-job polling.
- `src/components/use-preference-editor.ts`, `use-game-transfer.ts`, and `use-candidate-browser.ts`: preference, save/load, and candidate-inspection workflow boundaries.
- `GET /api/game/health`: a narrow live snapshot of ready, active, waiting, draining, and reusable-pool counts for the UI status readout.
- `GET /api/game/rules` and `PATCH /api/game/rules`: read or atomically replace the current game's bounded queue, pool, retirement-streak, and fallback-draw rules.
- `GET /api/game/leaderboard`: the current reusable pool ranked by Elo with display-safe candidate metadata and no prompt or mailbox contents.
- `GET /api/game/history`: up to fifty newest-first decisions with display-safe winner and rejected-candidate metadata plus the full decision count.
- `GET /api/game/favorites`: every favorited candidate ranked by Elo with display-safe metadata, including whether it remains in the reusable pool.
- `PUT /api/game/favorites`: persist or remove a candidate favorite under the challenger-state lock without changing its rating or pool membership.
- `POST /api/game/preferences/deck/write`: request one approval-gated prompt-card proposal from three to five distinct generated favorites.
- `GET` and `PUT /api/game/snapshot`: download and restore validated local game saves.

The latest comprehensive maintainability audit and its deferred structural work
are recorded in [Codebase Review — 2026-07-21](docs/CODEBASE_REVIEW_2026-07-21.md).
Reproducible installs and isolated maintenance upgrades follow the
[dependency update policy](docs/DEPENDENCY_POLICY.md).
