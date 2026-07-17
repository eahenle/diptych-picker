# Challenger Buffer and Ranked Local Pool Design

## Purpose

Diptych Picker must make ordinary selections feel immediate even though native image generation can take several minutes. The app will keep five standalone challenger assets ready, consume them without changing the winner, and replenish the queue through the persistent Codex CLI coordinator. When the ready queue is exhausted, the app may serve a paced random candidate from a bounded local pool before falling back to the existing loser-only loading state.

This design preserves the critical invariant: the selected winner remains the same `Candidate` object and the same independent image asset on the same side. Buffering never edits, clones, re-encodes, or regenerates the winner.

## Terms and Defaults

- **Curated pool:** checked-in standalone square seed images and metadata. It is immutable at runtime and contains at least seven candidates so a new install can display two and buffer five.
- **Learned pool:** locally persisted membership and ratings for candidates that earned inclusion through user choices. It references immutable assets and survives new games and browser refreshes.
- **Local pool:** the effective bounded set formed from curated and learned membership.
- **Ready buffer:** a durable FIFO queue of up to five candidates available for immediate loser replacement.
- **Pinned winner:** the winner snapshot used when a refill job was created. Pinning guides generation but does not restrict later eligibility.
- **Stale candidate:** a ready or in-flight challenger pinned to a previous winner. Stale candidates remain usable and are not discarded when the winner changes.
- **Fallback draw:** a random eligible candidate drawn from the local pool after the ready buffer is empty.

Defaults are configurable in one server-side configuration module:

- ready buffer target: `5`
- local pool maximum: `50`
- initial Elo rating: `1000`
- Elo K-factor: `32`
- generation-turnaround EMA alpha: `0.25`
- initial generation-turnaround estimate: `300000` ms
- fallback draw delay: `3000` ms
- maximum consecutive fallback draws: `10`

## Persistent Data Model

Buffer and pool state live behind a repository interface and are stored atomically under `LOCAL_DATA_DIR`, separate from `game-state.json`:

```ts
interface CandidateRating {
  candidate: Candidate;
  rating: number;
  wins: number;
  losses: number;
  source: "curated" | "generated";
  poolMember: boolean;
  lastServedAt: string | null;
}

interface BufferedCandidate {
  candidate: Candidate;
  source: "seed" | "generated";
  pinnedWinnerId: string | null;
  enqueuedAt: string;
}

interface RefillJobRecord {
  jobId: string;
  pinnedWinnerId: string;
  enqueuedAt: string;
}

interface ChallengerBufferState {
  version: 1;
  ready: BufferedCandidate[];
  refillJobs: RefillJobRecord[];
  ratings: CandidateRating[];
  generationTurnaroundEmaMs: number;
  consecutiveFallbackDraws: number;
  nextFallbackAt: string | null;
}
```

Candidate IDs are unique across the current round, ready buffer, refill results, and pool catalog. Generated PNGs retain stable `/api/assets/...` URLs. The repository validates the complete document, uses the existing lock discipline, and writes through atomic rename.

The checked-in curated manifest is validated at startup. Runtime rating and membership changes are stored only in the local repository; the checked-in manifest is never rewritten.

## New Game and Startup

Starting a new game clears the current round, history, ready buffer, in-flight refill bookkeeping, fallback streak, and fallback cooldown. It does not erase learned ratings or learned pool membership.

The service chooses seven distinct eligible local-pool candidates. Two become the initial independent A and B candidates and five fill the ready FIFO. A fresh install draws from the curated pool. A returning install draws from the effective curated-plus-learned pool while excluding missing or invalid assets.

The initial screen is therefore ready without model work. Generated-initial mode remains available for explicit testing and recovery, but normal local-first startup uses the curated pool.

## Selection and Refill Flow

Selection remains transactional under the game and buffer repository locks:

1. Validate the expected round and idle status.
2. Preserve the exact winner object and record the winner/loser result.
3. Update Elo ratings for both candidates.
4. Evaluate generated-winner pool promotion and bounded displacement.
5. If the ready buffer contains a candidate, pop its head and complete the round immediately.
6. If the ready buffer is empty, evaluate the paced local-pool fallback.
7. If neither is available, enter the existing `generating` state with only the losing side marked for replacement.
8. Reconcile the waiting selection when the next refill result arrives.
9. Ensure the count of ready candidates plus active refill jobs reaches the target of five.

Every newly created refill job snapshots the latest winner, rejected candidate, selection history, recent concepts, and preference seed. If the winner later changes, ready candidates and already-running jobs remain valid stale work. New refill jobs pin to the new winner. Completed jobs append to the FIFO in completion order, so the user plays out stale candidates while winner-pinned candidates arrive in the background.

The web server only writes and reconciles durable mailbox jobs. The interactive Codex coordinator claims refill jobs and delegates each image to a fresh native image-generation subagent. It may run independent refill workers concurrently up to the available subagent limit, but never launches more work than the durable buffer deficit. No API key or model call enters the web process.

Each refill still produces exactly one standalone square image with no diptych, split screen, A/B label, border, caption, watermark, or unintended readable text.

## Ranked Pool Membership

All compared candidates receive an Elo update after each selection:

