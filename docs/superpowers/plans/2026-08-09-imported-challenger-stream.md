# Imported Challenger Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a player explicitly edit any number of still images into normalized square candidates, annotate them automatically or manually, and start a clean game whose imported challenger stream precedes generated refills.

**Architecture:** A durable import-session repository stages canonical content-addressed assets and annotation state separately from the current game. New mailbox job kinds annotate imported images and generate an exact initial shortfall, while the challenger repository gains a prioritized imported queue that uses the existing comparison, Elo, and pool-admission paths. A browser editor performs one human-approved crop or fit per input and activates the staged game only after editing is sealed and five candidates are ready.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6, Zod 4, Sharp 0.35, Vitest 4, Testing Library, Node test runner, Playwright 1.61, file-backed JSON repositories and mailbox helpers.

## Global Constraints

- Accept still PNG, JPEG, and WebP source files; reject animated, multipage, empty, unsupported, and undecodable inputs.
- Every source requires individual human approval; no bulk approval action may exist.
- Normalize every approved edit to one deterministic 1024 by 1024 sRGB PNG and deduplicate canonical bytes by SHA-256 within the active import.
- Support square crop with pan, zoom, and rotation plus full-image fit over a chosen solid background.
- Upload only the normalized PNG; never upload the original source file or its metadata.
- Automated annotation must not generate or edit an image, identify a person, infer sensitive traits, expose private readable text, or request identity, likeness, or exact reproduction.
- Annotation failures remain explicit and support Retry, Manual annotation, and Remove.
- Activate only after the browser editing queue is empty and five candidates are ready; generate exactly the shortfall when fewer than five valid imports remain.
- Imported candidates must be served before ordinary generated refills and must enter Elo and pool membership only through ordinary comparison behavior.
- Preserve two independent image assets and never edit, regenerate, re-encode, replace, or move the retained winner.
- Preserve existing untracked seed images and unrelated working-tree changes.
- Each PR below must pass targeted tests and `npm run check`; the final PR must also pass production build and Playwright verification.

## Delivery Sequence

- PR 1: Tasks 1-3, durable import state, canonical asset ingestion, and annotation mailbox protocol.
- PR 2: Tasks 4-6, activation, imported challenger scheduling, initial-fill generation, snapshot recovery, and server API orchestration.
- PR 3: Tasks 7-9, file inspection, image editor, import workflow UI, and background failure recovery.
- PR 4: Task 10, end-to-end scenarios, public documentation, runner documentation, and final visual QA.

---

### Task 1: Durable Import Domain and Repository

**Files:**

- Create: `src/domain/import-session.ts`
- Create: `src/server/import-session-repository.ts`
- Create: `src/server/import-session-repository.test.ts`
- Modify: `src/domain/challenger-state.ts`
- Modify: `src/server/challenger-repository.ts`
- Modify: `src/server/challenger-repository.test.ts`

**Interfaces:**

- Produces: `ImportSession`, `ImportItem`, `ImportedAssetMetadata`, `ImportedCandidateAnnotation`, `ImportSessionRepository`, `JsonImportSessionRepository`, and `parseImportSession(value: unknown): ImportSession`.
- Produces: `ChallengerState.importQueue: BufferedCandidate[]` and provenance unions containing `"imported"`.
- Consumes: existing atomic JSON, lock, and Zod patterns from `src/server/repository.ts` and `src/server/challenger-repository.ts`.

- [ ] **Step 1: Write failing repository and schema tests**

Add tests that parse and round-trip a session with one annotating item and one ready item, reject duplicate item IDs and digests, reject an annotation without style tags, and prove atomic `load`, `save`, `clear`, and `withLock` behavior.

```ts
const session: ImportSession = {
  version: 1,
  id: "import-session-1",
  status: "editing",
  createdAt: "2026-08-09T20:00:00.000Z",
  sealedAt: null,
  activatedAt: null,
  items: [importItem("item-1", "a".repeat(64), "annotating")],
  initialFillJobs: [],
};

await repository.save(session);
expect(await repository.load()).toEqual(session);
expect(() =>
  parseImportSession({
    ...session,
    items: [session.items[0], { ...session.items[0], id: "item-2" }],
  }),
).toThrow(/digest/i);
```

- [ ] **Step 2: Run the focused tests and verify the missing-module failure**

Run: `npx vitest run src/server/import-session-repository.test.ts src/server/challenger-repository.test.ts`

Expected: FAIL because `@/domain/import-session` and `JsonImportSessionRepository` do not exist and challenger schemas reject imported state.

- [ ] **Step 3: Implement strict import types and persistence**

Define the exact state machine and annotation contract.

