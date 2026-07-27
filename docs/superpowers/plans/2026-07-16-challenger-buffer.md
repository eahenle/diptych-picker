# Challenger Buffer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make normal selections instant by consuming a durable five-candidate FIFO, replenishing it through Codex CLI image workers, ranking a bounded reusable local pool with Elo, and pacing local-pool fallback draws when generation falls behind.

**Architecture:** Add a validated challenger-state repository containing the ready queue, refill ownership, rating catalog, turnaround EMA, and fallback pacing. `GameService` will coordinate that state with the existing game repository under a fixed lock order, reconcile background `refill` mailbox jobs, and preserve the winner object while consuming buffered candidates. The repo-local coordinator skill will claim refill work in bounded batches and delegate every standalone image to a fresh native image-generation subagent.

**Tech Stack:** Next.js App Router, TypeScript, Zod, filesystem-backed JSON repositories, native Codex image generation, Vitest, Testing Library, Playwright.

## Global Constraints

- A and B remain separate immutable assets rendered by exactly two independent `<img>` elements.
- Never generate a diptych, split screen, A/B label, border, caption, watermark, or unintended readable text.
- Never edit, clone, re-encode, or regenerate the retained winner.
- Keep all model work in the interactive Codex CLI session; the web process must not invoke `codex`, an SDK, or an external API.
- Ready buffer target is `5`; effective local pool maximum is `50`; fallbacks wait `3000` ms and permit at most `10` consecutive draws.
- Automated tests use only the deterministic mock provider.
- All behavior changes follow red-green-refactor: run each named test and observe the expected failure before implementation.

---

### Task 1: Curated Candidate Manifest and Assets

**Files:**

- Create: `public/seed-assets/manifest.json`
- Create: `public/seed-assets/mushroom-maestro.png`
- Create: `public/seed-assets/night-shift-derby.png`
- Create: `public/seed-assets/pool-sized-circuit.png`
- Create: `public/seed-assets/midnight-laundry-tide.png`
- Create: `public/seed-assets/fogline-glassworks.png`
- Modify: `src/server/initial-state.ts`
- Test: `src/server/initial-state.test.ts`

**Interfaces:**

- Produces: `loadCuratedCandidates(now: string): Promise<Candidate[]>`
- Produces: a validated manifest with exactly seven distinct candidate IDs and standalone square PNG paths.

- [ ] **Step 1: Write the failing manifest-loader tests**

Add tests proving seven distinct candidates load, every URL begins with `/seed-assets/`, and missing/duplicate entries produce an actionable error:

```ts
it("loads seven distinct curated candidates", async () => {
  const candidates = await loadCuratedCandidates(NOW);
  expect(candidates).toHaveLength(7);
  expect(new Set(candidates.map(({ id }) => id)).size).toBe(7);
  expect(
    candidates.every(({ imageUrl }) => imageUrl.startsWith("/seed-assets/")),
  ).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- src/server/initial-state.test.ts`

Expected: FAIL because `loadCuratedCandidates` and the manifest do not exist.

- [ ] **Step 3: Curate five additional immutable assets**

Copy the four already verified live-test PNGs into the first four named files without re-encoding. Generate `fogline-glassworks.png` exactly once through a fresh native image-generation subagent using this production prompt:

```text
One standalone square image of an adult glassblower operating a rain-soaked hilltop furnace at dawn, confident and technically precise, with pale fog, blackened steel, molten amber glass, and restrained cinematic blue. Use an etched colored-pencil and watercolor medium with one coherent composition. No diptych, split screen, A/B label, border, caption, watermark, logo, or readable text.
```

Verify all seven files decode as square PNGs. Do not use an image-editing model on any existing asset.

- [ ] **Step 4: Implement and validate the manifest loader**

Define a strict manifest schema and return fresh candidates with the supplied timestamp:

```ts
export async function loadCuratedCandidates(now: string): Promise<Candidate[]> {
  const manifest = curatedManifestSchema.parse(
    JSON.parse(await readFile(MANIFEST_PATH, "utf8")),
  );
  await Promise.all(manifest.candidates.map(verifySeedPng));
  return manifest.candidates.map(({ file, ...candidate }) => ({
    ...candidate,
    imageUrl: `/seed-assets/${file}`,
    createdAt: now,
    winCount: 0,
  }));
}
```

- [ ] **Step 5: Run the focused tests and commit**

Run: `npm test -- src/server/initial-state.test.ts`

Expected: PASS.