```text
expectedWinner = 1 / (1 + 10 ^ ((loserRating - winnerRating) / 400))
winnerRating' = winnerRating + 32 * (1 - expectedWinner)
loserRating' = loserRating + 32 * (0 - (1 - expectedWinner))
```

Ratings are persisted as rounded numbers with enough precision to make deterministic comparisons. A generated candidate becomes eligible for learned-pool membership after comparison, even with no victories. If the pool has room, it is added. If the pool is full, it replaces the lowest-rated member only when its new rating is strictly higher. Ties do not displace an existing member. Candidate IDs prevent duplicate membership.

Displacement removes membership, not the immutable asset or rating record. Checked-in curated files remain available on disk even when their effective membership is displaced. The maximum effective pool size is 50.

## Depleted-Buffer Fallback

The first time a selection finds the ready buffer empty, the service arms a three-second delay. Once the delay expires, it draws one random eligible local-pool candidate. Eligibility excludes both currently displayed candidates and candidates in the recent-history exclusion window. The draw is uniform across eligible members.

If the queue remains empty, each later selection starts its own three-second delay before another fallback may be drawn. Up to ten consecutive fallbacks may be served while generation catches up. After the tenth, the service must keep the loser-only loading state until a generated or seed-buffer candidate is consumed. Consuming any non-fallback buffered candidate resets the fallback count and delay.

Completed refill jobs continue to update the exponential moving average from job creation to validated completion for supply-health tracking. Failed jobs do not update it.

During the cooldown or forced wait, the winner remains visible and untouched. The losing card shows the existing loading treatment plus an approximate availability message; it does not display an old candidate as though selection were still possible.

## Preferences Behavior

The Preferences control may open while a challenger or refill is generating. The modal remains usable for viewing and editing, but Save is disabled for a selection-bound wait and explains that changes apply after the current challenger finishes. Once saved, the new preference seed applies to future refill jobs. Existing ready and in-flight candidates are not discarded, matching the stale-buffer rule.

Background refill work alone does not lock game interaction or preference editing.

## Failure and Recovery

- A refill failure removes only that refill record, records no candidate, and schedules replacement work for the remaining deficit.
- Repeated refill failures do not modify the current round or ready candidates.
- A waiting selection keeps both existing candidates intact until a valid replacement is available; retry continues to use durable mailbox semantics.
- Restart recovery reconciles active/completed refill jobs before enqueueing new work and never duplicates a job ID.
- New-game cancellation archives outstanding refill jobs. Late results from the old generation are ignored through generation/session ownership metadata.
- Invalid curated metadata or missing assets are skipped; startup fails with a clear actionable error only when fewer than seven valid pool candidates remain.
- Asset cleanup must retain anything referenced by the current round, ready buffer, rating catalog, or active mailbox state. Destructive asset garbage collection is outside this feature.

## UI Behavior

The two-card layout and exactly two independent `<img>` elements do not change. A compact status near the round metadata may show the number ready, such as `5 ready`. Buffer consumption still preloads the replacement image before the client swaps only the losing card.

When a ready challenger exists, selection should feel immediate apart from local image preload. The card lock prevents duplicate selections during the transaction. When the buffer is empty and no fallback is eligible, the existing loser-only loading overlay remains the fallback experience.

## Testing and Acceptance

Deterministic unit and browser tests use the mock provider only and prove:

1. New game displays two distinct curated candidates and durably pre-fills five more.
2. Selecting either side preserves the winner's exact object, ID, URL, metadata, side, and DOM image node while popping one buffered challenger.
3. A fast selection completes without a selection-bound generation job when a ready candidate exists.
4. Refill jobs carry the pinned winner and latest history/preferences and never exceed the target deficit.
5. A winner change preserves stale ready and in-flight candidates while new jobs pin to the new winner.
6. Refresh restores the current round, FIFO order, refill ownership, ratings, EMA, and fallback counters.
7. Concurrent/double selection consumes at most one buffered candidate.
8. Refill failure leaves the current round and ready queue intact and creates replacement capacity.
9. Elo updates both compared candidates deterministically.
10. A compared generated candidate enters a non-full pool even with no victories, or displaces only a strictly lower-rated member in a full pool.
11. Pool size never exceeds 50 and candidate IDs cannot appear twice.
12. The first eligible empty-buffer fallback waits three seconds and is random only among eligible local-pool candidates.
13. Fallbacks stay on the three-second cadence, permit the tenth consecutive draw, and prohibit an eleventh.
14. A fresh generated candidate resets fallback pacing.
15. Empty-buffer waiting keeps the winner visible and shows loading only on the loser.
16. Preferences opens during generation and communicates why Save may be deferred.
17. Automated tests make no real model or image-generation calls.
18. Desktop and narrow viewports continue to render exactly two side-by-side independent image elements.

Formatting, linting, unit tests, the production build, Playwright, and manual desktop/mobile inspection must pass before the existing PR is updated.

## Out of Scope

- Cloud synchronization or multi-user pool sharing.
- Editing or re-encoding any retained winner.
- Generating combined two-panel images.
- A manual pool-management UI.
- Destructive garbage collection of evicted generated assets.