```ts
export type ImportItemStatus =
  "annotating" | "ready" | "failed" | "removed" | "served";

export interface ImportedCandidateAnnotation {
  concept: string;
  prompt: string;
  style: string[];
  reasoningSummary: string;
  source: "automated" | "manual";
}

export interface ImportSessionRepository {
  load(): Promise<ImportSession | null>;
  save(session: ImportSession): Promise<void>;
  clear(): Promise<void>;
  withLock<T>(operation: () => Promise<T>): Promise<T>;
}
```

Use `.strict()` Zod objects, the existing candidate constraints, unique item IDs, unique nonremoved digests, normalized filenames matching `/^[a-f0-9]{64}\.png$/`, and atomic temp-file rename. Add `importQueue` with a default of `[]` when older challenger state is parsed. Expand `CandidateRating.source` and `BufferedCandidate.source` to include `"imported"`.

- [ ] **Step 4: Run the focused tests and type checker**

Run: `npx vitest run src/server/import-session-repository.test.ts src/server/challenger-repository.test.ts && npm run typecheck`

Expected: PASS with legacy challenger documents parsed as `importQueue: []`.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/domain/import-session.ts src/domain/challenger-state.ts src/server/import-session-repository.ts src/server/import-session-repository.test.ts src/server/challenger-repository.ts src/server/challenger-repository.test.ts
git commit -m "Add durable image import sessions"
```

### Task 2: Canonical Imported Asset Ingestion

**Files:**

- Create: `src/server/import-asset-service.ts`
- Create: `src/server/import-asset-service.test.ts`
- Modify: `src/server/asset-store.ts`
- Modify: `src/server/asset-store.test.ts`

**Interfaces:**

- Consumes: `ImportedAssetMetadata` from Task 1 and immutable publishing helpers from `src/server/artifact-store.ts`.
- Produces: `normalizeImportedCandidate(contents: Uint8Array, assetDirectory: string, exportDirectory?: string): Promise<ImportedAssetMetadata>`.
- Produces: `LocalAssetStore.verifyImportedAsset(asset: ImportedAssetMetadata): Promise<void>`.

- [ ] **Step 1: Write failing canonicalization tests**

Generate a valid 1024-square PNG containing metadata, a nonsquare PNG, an animated PNG fixture, corrupt bytes, and a request larger than the canonical limit. Assert deterministic sRGB re-encoding, metadata removal, digest filename, immutable export publication, and rejection before repository mutation.

```ts
const first = await normalizeImportedCandidate(input, assets, exports);
const second = await normalizeImportedCandidate(input, assets, exports);

expect(first.filename).toMatch(/^[a-f0-9]{64}\.png$/);
expect(first).toEqual(second);
expect(await readFile(join(assets, first.filename))).toEqual(
  await readFile(join(exports, first.filename)),
);
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run src/server/import-asset-service.test.ts src/server/asset-store.test.ts`

Expected: FAIL because the import normalization API is missing.

- [ ] **Step 3: Implement deterministic server normalization**

Accept no more than 20 MiB of normalized upload bytes. Inspect Sharp metadata
first and reject any input whose format is not PNG, whose `pages` exceeds one,
or whose dimensions are not exactly 1024 by 1024. Fully decode with
`failOn: "error"`, `animated: false`, and
`limitInputPixels: 1024 * 1024`. Apply `rotate()`,
`toColorspace("srgb")`, and deterministic PNG encoding, then hash and publish
the exact output through `publishImmutableFile` and
`publishExportArtifact`.

```ts
const output = await sharp(contents, {
  animated: false,
  failOn: "error",
  limitInputPixels: 1024 * 1024,
})
  .rotate()
  .toColorspace("srgb")
  .png({ compressionLevel: 9, adaptiveFiltering: false })
  .toBuffer({ resolveWithObject: true });
```

Return `contentType: "image/png"`, exact width, height, byte length, digest, filename, and `/api/assets/<filename>` URL. Extend `LocalAssetStore` to verify the same digest, URL, type, square dimensions, and fully decoded bytes.

- [ ] **Step 4: Run focused tests and type checking**

Run: `npx vitest run src/server/import-asset-service.test.ts src/server/asset-store.test.ts && npm run typecheck`

Expected: PASS, including byte-identical duplicate publication.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/server/import-asset-service.ts src/server/import-asset-service.test.ts src/server/asset-store.ts src/server/asset-store.test.ts
git commit -m "Normalize imported candidate assets"
```

### Task 3: Import Annotation Mailbox Protocol

**Files:**

- Modify: `src/server/agent-mailbox.ts`
- Modify: `src/server/agent-mailbox.test.ts`
- Modify: `src/server/mock-agent.ts`
- Modify: `src/server/mock-agent.test.ts`
- Modify: `.agents/skills/run-diptych-picker/scripts/protocol-utils.mjs`
- Modify: `.agents/skills/run-diptych-picker/scripts/next-job.mjs`
- Modify: `.agents/skills/run-diptych-picker/scripts/next-job.test.mjs`
- Create: `.agents/skills/run-diptych-picker/scripts/complete-import-annotation.mjs`
- Create: `.agents/skills/run-diptych-picker/scripts/complete-import-annotation.test.mjs`
- Modify: `.agents/skills/run-diptych-picker/SKILL.md`
- Modify: `.agents/skills/run-diptych-picker/references/job-protocol.md`
- Modify: `package.json`