Commit: `git commit -m "feat: add curated candidate pool"`

---

### Task 2: Buffer, Elo, and Fallback Domain Logic

**Files:**

- Create: `src/domain/challenger-state.ts`
- Create: `src/domain/challenger-state.test.ts`
- Modify: `src/domain/game.ts`
- Modify: `src/domain/game.test.ts`

**Interfaces:**

- Produces: `ChallengerState`, `BufferedCandidate`, `CandidateRating`, `RefillJobRecord`
- Produces: `updateElo`, `promoteWinner`, `popReady`, `drawFallback`, `recordGenerationTurnaround`, `refillDeficit`
- Consumes: existing `Candidate`, `GameState`, `Side`, and winner-preserving round transitions.

- [ ] **Step 1: Write failing tests for FIFO and Elo**

Cover FIFO order, deterministic 1000-vs-1000 updates to 1016/984, strict-higher displacement, ties, pool maximum 50, and ID deduplication:

```ts
it("updates equal Elo ratings after a decisive comparison", () => {
  expect(updateElo(1000, 1000, 32)).toEqual({ winner: 1016, loser: 984 });
});

it("pops exactly one candidate from the FIFO", () => {
  const result = popReady(stateWithReady([first, second]));
  expect(result.candidate).toBe(first.candidate);
  expect(result.state.ready).toEqual([second]);
});
```

- [ ] **Step 2: Run the new domain tests and verify RED**

Run: `npm test -- src/domain/challenger-state.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the strict data model and pure transitions**

Use discriminated sources and explicit fallback timing:

```ts
export interface ChallengerState {
  version: 1;
  sessionId: string;
  ready: BufferedCandidate[];
  refillJobs: RefillJobRecord[];
  ratings: CandidateRating[];
  generationTurnaroundEmaMs: number;
  consecutiveFallbackDraws: number;
  nextFallbackAt: string | null;
}
```

`drawFallback` must accept an injected `random: () => number` and return no candidate before the delay, after ten fallbacks have been served, or when no candidate survives current/recent exclusions.

- [ ] **Step 4: Add pending-buffer round transitions**

Replace the single-shape pending selection with an explicit union:

```ts
export type PendingSelection =
  | {
      kind: "generation";
      winnerSide: Side;
      selectedAt: string;
      generationJobId: string;
    }
  | { kind: "buffer"; winnerSide: Side; selectedAt: string };