**Interfaces:**

- Consumes: `ImportedAssetMetadata` and `ImportedCandidateAnnotation` from Task 1.
- Produces: `ImportAnnotationRequest`, `ImportAnnotationResult`, mailbox enqueue/read/archive methods, `kind: "import-annotation-batch"` next-job output, and `npm run agent:complete-import-annotation`.
- Produces: mock-mode deterministic annotation completion.

- [ ] **Step 1: Write failing mailbox and helper tests**

Cover strict request/result persistence, interactive priority over leaderboard analysis and refills, oldest-first batching up to `--max-refills`, three pending annotations returning exactly three entries, invalid annotation rejection before outcome reservation, and idempotent completion.

```js
assert.equal(claim.kind, "import-annotation-batch");
assert.deepEqual(
  claim.jobs.map(({ id }) => id),
  ["annotation-1", "annotation-2", "annotation-3"],
);
```

```json
{
  "concept": "Copper observatory",
  "prompt": "A copper radio observatory under a dark coastal sky.",
  "style": ["cinematic landscape", "copper and blue"],
  "reasoningSummary": "Describes visible subject, composition, and palette without identity claims.",
  "source": "automated"
}
```

- [ ] **Step 2: Run protocol tests and verify failure**

Run: `npm run test:agent-protocol && npx vitest run src/server/agent-mailbox.test.ts src/server/mock-agent.test.ts`

Expected: FAIL because the new kind and completion helper do not exist.

- [ ] **Step 3: Implement request, batching, validation, and mock completion**

Add strict mailbox schemas and methods. Extend next-job scanning so interactive single jobs remain first, followed by a bounded oldest-first import-annotation batch, then cached analysis and refills. Keep the existing `--max-refills` CLI name as the coordinator concurrency limit and enforce `1..3`.

The completion helper reads `annotation.json`, forces `source: "automated"`, validates trimmed nonempty strings, 1-8 unique style tags, and the matching active job, then atomically publishes a terminal result. It never accepts image bytes.

Mock mode derives stable display-safe metadata from the job ID and completes asynchronously through the same file mailbox.

- [ ] **Step 4: Document annotation-batch monitor ownership**

Update the runner skill and protocol in the same change. Define
`import-annotation-batch` as analysis-only, require one fresh worker per entry,
use all three worker slots for three jobs, validate one strict
`annotation.json` per job, publish each result independently, and continue
polling after every terminal outcome.

- [ ] **Step 5: Run protocol, mailbox, and type tests**

Run: `npm run test:agent-protocol && npx vitest run src/server/agent-mailbox.test.ts src/server/mock-agent.test.ts && npm run typecheck`

Expected: PASS with all legacy priority and lease tests unchanged.

- [ ] **Step 6: Update the package script and commit Task 3**

Add `agent:complete-import-annotation` pointing at the new helper, then commit.

```bash
git add src/server/agent-mailbox.ts src/server/agent-mailbox.test.ts src/server/mock-agent.ts src/server/mock-agent.test.ts .agents/skills/run-diptych-picker package.json
git commit -m "Add imported image annotation jobs"
```

- [ ] **Step 7: Verify and open PR 1**

Run: `npm run check`

Expected: PASS. Push the branch, open a PR containing Tasks 1-3, request review, resolve actionable findings, verify required checks, and merge. Create the Task 4 branch from the updated remote default branch.

### Task 4: Import Session Service and Resolution API

**Files:**

- Create: `src/server/import-session-service.ts`
- Create: `src/server/import-session-service.test.ts`
- Create: `src/app/api/game/import/route.ts`
- Create: `src/app/api/game/import/route.test.ts`
- Create: `src/app/api/game/import/items/route.ts`
- Create: `src/app/api/game/import/items/[itemId]/route.ts`
- Create: `src/app/api/game/import/seal/route.ts`
- Modify: `src/server/runtime.ts`

**Interfaces:**

- Consumes: Tasks 1-3 repositories, normalizer, asset verifier, and annotation mailbox.
- Produces: `ImportSessionService.createOrResume`, `approve`, `seal`, `retry`, `annotateManually`, `remove`, `abandon`, `status`, and `reconcileAnnotations`.
- Produces: display-safe `ImportSessionStatus` responses with no filesystem or mailbox paths.

- [ ] **Step 1: Write failing service state-transition tests**

Test create-or-resume, approval and immediate enqueue, same-digest conflict, seal, retry with a fresh job ID, manual resolution, removal, stale item conflict, late-result suppression, and abandonment preserving asset files.

```ts
const approved = await service.approve(session.id, pngBytes);
expect(approved.item.status).toBe("annotating");
expect(mailbox.enqueueImportAnnotation).toHaveBeenCalledOnce();

await expect(service.approve(session.id, pngBytes)).rejects.toMatchObject({
  status: 409,
});
```

- [ ] **Step 2: Run service and route tests to verify failure**

Run: `npx vitest run src/server/import-session-service.test.ts src/app/api/game/import/route.test.ts`

Expected: FAIL because service and routes are missing.

- [ ] **Step 3: Implement locked state transitions and reconciliation**

Implement one mutation path that loads the expected session under its lock, validates current status, writes the new state, and performs mailbox publication or archival with recoverable expected-job records. Reconciliation verifies the exact expected request before accepting a result and creates candidates with stable IDs derived from session and item IDs.

Manual annotation accepts only:

```ts
{
  concept: string; // 1..120 trimmed characters
  prompt: string; // 1..500 trimmed characters
  style: string[]; // 1..8 unique tags, each 1..80 characters
}
```

Set `reasoningSummary` to `"Provided manually during image import."` and `source` to `"manual"` server-side.

- [ ] **Step 4: Implement narrow routes and runtime wiring**

Use `GET/POST/DELETE /api/game/import`, multipart `POST /api/game/import/items`, `PATCH /api/game/import/items/[itemId]` with discriminated actions `retry | manual | remove`, and `POST /api/game/import/seal`. Return 400 for input errors, 404 for missing session/items, and 409 for stale transitions.

- [ ] **Step 5: Run focused tests and type checking**

Run: `npx vitest run src/server/import-session-service.test.ts src/app/api/game/import/route.test.ts && npm run typecheck`