```

Add `beginBufferedSelection` and reuse `completeSelection` so winner object identity remains exact.

- [ ] **Step 5: Run domain tests and commit**

Run: `npm test -- src/domain/challenger-state.test.ts src/domain/game.test.ts`

Expected: PASS.

Commit: `git commit -m "feat: model challenger buffer and Elo pool"`

---

### Task 3: Challenger State Repository and Configuration

**Files:**

- Create: `src/server/challenger-repository.ts`
- Create: `src/server/challenger-repository.test.ts`
- Create: `src/server/challenger-config.ts`
- Create: `src/server/challenger-config.test.ts`

**Interfaces:**

- Produces: `ChallengerRepository` with `load`, `save`, `clearSession`, and `withLock`
- Produces: `JsonChallengerRepository` and `MemoryChallengerRepository`
- Produces: validated `challengerConfig` defaults from the approved spec.

- [ ] **Step 1: Write failing repository and config tests**

Test atomic persistence, serialization of concurrent operations, corrupt JSON rejection, session clearing that preserves ratings, and numeric environment validation.

```ts
it("clears session data without erasing learned ratings", async () => {
  await repository.save(populatedState);
  await repository.clearSession("next-session");
  await expect(repository.load()).resolves.toMatchObject({
    sessionId: "next-session",
    ready: [],
    refillJobs: [],
    ratings: populatedState.ratings,
  });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- src/server/challenger-repository.test.ts src/server/challenger-config.test.ts`

Expected: FAIL because both modules are absent.

- [ ] **Step 3: Implement Zod validation and atomic storage**

Follow `JsonGameRepository`: a process-local lock plus a filesystem lock, temporary `wx` file, fsync-compatible close, and atomic rename. Parse all loaded and saved state with a strict schema.

- [ ] **Step 4: Implement centralized configuration**

Export these exact values after positive-number validation:

```ts
export const challengerConfig = {
  bufferTarget: numberFromEnv("CHALLENGER_BUFFER_SIZE", 5),
  poolMaximum: numberFromEnv("CANDIDATE_POOL_SIZE", 50),
  initialRating: 1000,
  eloKFactor: 32,
  turnaroundEmaAlpha: 0.25,
  initialTurnaroundMs: 300_000,
  fallbackDelayMs: 3_000,
  fallbackMaximumConsecutive: 10,
} as const;
```

- [ ] **Step 5: Run focused tests and commit**

Run: `npm test -- src/server/challenger-repository.test.ts src/server/challenger-config.test.ts`

Expected: PASS.

Commit: `git commit -m "feat: persist challenger queue and pool"`

---

### Task 4: Curated Startup and New-Game Session Reset

**Files:**

- Modify: `src/server/initial-game.ts`
- Modify: `src/server/initial-game.test.ts`
- Modify: `src/server/runtime.ts`
- Modify: `src/server/runtime-provider.test.ts`

**Interfaces:**

- Consumes: `loadCuratedCandidates`, `ChallengerRepository`, `challengerConfig`
- Produces: a ready game with two candidates and a durable five-candidate FIFO.

- [ ] **Step 1: Write failing startup/reset tests**

Prove a new game chooses seven distinct candidates, keeps learned ratings, replaces the previous session ID, and restores the same FIFO after refresh.

```ts
expect(start.game.round.leftCandidate.id).not.toBe(
  start.game.round.rightCandidate.id,
);
expect((await challengerRepository.load())?.ready).toHaveLength(5);
expect(new Set(allSevenIds).size).toBe(7);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- src/server/initial-game.test.ts src/server/runtime-provider.test.ts`

Expected: FAIL because startup does not initialize challenger state.

- [ ] **Step 3: Implement curated startup and reset**

Inject `challengerRepository` and `curatedCandidates` into `InitialGameService`. Under the fixed lock order `gameRepository` then `challengerRepository`, choose seven candidates with injected randomness, save A/B, save five `source: "seed"` entries, and initialize all missing ratings at 1000.

Reset archives outstanding refill jobs before changing the session ID. Late results retain their old session ID and cannot enter the new queue.

- [ ] **Step 4: Run focused tests and commit**

Run: `npm test -- src/server/initial-game.test.ts src/server/runtime-provider.test.ts`

Expected: PASS.

Commit: `git commit -m "feat: prefill new games from curated pool"`

---

### Task 5: Refill Mailbox Protocol and Mock Worker

**Files:**

- Modify: `src/server/agent-mailbox.ts`
- Modify: `src/server/agent-mailbox.test.ts`
- Modify: `src/server/mock-agent.ts`
- Modify: `src/server/mock-agent.test.ts`

**Interfaces:**

- Produces: generation job discriminator `kind: "refill"`
- Reuses: completed/failed generation result and deterministic `challenger-${jobId}` asset identity.

- [ ] **Step 1: Write failing refill-schema tests**

```ts
const parsed = generationJobSchema.parse({
  ...baseJob,
  kind: "refill",
  sessionId: "session-1",
  pinnedWinnerId: baseJob.retainedWinner.id,
});
expect(parsed.kind).toBe("refill");
```

Also prove unknown session metadata is rejected and the mock worker schedules refill jobs without real calls.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- src/server/agent-mailbox.test.ts src/server/mock-agent.test.ts`

Expected: FAIL because `refill` is not a valid job kind.

- [ ] **Step 3: Extend the strict protocol**

Add:

```ts
const refillGenerationJobSchema = z
  .object({
    ...generationJobFields,
    kind: z.literal("refill"),
    sessionId: jobIdSchema,
    pinnedWinnerId: nonBlankStringSchema,
  })
  .strict();
```

Require `pinnedWinnerId === retainedWinner.id` through schema refinement. Keep existing initial and legacy challenger records readable.

- [ ] **Step 4: Teach the mock worker to complete refill work**

Use the same deterministic prompt/image providers and asset publishing path. Restrict `[mock:fail-once]` to both `challenger` and `refill` jobs so browser failure coverage remains deterministic.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm test -- src/server/agent-mailbox.test.ts src/server/mock-agent.test.ts`

Expected: PASS.

Commit: `git commit -m "feat: add durable refill generation jobs"`

---

### Task 6: Buffer-Aware Game Service

**Files:**

- Modify: `src/server/game-service.ts`
- Modify: `src/server/game-service.test.ts`
- Modify: `src/server/runtime.ts`
- Modify: `src/app/api/game/select/route.ts`
- Modify: `src/app/api/game/route.test.ts`

**Interfaces:**

- Consumes: `ChallengerRepository`, pure challenger-state transitions, refill mailbox jobs.
- Produces: immediate buffered selection, background `ensureRefillCapacity`, paced fallback, and pending-buffer reconciliation.

- [ ] **Step 1: Write failing immediate-selection tests**

For both sides, assert exact winner identity/URL/metadata, one FIFO pop, immediate idle round increment, no selection-bound generation job, and one refill job for the new deficit.

```ts
const selected = await service.select("left", 3);
expect(selected.round.leftCandidate).toBe(originalLeft);
expect(selected.round.rightCandidate.id).toBe(bufferHead.candidate.id);
expect(selected.round.status).toBe("idle");
expect(mailbox.enqueue).toHaveBeenCalledWith(
  expect.objectContaining({ kind: "refill" }),
);
```

- [ ] **Step 2: Write failing stale rollover and concurrency tests**

Prove a challenger win does not remove stale ready/in-flight entries, new jobs pin to the new winner, and two concurrent selections consume only one head.

- [ ] **Step 3: Write failing fallback/EMA tests**

Cover the delayed first random draw, recent/current exclusions, three-second cadence, allowed tenth draw, blocked eleventh draw, generated-result reset, and failed-result exclusion from EMA.

- [ ] **Step 4: Run the focused tests and verify RED**

Run: `npm test -- src/server/game-service.test.ts`

Expected: FAIL because selection still always creates `kind: "challenger"` work.

- [ ] **Step 5: Implement buffered selection under fixed lock order**

Construct `GameService` with the challenger repository, config, injected clock, ID factory, and random source. Within `gameRepository.withLock(() => challengerRepository.withLock(...))`:

1. load both states;
2. apply ratings/promotion;
3. pop ready or fallback;
4. preserve the winner through `completeSelection`;
5. save challenger state, then game state;
6. call idempotent refill enqueue after durable intent is present.

Keep persisted refill job records as the recovery source if enqueue acknowledgement is lost.

- [ ] **Step 6: Implement refill reconciliation**

For each durable refill record, verify work metadata and terminal result. On success verify the PNG, append a generated candidate unless its session is stale or ID collides, update EMA, remove the refill record, and archive the mailbox job. If a selection is waiting, consume the newly appended head immediately. On failure remove/archive only the refill record and restore capacity.

- [ ] **Step 7: Implement capacity enforcement**

Calculate:

```ts
const deficit = Math.max(
  0,
  bufferTarget - state.ready.length - state.refillJobs.length,
);
```

Create exactly `deficit` durable records using the latest winner/rejected/history/preferences snapshot. Do not cancel old-winner work; every new record pins to the current winner.

- [ ] **Step 8: Run focused and regression tests, then commit**

Run: `npm test -- src/server/game-service.test.ts src/app/api/game/route.test.ts src/domain/game.test.ts`

Expected: PASS.

Commit: `git commit -m "feat: consume and refill challenger buffer"`

---

### Task 7: Persistent Codex Coordinator Refill Batching

**Files:**

- Modify: `.agents/skills/run-diptych-picker/SKILL.md`
- Modify: `.agents/skills/run-diptych-picker/references/job-protocol.md`
- Modify: `.agents/skills/run-diptych-picker/scripts/next-job.mjs`
- Modify: `.agents/skills/run-diptych-picker/scripts/protocol-utils.mjs`
- Test: `.agents/skills/run-diptych-picker/scripts/next-job.test.mjs`

**Interfaces:**

- Produces: `agent:next --max-refills 3` output containing either one selection/initial job or a bounded array of independent refill jobs.
- Preserves: durable claim ownership and one fresh image-generation subagent per job.

- [ ] **Step 1: Write failing script tests**

Create isolated mailboxes proving up to three refill jobs are claimed oldest-first, no more than the requested limit are claimed, initial batch ownership remains exclusive, and ordinary challenger work retains priority.

- [ ] **Step 2: Run the script tests and verify RED**

Run: `node --test .agents/skills/run-diptych-picker/scripts/next-job.test.mjs`

Expected: FAIL because `--max-refills` is unsupported.

- [ ] **Step 3: Implement bounded refill claims**

Keep atomic pending-to-active rename semantics. Emit strict JSON:

```json
{ "kind": "refill-batch", "jobs": [{ "kind": "refill" }] }
```

Never include initial or challenger work in a refill batch, and never claim more jobs than workers the coordinator can immediately delegate.

- [ ] **Step 4: Update the persistent skill workflow**

Require the coordinator to:

1. claim available work continuously;
2. spawn one fresh native image-generation subagent per refill job;
3. never use `codex exec`, an SDK, or a web-process provider;
4. complete/fail each job independently;
5. return to waiting without exiting;
6. keep standalone-image constraints in every worker prompt.

- [ ] **Step 5: Validate the skill and commit**

Run:

```bash
node --test .agents/skills/run-diptych-picker/scripts/next-job.test.mjs
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" .agents/skills/run-diptych-picker
```

Expected: all tests pass and validator prints `Skill is valid!`.

Commit: `git commit -m "feat: coordinate parallel buffer refills"`

---

### Task 8: Client Interaction and Preferences Feedback

**Files:**

- Modify: `src/domain/game.ts`
- Modify: `src/components/game-screen.tsx`
- Modify: `src/components/game-screen.module.css`
- Modify: `src/components/game-screen.test.tsx`

**Interfaces:**

- Consumes: existing `GameState` responses whose round may already be complete or may still be waiting for a fresh candidate.
- Produces: instant preload/swap for already-completed rounds and an openable Preferences modal during waits.

- [ ] **Step 1: Write failing component tests**

Prove a buffered 200/202 response preloads only the losing asset, winner `<img>` node identity remains unchanged, Preferences opens during generation, and Save is disabled with explanatory text only for a selection-bound wait.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- src/components/game-screen.test.tsx`

Expected: FAIL because buffer status and generation-time Preferences behavior are absent.

- [ ] **Step 3: Implement response handling without a client waterfall**

If POST `/api/game/select` returns an already completed next round, preload the changed loser URL immediately and commit it without starting the polling loop. If it returns `generating`, retain the existing correlated polling/reconnect flow. Keep the global keyboard listener stable and avoid recreating candidate components.

- [ ] **Step 4: Implement accessible buffer and preference states**

Remove `status === "generating"` from the Preferences button's `disabled` expression. Inside the modal, disable Save only during a selection-bound wait and render `Changes can be saved after this challenger arrives.` Keep existing connection and loading announcements in the current `aria-live` region.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm test -- src/components/game-screen.test.tsx`

Expected: PASS.

Commit: `git commit -m "feat: surface instant buffered rounds"`

---

### Task 9: Browser Flow, Documentation, and Full Verification

**Files:**

- Modify: `tests/diptych-picker.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**

- Validates the complete feature through the deterministic mock mailbox and real browser.

- [ ] **Step 1: Write failing Playwright scenarios**

Add scenarios for five instant buffered swaps, stale queue after a challenger win, refresh persistence, double-click protection, depletion fallback pacing with a test-only short delay, loser-only loading after ten fallbacks, exactly two independent images, mobile vertical stacking, and Preferences feedback during a wait.

- [ ] **Step 2: Run the new browser scenarios and verify RED**

Run: `npm run test:e2e`

Expected: new buffer scenarios fail before final integration fixes.

- [ ] **Step 3: Update environment and README**

Document:

```dotenv
CHALLENGER_BUFFER_SIZE=5
CANDIDATE_POOL_SIZE=50
```

Explain curated versus learned pools, Elo displacement, stale FIFO behavior, turnaround-based fallback pacing, refill batching, local storage files, mock mode, and the requirement to keep the interactive Codex coordinator alive.

- [ ] **Step 4: Run formatting and static verification**

Run:

```bash
npm run format
npm run format:check
npm run lint
npx tsc --noEmit
```

Expected: all commands exit 0.

- [ ] **Step 5: Run all automated verification**

Run:

```bash
npm test
npm run build
npm run test:e2e
```

Expected: all unit tests, production build, and Playwright tests pass with no real model calls.

- [ ] **Step 6: Perform live visual verification**

Start the app through `$run-diptych-picker`, verify the provider header is `agent`, and inspect desktop plus narrow mobile widths. Confirm:

- exactly two independent side-by-side images;
- five ready candidates at game start;
- selection swaps only the loser after preload;
- the winner's ID, URL, metadata, bytes, side, and DOM node remain unchanged;
- stale candidates continue after a challenger wins;
- native refill workers repopulate in the background;
- Preferences explains selection-bound save deferral;
- after depletion, fallback pacing permits ten consecutive local-pool draws but never an eleventh.

- [ ] **Step 7: Commit and update the existing PR**

Commit: `git commit -m "test: verify buffered preference game"`

Push `agent/build-diptych-picker`, update PR #1 with the new verification results, and keep it draft unless the user asks otherwise.