Expected: PASS with no route response containing local paths or raw mailbox records.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/server/import-session-service.ts src/server/import-session-service.test.ts src/server/runtime.ts src/app/api/game/import
git commit -m "Add image import workflow API"
```

### Task 5: Activation, Exact Initial Fill, and Imported Challenger Priority

**Files:**

- Create: `src/server/import-activation-service.ts`
- Create: `src/server/import-activation-service.test.ts`
- Modify: `src/server/agent-mailbox.ts`
- Modify: `src/server/mock-agent.ts`
- Modify: `src/server/game-service.ts`
- Modify: `src/server/game-service.test.ts`
- Modify: `src/server/game-selection-service.ts`
- Modify: `src/server/game-selection-service.test.ts`
- Modify: `src/server/refill-capacity-service.ts`
- Modify: `src/server/refill-capacity-service.test.ts`
- Modify: `src/server/import-session-service.ts`
- Modify: `src/server/import-session-service.test.ts`
- Modify: `src/domain/challenger-state.ts`
- Modify: `src/domain/challenger-state.test.ts`
- Modify: `.agents/skills/run-diptych-picker/scripts/complete-job.mjs`
- Create: `.agents/skills/run-diptych-picker/scripts/complete-job.test.mjs`
- Modify: `.agents/skills/run-diptych-picker/scripts/next-job.mjs`
- Modify: `.agents/skills/run-diptych-picker/scripts/next-job.test.mjs`
- Modify: `.agents/skills/run-diptych-picker/SKILL.md`
- Modify: `.agents/skills/run-diptych-picker/references/job-protocol.md`

**Interfaces:**

- Consumes: ready import items from Task 4.
- Produces: `ImportActivationService.reconcile(): Promise<GameStartState | null>` and `kind: "initial-import-fill-batch"` mailbox claims.
- Produces: imported-first draw behavior and generation gating via `RefillCapacityService.plan`.

- [ ] **Step 1: Write failing activation and scheduling tests**

Cover: no mutation before seal; five ready items activate two displayed plus three queued; prior game/history/ratings/preferences are absent; ready items beyond five append deterministically; zero through four ready items publish exactly five through one initial-fill jobs only after terminal annotation resolution; imported queue draws before ordinary ready; and no refill job appears while an imported item is annotating, failed, ready, or queued.

```ts
expect(activated.game.round.leftCandidate.id).toBe("import-item-1");
expect(activated.game.round.rightCandidate.id).toBe("import-item-2");
expect(challengers.importQueue.map(({ candidate }) => candidate.id)).toEqual([
  "import-item-3",
  "import-item-4",
  "import-item-5",
]);
expect(challengers.ratings.map(({ candidate }) => candidate.id)).toEqual([
  "import-item-1",
  "import-item-2",
]);
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npx vitest run src/server/import-activation-service.test.ts src/server/game-selection-service.test.ts src/server/refill-capacity-service.test.ts src/domain/challenger-state.test.ts`

Expected: FAIL because activation and import priority are missing.

- [ ] **Step 3: Implement exact initial-fill publication and reconciliation**

Add `InitialImportFillRequest` with session ID, preference seed, created time, and independent job ID. Publish exactly the deficit once. Extend next-job to return an oldest-first `initial-import-fill-batch` of at most the coordinator limit. Complete through the existing generated-candidate result contract without a retained winner or preference revision.

Mock mode produces deterministic standalone assets. Agent mode delegates one fresh native-image worker per job.

Teach `ImportSessionService.reconcileAnnotations` to reconcile initial-fill
results independently, append successful generated candidates to the ready
set, retain failed jobs as retryable activation failures, and never count one
job twice. Extend `complete-job.mjs` to validate and publish this generation
kind through the same immutable standalone-PNG contract.

- [ ] **Step 4: Implement atomic activation and imported-first draws**

Under import, game, challenger, and bootstrap locks, archive superseded jobs, validate five assets, create default game state, create ratings only for the displayed pair with `source: "imported"`, `poolMember: true`, and `poolEligible: true`, and persist the remaining ready imports in `importQueue`. Sort by annotation completion time then item ID.

Change candidate drawing to:

```ts
const next = state.importQueue[0] ?? state.ready[0] ?? null;
```

When an imported candidate is drawn, create its initial rating with `source: "imported"`, `poolMember: false`, and `poolEligible: true`. After its first completed comparison, pass both compared candidate IDs through a generalized `admitEligibleCandidate` that retains the existing strict-rank and tie behavior.

- [ ] **Step 5: Gate refills until import exhaustion**

`RefillCapacityService.plan` must return no ordinary refill jobs while the active import reports any nonterminal annotation or `challengers.importQueue.length > 0`. Initial-fill jobs are exempt because they are activation prerequisites. Pool fallback remains available from already-rated clean-session candidates.

- [ ] **Step 6: Document initial-fill monitor behavior**

Update the runner skill and protocol with `initial-import-fill-batch`. Require
one fresh native-image worker per entry, all three slots for a three-job batch,
one standalone square PNG and proposal per job, independent completion or
failure publication, no retained-winner mutation, and continued polling.

- [ ] **Step 7: Run focused tests and type checking**

Run: `npx vitest run src/server/import-activation-service.test.ts src/server/game-service.test.ts src/server/game-selection-service.test.ts src/server/refill-capacity-service.test.ts src/domain/challenger-state.test.ts && npm run typecheck`

Expected: PASS, including retained-winner identity tests.

- [ ] **Step 8: Commit Task 5**

```bash
git add src/domain/challenger-state.ts src/domain/challenger-state.test.ts src/server/import-activation-service.ts src/server/import-activation-service.test.ts src/server/import-session-service.ts src/server/import-session-service.test.ts src/server/agent-mailbox.ts src/server/mock-agent.ts src/server/game-service.ts src/server/game-service.test.ts src/server/game-selection-service.ts src/server/game-selection-service.test.ts src/server/refill-capacity-service.ts src/server/refill-capacity-service.test.ts .agents/skills/run-diptych-picker
git commit -m "Feed imports through the challenger stream"
```

### Task 6: Snapshot Recovery and Server Reconciliation

**Files:**

- Modify: `src/server/game-snapshot.ts`
- Modify: `src/server/game-snapshot.test.ts`
- Modify: `src/server/game-reconciler.ts`
- Modify: `src/server/game-reconciler.test.ts`
- Modify: `src/server/runtime.ts`
- Modify: `src/app/api/game/route.ts`
- Modify: `src/app/api/game/route.test.ts`
- Modify: `src/domain/game.ts`
- Modify: `src/server/repository.ts`

**Interfaces:**

- Consumes: active import session, imported queue, and import activation service.
- Produces: snapshot version support for active import state and runtime reconciliation on status reads.
- Produces: display-safe import progress on `GameStartState` or the existing game status envelope.

- [ ] **Step 1: Write failing snapshot and restart tests**

Test export/restore of imported candidates and queue provenance, omission of old job IDs, fresh annotation/initial-fill ownership after restore, asset verification through `LocalAssetStore`, import reconciliation before refill planning, and an unchanged export when an unrelated staged import has not activated.

```ts
const exported = await service.export();
expect(exported.importSession?.items[0].annotationJob).toBeNull();

await service.import(exported);
expect(mailbox.enqueueImportAnnotation).toHaveBeenCalledWith(
  expect.objectContaining({ kind: "import-annotation" }),
);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run src/server/game-snapshot.test.ts src/server/game-reconciler.test.ts src/app/api/game/route.test.ts`

Expected: FAIL because snapshots and reconciliation do not know imported state.

- [ ] **Step 3: Extend snapshot schemas and restoration**

Bump the snapshot schema with backward parsing for existing saves. Include an activated import session, imported queue, normalized asset metadata, resolved annotations, and pending statuses. Strip job IDs and session ownership from exported JSON. On restore, verify every imported asset, create fresh game/challenger/import session IDs, and publish unfinished work exactly once.

- [ ] **Step 4: Reconcile import outcomes before serving game state**

Runtime `getOrCreateGame`, selection completion, buffer health, and `/api/game` reads must reconcile annotation and initial-fill results, activate when eligible, append later ready imports once, and only then plan ordinary refill capacity.

Expose counts only:

```ts
interface ImportProgress {
  status: "editing" | "preparing" | "active" | "completed";
  annotating: number;
  ready: number;
  failed: number;
  unserved: number;
  activationTarget: 5;
}
```

- [ ] **Step 5: Run focused tests and full check**

Run: `npx vitest run src/server/game-snapshot.test.ts src/server/game-reconciler.test.ts src/app/api/game/route.test.ts && npm run check`

Expected: PASS with old saves and games still valid.

- [ ] **Step 6: Commit Task 6 and open PR 2**

```bash
git add src/domain/game.ts src/server/repository.ts src/server/game-snapshot.ts src/server/game-snapshot.test.ts src/server/game-reconciler.ts src/server/game-reconciler.test.ts src/server/runtime.ts src/app/api/game/route.ts src/app/api/game/route.test.ts
git commit -m "Recover active imported challenger streams"
```

Push Tasks 4-6, open PR 2, request review, resolve actionable findings, run required checks, and merge. Create the Task 7 branch from the updated remote default branch.

### Task 7: Browser File Inspection and Edit Rendering

**Files:**

- Create: `src/components/import-image-file.ts`
- Create: `src/components/import-image-file.test.ts`
- Create: `src/components/import-image-transform.ts`
- Create: `src/components/import-image-transform.test.ts`
- Create: `src/components/import-image-editor.tsx`
- Create: `src/components/import-image-editor.test.tsx`
- Create: `src/components/import-image-editor.module.css`

**Interfaces:**

- Produces: `inspectImportFile(file: File): Promise<ImportSource>`.
- Produces: pure `cropTransform`, `fitTransform`, and `renderNormalizedImport` functions.
- Produces: `ImportImageEditor` with explicit Approve and Remove callbacks and no bulk action.

- [ ] **Step 1: Write failing file and transform tests**

Use byte fixtures for PNG, JPEG, WebP, APNG `acTL`, animated WebP `ANIM`, empty data, and unsupported data. Test crop and fit matrix calculations for landscape, portrait, small, large, rotated, zoomed, and panned inputs. Render deterministic pixel fixtures in Playwright-facing browser tests rather than relying on jsdom canvas.

```ts
expect(await inspectImportFile(stillPng)).toMatchObject({
  contentType: "image/png",
  animated: false,
});
await expect(inspectImportFile(animatedPng)).rejects.toThrow(/animated/i);
expect(cropTransform({ width: 1600, height: 900 }, squareViewport)).toEqual(
  expect.objectContaining({ scale: 1024 / 900 }),
);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run src/components/import-image-file.test.ts src/components/import-image-transform.test.ts src/components/import-image-editor.test.tsx`

Expected: FAIL because inspection, transforms, and editor are missing.

- [ ] **Step 3: Implement strict source inspection**

Sniff signatures rather than trusting MIME or extension. Reject PNG files containing `acTL`, WebP RIFF payloads containing `ANIM` or `ANMF`, empty buffers, and unsupported signatures. Decode accepted sources with `createImageBitmap(file, { imageOrientation: "from-image" })` and report a per-file decode error.

- [ ] **Step 4: Implement deterministic editor transforms and rendering**

Keep transform math pure. Crop uses cover scale plus bounded pan, zoom, and rotation. Fit uses contain scale and fills the 1024-square output with the selected solid color before drawing the full image. Render to an `OffscreenCanvas` when available and an ordinary canvas otherwise, then encode `image/png`.

```ts
context.fillStyle = mode === "fit" ? background : "#000000";
context.fillRect(0, 0, 1024, 1024);
context.translate(512 + panX, 512 + panY);
context.rotate((rotation * Math.PI) / 180);
context.scale(scale * zoom, scale * zoom);
context.drawImage(bitmap, -width / 2, -height / 2);
```

- [ ] **Step 5: Implement the accessible single-image editor**

Provide crop/fit mode controls, pan/zoom/rotation inputs, background color in fit mode, Previous, Next, Remove, and Approve. Disable navigation only during the current approval upload. Expose a square preview and descriptive labels. Do not render any button or shortcut that approves multiple inputs.

- [ ] **Step 6: Run focused tests and type checking**

Run: `npx vitest run src/components/import-image-file.test.ts src/components/import-image-transform.test.ts src/components/import-image-editor.test.tsx && npm run typecheck`

Expected: PASS with no network request containing the original `File`.

- [ ] **Step 7: Commit Task 7**

```bash
git add src/components/import-image-file.ts src/components/import-image-file.test.ts src/components/import-image-transform.ts src/components/import-image-transform.test.ts src/components/import-image-editor.tsx src/components/import-image-editor.test.tsx src/components/import-image-editor.module.css
git commit -m "Build the human image normalization editor"
```

### Task 8: Import Workflow Modal and New-Game Integration

**Files:**

- Create: `src/components/use-image-import.ts`
- Create: `src/components/use-image-import.test.tsx`
- Create: `src/components/image-import-modal.tsx`
- Create: `src/components/image-import-modal.test.tsx`
- Create: `src/components/image-import-modal.module.css`
- Modify: `src/components/game-transfer-modal.tsx`
- Modify: `src/components/game-transfer-modal.test.tsx`
- Modify: `src/components/use-game-transfer.ts`
- Modify: `src/components/game-screen.tsx`
- Modify: `src/components/game-screen.test.tsx`

**Interfaces:**

- Consumes: Task 4 API and Task 7 editor.
- Produces: `useImageImport` queue controller and `ImageImportModal`.
- Produces: New Game -> Import images entry point and activation handoff to `commitStartState`.

- [ ] **Step 1: Write failing hook and modal tests**

Test multiple file selection, per-file validation errors, explicit approval, immediate multipart upload of only the normalized blob, duplicate conflict display, queue navigation, seal after the last approval/removal, progress waiting for five, pause/resume, abandon confirmation, and activation preload before committing the clean game.

```ts
expect(screen.queryByRole("button", { name: /accept all/i })).toBeNull();
await user.click(screen.getByRole("button", { name: "Approve image" }));
expect(fetch).toHaveBeenCalledWith(
  "/api/game/import/items",
  expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
);
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npx vitest run src/components/use-image-import.test.tsx src/components/image-import-modal.test.tsx src/components/game-transfer-modal.test.tsx src/components/game-screen.test.tsx`

Expected: FAIL because the workflow does not exist.

- [ ] **Step 3: Implement the queue controller**

Keep browser `File` and decoded bitmap state client-only. Poll display-safe session status while annotations or initial-fill jobs remain. After every approval or removal, advance to the next unresolved local input. Seal once none remain. If the server reports a ready game, preload changed assets and call `commitStartState` once.

- [ ] **Step 4: Implement modal states and annotation resolution**

Render the editor plus a sidebar with Editing, Annotating, Ready, Failed, and Removed counts. Failed server items render Retry, Annotate manually, and Remove. The manual form requires concept, description, and comma-separated style tags and sends the validated discriminated PATCH action.

Closing before activation pauses the modal and keeps the server session. Abandon requires confirmation and calls `DELETE /api/game/import`. When local unapproved inputs were lost on refresh, explain that they must be selected again.

- [ ] **Step 5: Add the New Game entry point**

Add an Import images option beside export/load/start-fresh. Disable it during selection reconciliation or another transfer mutation. Keep the current game mounted behind the modal until clean activation succeeds.

- [ ] **Step 6: Run focused tests and type checking**

Run: `npx vitest run src/components/use-image-import.test.tsx src/components/image-import-modal.test.tsx src/components/game-transfer-modal.test.tsx src/components/game-screen.test.tsx && npm run typecheck`

Expected: PASS with current load/export/new-game behavior unchanged.

- [ ] **Step 7: Commit Task 8**

```bash
git add src/components/use-image-import.ts src/components/use-image-import.test.tsx src/components/image-import-modal.tsx src/components/image-import-modal.test.tsx src/components/image-import-modal.module.css src/components/game-transfer-modal.tsx src/components/game-transfer-modal.test.tsx src/components/use-game-transfer.ts src/components/game-screen.tsx src/components/game-screen.test.tsx
git commit -m "Add the imported game workflow"
```

### Task 9: Active Import Progress and Failure Recovery UI

**Files:**

- Modify: `src/components/queue-details.tsx`
- Modify: `src/components/queue-details.test.tsx`
- Modify: `src/components/game-screen.tsx`
- Modify: `src/components/game-screen.test.tsx`
- Modify: `src/components/use-game-session-polling.ts`
- Modify: `src/components/game-screen.module.css`

**Interfaces:**

- Consumes: `ImportProgress` from Task 6 and resolution actions from Task 8.
- Produces: import counts in Queue details and a persistent actionable annotation-failure notice after activation.

- [ ] **Step 1: Write failing progress and failure-notice tests**

Test active counts, completed-session omission, no generated-refill status while imports remain, one persistent failure notice, reopening resolution controls, and clearing the notice only after Retry, Manual annotation, or Remove reaches the server.

```ts
expect(screen.getByText("3 imported challengers waiting")).toBeVisible();
expect(
  screen.getByRole("button", { name: "Resolve imported image" }),
).toBeVisible();
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npx vitest run src/components/queue-details.test.tsx src/components/game-screen.test.tsx`

Expected: FAIL because imported progress is not rendered.

- [ ] **Step 3: Implement polling and queue status**

Thread `ImportProgress` through the existing no-store game polling response. Queue details display annotating, ready/unserved, failed, and activation target counts without candidate prompts or mailbox fields.

- [ ] **Step 4: Implement post-activation failure recovery**

Render one nonblocking status notice when `failed > 0`. Its action opens the import modal directly on the first failed item. Successful resolution returns the player to the comparison without changing the retained winner or either visible image.

- [ ] **Step 5: Run focused tests and full check**

Run: `npx vitest run src/components/queue-details.test.tsx src/components/game-screen.test.tsx && npm run check`

Expected: PASS.

- [ ] **Step 6: Commit Task 9 and open PR 3**

```bash
git add src/components/queue-details.tsx src/components/queue-details.test.tsx src/components/game-screen.tsx src/components/game-screen.test.tsx src/components/use-game-session-polling.ts src/components/game-screen.module.css
git commit -m "Show imported challenger progress"
```

Push Tasks 7-9, open PR 3, request review, resolve actionable findings, verify required checks, and merge. Create the Task 10 branch from the updated remote default branch.

### Task 10: Runner Contract, Documentation, End-to-End Coverage, and Final QA

**Files:**

- Modify: `docs/USER_GUIDE.md`
- Modify: `docs/API.md`
- Modify: `docs/DATA_AND_RECOVERY.md`
- Modify: `docs/FEATURE_MATRIX.md`
- Modify: `docs/PRODUCT_NOTES.md`
- Modify: `examples/feature-scenarios.md`
- Modify: `tests/diptych-picker.spec.ts`
- Create: `tests/fixtures/import-landscape.png`
- Create: `tests/fixtures/import-portrait.jpg`
- Create: `tests/fixtures/import-square.webp`
- Create: `tests/fixtures/import-duplicate.png`
- Create: `tests/fixtures/import-animated.webp`

**Interfaces:**

- Consumes: all prior task behavior.
- Produces: final consistency verification for the already-versioned monitor instructions, public workflow and recovery documentation, and complete browser acceptance coverage.

- [ ] **Step 1: Add failing Playwright scenarios**

Cover crop and fit approval, no bulk approval, mixed aspect ratios and sizes, animation rejection, hash duplicate resolution, automated annotation progress, manual fallback, clean activation at five, exact shortfall generation, imports larger than pool maximum, generated-refill suppression until the imported stream is served, refresh recovery, snapshot restore, and retained winner DOM identity.

```ts
await page.getByRole("button", { name: "Import images" }).click();
await page.getByLabel("Choose images for a new game").setInputFiles(fixtures);
await expect(page.getByRole("button", { name: /accept all/i })).toHaveCount(0);
```

- [ ] **Step 2: Run the scenarios and verify failure before documentation changes**

Run: `npx playwright test tests/diptych-picker.spec.ts --grep "imported challenger"`

Expected: FAIL until all integrated behavior and fixtures are correct.

- [ ] **Step 3: Verify the monitor skill and job protocol end to end**

Read both documents against the implemented helpers and tests. Confirm they
describe `import-annotation-batch` as analysis-only and
`initial-import-fill-batch` as native standalone generation, one fresh worker
per entry, all three slots for three jobs, exact local source resolution,
strict file-backed results, independent terminal publication, continued
polling, winner immutability, and the prohibition on combined images. Fix any
drift in the same commit.

- [ ] **Step 4: Update public docs and examples**

Document supported still types, human normalization, crop/fit controls, canonical 1024 PNGs, local-only originals, hash deduplication, annotation/manual resolution, five-ready activation, clean-session behavior, imported-first scheduling, snapshot recovery, API methods, and the absence of cloud upload or external image APIs.

- [ ] **Step 5: Run targeted browser tests and inspect both viewports**

Run: `npx playwright test tests/diptych-picker.spec.ts --grep "imported challenger"`

Expected: PASS. Capture and inspect desktop and narrow screenshots for the editor, progress state, manual annotation form, first imported comparison, and background failure notice. Confirm exactly two independent candidate images at both widths.

- [ ] **Step 6: Run final verification**

Run:

```bash
npm run check
npm run build
npx playwright test
git diff --check
```

Expected: all commands PASS with no real model call in automated tests.

- [ ] **Step 7: Commit Task 10 and open PR 4**

```bash
git add .agents/skills/run-diptych-picker/SKILL.md .agents/skills/run-diptych-picker/references/job-protocol.md docs/USER_GUIDE.md docs/API.md docs/DATA_AND_RECOVERY.md docs/FEATURE_MATRIX.md docs/PRODUCT_NOTES.md examples/feature-scenarios.md tests/diptych-picker.spec.ts tests/fixtures
git commit -m "Document and verify imported challenger games"
```

Push PR 4, request review, resolve every actionable finding, verify all required checks, and merge. Pull the merged default branch, rerun the production build and full Playwright suite from exact merged HEAD, then restart the local `./run-only` app and persistent mailbox monitor under the updated protocol.
