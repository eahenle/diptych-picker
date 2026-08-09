# Imported Challenger Stream Design

## Purpose

Diptych Picker will let a player start a clean game from any number of still
PNG, JPEG, or WebP images, regardless of their source aspect ratio or pixel
dimensions. Every input is framed by the player, normalized to one standalone
square PNG, annotated automatically or by hand, and fed through the ordinary
challenger stream. Imported candidates earn ratings and reusable-pool
membership through comparisons instead of pre-populating or bypassing the
normal pool mechanism.

The feature preserves the game's core invariant: every comparison contains two
independent immutable image assets, and a retained winner is never edited,
re-encoded, regenerated, or replaced.

## Product Decisions

- An import creates a clean game. It does not merge prior history, ratings,
  preferences, pool membership, or queued challengers into the new session.
- Existing immutable assets and exported saves are never deleted by an import.
- Each selected image requires explicit human approval in the editor. There is
  no "accept all" action.
- The editor supports both a square crop and fitting the entire source over a
  chosen solid background.
- Approved images are normalized to canonical 1024 by 1024 sRGB PNGs.
- Normalized images are deduplicated by their exact canonical PNG digest within
  the active import.
- Automated annotation begins as soon as an image is approved.
- An annotation failure offers Retry, Manual annotation, and Remove actions.
- While any browser input remains unresolved, the editor cannot be closed or
  paused. The only exit is confirmed **Abandon import**. Close and Pause become
  available after sealing, when every browser input is approved or removed.
- The game activates after editing is complete and five candidates are ready.
- If fewer than five valid imports remain, generation supplies exactly the
  missing count after editing and annotation work is resolved.
- A failed initial fill remains staged and offers one session-level Retry that
  republishes only the still-missing supply.
- Generated refills remain suppressed until every imported candidate has been
  served once and no import annotation remains unresolved.

## User Flow

The New Game modal gains an **Import images** option. Selecting it opens a
multiple-file picker and then a persistent image-editing modal.

The modal presents one source at a time with a square preview, queue position,
and the states of all selected inputs. The player may:

- crop, pan, zoom, and rotate a source into the square frame;
- fit the full source into the square and choose its solid background color;
- navigate backward or forward among unapproved inputs;
- approve the current edit; or
- remove the current input.

Approval is final for that queue entry and immediately starts annotation while
the editor advances to the next input. If a different edit is needed, the
player removes that item and selects the source again. This keeps annotation
ownership and content hashes unambiguous.

There is no bulk approval. A duplicate normalized result is not annotated. It
remains visible with the matching queue item identified and must be removed or
edited differently.

When all browser inputs have been approved or removed, the editor seals the
import. If five annotated candidates are already ready, the clean game activates
and the modal closes. Otherwise the modal shows annotation or initial-fill
progress until five candidates are ready. Additional annotations may continue
after activation and feed the imported challenger stream in completion order.

## State Boundaries

An import is staged separately from the active game in one durable
`ImportSessionRepository`. Only one nonterminal import may exist at a time.
Starting an import leaves the current game readable and unchanged until the
new session can activate.

The durable session has an explicit version and records enough state to resume
server-owned work:

```ts
interface ImportSession {
  version: 1;
  id: string;
  status: "editing" | "preparing" | "active" | "completed";
  createdAt: string;
  sealedAt: string | null;
  activatedAt: string | null;
  items: ImportItem[];
  initialFillJobs: InitialFillJobRecord[];
  initialFillRetry: InitialFillRetryReceipt | null;
  servedReceipts: ServedImportReceipt[];
}

interface ImportItem {
  id: string;
  normalizedDigest: string;
  asset: ImportedAssetMetadata;
  status: "annotating" | "ready" | "failed" | "removed" | "served";
  annotationJob: ImportAnnotationJobRecord | null;
  annotation: ImportedCandidateAnnotation | null;
  candidateId: string | null;
  failureMessage: string | null;
  approvedAt: string;
  servedAt: string | null;
}

interface InitialFillJobRecord {
  id: string;
  attemptId: string;
  status: "pending" | "ready" | "failed" | "superseded";
  candidate: Candidate | null;
  source: "generated";
  importItemId: null;
  failureMessage: string | null;
  completedAt: string | null;
}

interface InitialFillRetryReceipt {
  requestId: string;
  failedAttemptId: string;
  replacementAttemptId: string;
  replacementJobIds: string[];
  createdAt: string;
}

interface ImportActivationIntent {
  id: string;
  phase: "prepared" | "writing" | "committed" | "cleaned";
  outcome: "undecided" | "commit" | "rollback";
  expectedOld: {
    importSessionId: string;
    gameRevisionId: string | null;
    challengerSessionId: string | null;
    bootstrapBatchId: string | null;
  };
  next: {
    game: GameState;
    challengers: ChallengerState;
    bootstrap: InitialBootstrap | null;
    importSession: ImportSession;
  };
  supersededJobIds: string[];
  archivedSupersededJobIds: string[];
  preparedAt: string;
  committedAt: string | null;
  cleanedAt: string | null;
}

interface ImportActivationIntentRepository {
  load(): Promise<ImportActivationIntent | null>;
  save(intent: ImportActivationIntent): Promise<void>;
  clear(expectedIntentId: string): Promise<void>;
  withLock<T>(operation: () => Promise<T>): Promise<T>;
}

interface ServedImportReceipt {
  dequeueOperationId: string;
  importSessionId: string;
  originalReceipt: PendingComparisonReceipt;
  replacementSlot: "single" | "pair-left" | "pair-right";
  importItemId: string;
  candidateId: string;
  candidate: Candidate;
  provenance: "imported";
  roundNumber: number;
  servedAt: string;
}
```

Browser-only files that have not been approved do not enter this repository.
After a refresh, server-owned approved items and their progress resume, while
unapproved inputs must be selected again. The modal explains this boundary
before the player leaves an unfinished editor.

Separate JSON repositories cannot be replaced atomically by locks alone.
Activation therefore uses a dedicated `ImportActivationIntentRepository` as a
write-ahead journal. The journal is a separate file outside the game,
challenger, bootstrap, and import-session aggregate it replaces; no target
repository contains the only copy of its own recovery intent. The intent
records the expected old repository identities, the complete new
game/challenger/bootstrap/import aggregate, and the exact superseded job IDs
before any target is changed. For an activation with five ready candidates,
`next.bootstrap` is `null`, explicitly clearing any superseded initial
bootstrap.

One shared state-lock coordinator makes nested lock acquisition impossible.
Every activation and selection path asks it for the needed subset of locks in
this canonical order:

1. activation-intent journal;
2. import session;
3. game;
4. challenger;
5. initial bootstrap; and
6. mailbox publication or archival, which occurs only after repository locks
   are released.

Preparation validates all assets and persists `phase: "prepared"` with
`outcome: "undecided"`. The writer then changes the phase to `"writing"` and
the outcome to `"commit"` before installing each new repository value in
canonical order. Each install is compare-and-set idempotent: the repository
must match either its expected old identity or the exact intended new value;
any third state is a conflict. If preparation fails before writing begins,
reconciliation chooses `outcome: "rollback"`, verifies every target still
matches its expected old identity, persists `phase: "cleaned"`, and only then
clears the journal, leaving the staged import retryable. Once `"writing"`
begins, startup reconciliation completes forward from the separate journal
rather than exposing a mixed aggregate. After every target
repository matches its intended value, the journal moves to
`phase: "committed"`; this is the commit point. Only then may it archive
superseded initial and refill jobs. Each successful archive is added
idempotently to `archivedSupersededJobIds` in the journal.

After all listed jobs are archived, reconciliation reacquires journal -> import
-> game -> challenger -> bootstrap locks, verifies every target still equals
the full intended value (including `bootstrap === null`), and persists
`phase: "cleaned"`. The cleaned journal remains durable through that phase.
Only a subsequent idempotent `clear(intent.id)` may remove it. A restart with a
cleaned commit journal repeats intended-target and archive verification before
clearing; a cleaned rollback journal repeats expected-old-target verification.
A failure during or after journal clearing is safe because every required
target and archive side effect for its outcome was already verified.

The committed aggregate creates a new session ID and starts with default
preferences, an empty history, and no prior rating catalog. Two ready
candidates form round one; three form the initial ready buffer.

The active challenger state references the import session and maintains a
prioritized queue whose entries preserve per-candidate provenance. Imported
entries carry their import item ID; initial-fill entries retain
`source: "generated"` and no import item ID. Neither kind becomes a reusable
pool member merely because it is queued or displayed.

## Input Validation and Normalization

The browser accepts still PNG, JPEG, and WebP inputs. It rejects animated,
multipage, unsupported, empty, malformed, truncated, or undecodable files
before editing. Source aspect ratio and pixel dimensions have no product-level
restriction; a browser decode or canvas resource failure is reported against
that file without affecting the other inputs.

Inspection structurally parses containers instead of searching arbitrary byte
substrings. The PNG parser requires a single first `IHDR`, validates every
big-endian chunk length, extent, and CRC, rejects `acTL`, requires one
terminal `IEND` with no trailing payload, and caps the walk at 4096 chunks. The
WebP parser verifies the RIFF size against the file, walks each padded chunk
within that declared boundary, rejects `ANIM` or `ANMF`, and caps the walk at
4096 chunks. The JPEG parser walks marker segments and entropy-coded scans,
rejects truncated lengths, structurally recognizes an APP2 MPF TIFF index,
rejects MPF/MPO and more than one image, and permits only padding after the
single EOI marker. These bounds prevent oversized lengths, malformed padding,
or decoy marker text inside pixel data from bypassing or confusing still-image
validation.

Source bytes remain in browser memory. Approval applies EXIF orientation and
the player's crop or fit transform, renders a 1024 by 1024 sRGB image, and
encodes it as PNG. The original file and its metadata are never uploaded.

Crop and fit expose different controls. Crop permits bounded pan and zoom
because clipping is intentional. Fit guarantees that every source pixel,
including its filtered boundary, remains visible. For source dimensions
`width` and `height` after orientation and rotation angle `theta` in radians,
fit computes the rotated axis-aligned bounds:

```ts
const rotatedWidth =
  Math.abs(width * Math.cos(theta)) + Math.abs(height * Math.sin(theta));
const rotatedHeight =
  Math.abs(width * Math.sin(theta)) + Math.abs(height * Math.cos(theta));
const scale = Math.min(1022 / rotatedWidth, 1022 / rotatedHeight);
```

The two-pixel reduction provides a one-pixel output inset on all sides for the
resampling footprint. Fit locks zoom to `1`, pan to `{ x: 0, y: 0 }`, disables
those controls, and recenters after every rotation. Switching back to crop
restores independent crop controls. Rotation remains available in fit mode,
but no fit-mode transform may move a rotated source boundary outside the
1024-square output.

The server treats the client render as untrusted. It enforces a bounded request
size for a 1024-square PNG, fully decodes the pixels, rejects animation or extra
pages, removes metadata, converts to sRGB, and re-encodes deterministically.
The SHA-256 digest of those exact canonical bytes becomes the immutable asset
filename and the import deduplication key. Publication uses the existing
no-overwrite content-addressed asset path and export-artifact contract.

If a digest already exists in local asset storage, identical bytes reuse the
immutable file. Within one import, only the first nonremoved item with that
digest may proceed to annotation.

## Annotation Contract

Every newly approved, nonduplicate item creates one durable
`import-annotation` mailbox request containing only its normalized local image
metadata. It never contains original source bytes or requests image generation.

The mailbox monitor treats import annotation as interactive work ahead of
leaderboard analysis and generated refills. The next-job helper may return an
`import-annotation-batch` of up to `workerLimit` independent entries. The
monitor starts exactly one fresh analysis worker per entry, using all three
worker slots when a three-entry batch is returned.

Each worker inspects exactly one normalized image and writes a strict
`annotation.json`:

```ts
interface ImportedCandidateAnnotation {
  concept: string;
  prompt: string;
  style: string[];
  reasoningSummary: string;
  source: "automated" | "manual";
}
```

`concept` is a concise display label. `prompt` is a factual, display-safe
description of the visible image rather than an instruction to reproduce it.
`style` contains short transferable medium, composition, lighting, palette, or
mood tags. Annotation must not identify a person, infer sensitive traits,
expose private readable text, or request identity, likeness, or exact copying.

The monitor validates the schema and content before completing through a new
file-backed helper. Agent mode uses the fresh analysis worker; mock mode returns
deterministic, valid metadata without model calls.

An automated failure is durable and does not silently remove the item. The UI
offers:

1. **Retry**, which archives the failed attempt and creates a fresh job ID.
2. **Annotate manually**, which collects concept, description, and style tags
   and submits them through the same validation schema.
3. **Remove**, which terminally excludes the item from this import.

Manual resolution and removal acquire the session lock. A late result from a
superseded job is archived and cannot re-enter the stream.

## Activation and Initial Fill

The editor automatically seals the session when its local input queue is empty.
Sealing is independent from annotation completion. A failed annotation remains
part of the sealed session and must eventually be retried successfully,
annotated manually, or removed. Five other ready candidates may still activate
the game, but the unresolved failure continues to block ordinary generated
refills and import-session completion.

When a sealed session has fewer than five ready candidates and no annotation
can still add another candidate, the server publishes `initial-import-fill`
generation jobs for exactly `5 - readyCount` images. These jobs use the clean
session's default preference seed, generate one standalone square candidate
each, and may be delegated concurrently up to `workerLimit`. They are separate
from winner-pinned refill jobs because no comparison exists yet. Every result
retains `source: "generated"`; it is not relabeled as imported merely because
it satisfies an import session's initial shortfall.

An initial-fill attempt has a durable attempt ID and per-job pending, ready, or
failed state. Any failure yields one display-safe session failure containing no
mailbox path or worker payload. Session-level **Retry initial fill** requires
the expected failed attempt ID plus a client request ID. Its receipt is
persisted before publication, so repeating the same request ID returns the same
replacement job set, while a different request against an old attempt returns 409. Retry archives the failed attempt after recording the receipt and
publishes exactly `5 - readyCount` replacement jobs; successful candidates from
the prior attempt remain ready and are never regenerated.

Activation requires both a sealed editor and five ready candidates. The first
five are ordered by annotation or initial-fill completion time with the durable
import item ID or initial-fill job ID as a tie-breaker. Two form the first
comparison and three enter the ready queue. Further completed import
annotations append to the prioritized imported queue.

Activation is recoverably transactional. A failure before aggregate writes
marks the separately journaled transaction as a verified cleaned rollback
before clearing it and leaves the staged import unchanged. A failure after the writing phase begins is completed forward from
the separate durable journal before any game read, selection, restart
reconciliation, or refill planning is allowed. Superseded jobs remain live
until the committed phase is durable. The journal is retained until targets,
archives, and the cleaned phase have all been durably verified.

## Challenger and Pool Behavior

Domain provenance expands to include `source: "imported"` for candidate ratings
and buffered candidates. Every buffered entry and initial rating also carries
`importItemId: string | null`: a real item ID for imported candidates and null
for initial-fill generated candidates. API and snapshot schemas preserve this
provenance without exposing mailbox paths.

Only the two initially displayed candidates receive initial rating records at
activation. Whether imported or initial-fill generated, each starts with
`poolMember: false` and `poolEligible: true`. A queued candidate receives the
same initial rating only when it is first drawn into a comparison. Display
never grants membership. After any ordinary recorded comparison outcome, both
compared candidate IDs pass through one generalized strict-rank admission
function that evaluates imported and generated candidates identically. Equal
ratings never displace an existing member.

Pool resize remains rank-based and bounded by the configured `poolMaximum`.
An imported candidate never displaces a strictly stronger member, ties do not
displace an existing member, and an imported loser can fail to enter a full
pool. This makes an oversized import self-pruning through ordinary comparisons
instead of arbitrary import-order truncation.

All ways of obtaining the next challenger call one source-aware dequeue
primitive. This includes normal winner selection, champion retirement, tie,
both-lose, prepared-selection recovery, and game-restart reconciliation. Every
request carries a stable `dequeueOperationId` equal to
`"dequeue-" + sha256(canonicalJson([importSessionId, originalReceipt, replacementSlot]))`.
The canonical receipt includes its outcome, original round number, compared
candidate IDs, and selection timestamp. A one-candidate draw uses slot
`"single"`; a two-candidate draw uses distinct `"pair-left"` and
`"pair-right"` slots. Thus two replacements from the same receipt cannot share
an identity. A legacy game with no import uses
`"game:" + challengerSessionId` in the namespace position and cannot create a
`ServedImportReceipt`; an active imported stream always uses its exact import
session ID.

The primitive returns
`{ dequeueOperationId, candidate, provenance, importItemId }`, where provenance
distinguishes imported queue, ordinary ready queue, and eligible pool fallback.
For an imported draw it persists a `ServedImportReceipt` keyed by
`dequeueOperationId` before changing the item to served under the canonical
journal -> import -> game -> challenger lock order. The receipt also stores the
import item and full candidate, so replay returns the same draw without
consuming another item or marking it served twice.

Prepared selection persists the original receipt, replacement slot, and
derived operation ID beside each pending replacement. Prepared-selection and
restart reconciliation must reuse that exact operation ID. Recovery reasons
are diagnostic only and never participate in identity derivation or create a
new receipt.

Each dequeue result also produces an immutable `ImportSupplySnapshot` from the
same locked state:

```ts
interface ImportSupplySnapshot {
  importSessionId: string | null;
  annotating: number;
  failed: number;
  readyUnserved: number;
  servedReceiptCount: number;
  initialFillPending: number;
  initialFillFailed: number;
  terminal: boolean;
}
```

This exact snapshot, rather than a later unlocked repository read, is passed
to refill planning and persisted with any prepared selection. Recovery reuses
the receipt and snapshot, making dequeue, served state, and generation gating
one replayable decision.

Refill planning accounts for three sources of pending supply:

- annotated imports waiting to be served;
- import annotations still capable of producing candidates; and
- ordinary ready or generated work.

No ordinary generated refill is published while either of the first two import
sources remains or initial-fill recovery is pending. Existing eligible pool
fallback may continue at its normal cadence if the imported ready queue
temporarily runs dry. Once every retained imported candidate has a durable
served receipt and every import annotation and initial-fill attempt is
terminal, the import session becomes completed and ordinary refill planning
resumes.

## UI Status and Recovery

The editing modal shows separate counts for inputs awaiting approval,
annotations in progress, candidates ready, failures requiring action, and the
five-candidate activation threshold.

While browser inputs remain unresolved, modal close, Escape, backdrop click,
and Pause are disabled; a browser navigation attempt raises the unsaved-input
warning. The only exit is **Abandon import**, which requires confirmation,
removes the staging record, and does not delete immutable assets or disturb the
current game. Once every browser input is approved or removed, the editor seals
and Pause/close becomes available while server-owned annotation or initial-fill
work continues. Reopening Import Images resumes that sealed session. After a
refresh, any browser-only inputs lost despite the warning must be selected
again.

After activation, background import progress moves to Queue details. A failed
late annotation raises a persistent, nonblocking notice that opens the same
Retry, Manual annotation, and Remove controls. Generation remains gated until
the failure is resolved.

Game snapshots include the active import stream, resolved imported candidates,
normalized asset metadata, and pending item state. They exclude session-bound
annotation and initial-fill job IDs, and they never embed or clear the separate
activation journal. Restore verifies every referenced immutable asset and
creates fresh game and import session IDs. It re-keys exported served receipts
and unfinished prepared dequeues from the fresh import ID plus each preserved
original receipt and replacement slot, keeping pair slots distinct, then
republishes only unfinished annotation or initial-fill work. A staged import
that has not activated is not included when exporting the still-current game.

## API Boundaries

The client uses narrow routes for:

- creating or reading the one active import session;
- approving one normalized PNG;
- sealing, pausing after seal, or abandoning the session;
- retrying, manually annotating, or removing one item; and
- retrying a failed initial-fill attempt at session level; and
- polling import progress as display-safe status.

Mutation routes require the expected session and item identifiers and reject
stale state transitions with a conflict response. Responses expose candidate
metadata and progress only; filesystem paths, original filenames, raw mailbox
records, and worker reasoning beyond the validated annotation summary remain
private.

`PATCH /api/game/import` with action `retry-initial-fill` carries the expected
session ID, failed attempt ID, and client request ID. It returns the same
display-safe status for an exact duplicate request and 409 for stale session or
attempt IDs. Pause on this route is valid only for a sealed session; an editing
session with unresolved browser inputs returns 409 even if a stale client tries
to pause it.

## Failure Handling

- One invalid source does not discard the rest of the browser queue.
- One normalization or annotation failure does not mutate the current game.
- Duplicate normalized images never create duplicate annotation work or
  challenger candidates.
- Initial-fill failure leaves the import staged with Retry and Abandon options.
- A duplicate initial-fill Retry is idempotent; a stale Retry cannot publish
  replacement work.
- Refresh or process restart reconciles completed mailbox results before
  publishing replacement work.
- Activation and every dequeue/recovery path use the canonical activation
  journal, import, game, challenger, bootstrap lock order, so activation cannot
  cross a comparison or deadlock restart reconciliation.
- Late or duplicate terminal publications are idempotent and cannot append a
  candidate twice.
- Abandoning an import archives pending jobs and ignores late results. Active
  workers may finish safely; their assets are immutable but unreferenced.
- No cleanup path deletes an asset referenced by a current game, rating catalog,
  ready queue, import session, snapshot, or mailbox result.

## Testing and Acceptance

Unit, route, protocol, and browser tests use deterministic local fixtures and
the mock provider unless a mailbox script itself is under test. They prove:

1. Still PNG, JPEG, and WebP files with landscape, portrait, square, very small,
   and large dimensions enter the editor; structurally valid APNG, animated
   WebP, MPF/MPO JPEG, truncated chunks/segments, malformed chunk lengths,
   multiple JPEG images, and unsupported bytes do not. Decoy marker substrings
   inside still-image pixel data do not cause false rejection.
2. Crop transforms and fit/background transforms render the expected canonical
   1024-square pixels with orientation applied and metadata removed. At 0, 90,
   and an arbitrary non-right-angle rotation, pixel-boundary fixtures prove
   every source edge pixel remains visible in fit mode and pan/zoom cannot clip
   it.
3. Every input requires its own approval and no bulk-approval control exists.
4. Canonical server re-encoding is deterministic and digest deduplication blocks
   identical normalized images within an import.
5. Approval immediately enqueues one annotation without waiting for later
   browser inputs.
6. Import annotation batches never exceed `workerLimit`, and three independent
   jobs cause three fresh workers to be delegated by the documented runner.
7. Automated annotations validate concept, prompt, style tags, summary, and
   privacy constraints without generating an image.
8. Failed annotations remain actionable through Retry, Manual annotation, and
   Remove; stale terminal results cannot undo the chosen resolution.
9. The current game remains byte-for-byte unchanged before activation.
10. A sealed import with five ready candidates creates a clean game with two
    displayed candidates, three buffered candidates, empty history, default
    preferences, and no pool members. Displayed imported and initial-fill
    generated candidates retain distinct provenance and begin
    `poolMember: false`, `poolEligible: true`.
11. Imports with zero through four retained images publish exactly the missing
    number of initial-fill generation jobs after annotation resolution.
12. Later annotation results append once and in deterministic completion order.
13. No ordinary generated refill is published while an annotation can still
    produce a candidate or an imported candidate remains unserved.
14. Generation resumes after the import stream is exhausted.
15. Imported and initial-fill generated candidates receive initial Elo only
    when first displayed. Display alone does not grant membership; every
    recorded selection, tie, or both-lose comparison then invokes the same
    generalized strict-rank admission path for the compared candidates.
16. An import larger than `poolMaximum` is not truncated on upload; ordinary
    rating and pool rules keep membership within quota as candidates play.
17. Refresh resumes approved items and reports that unapproved browser inputs
    must be selected again.
18. Abandonment preserves the current game and immutable assets while preventing
    pending or late results from entering a future session.
19. Snapshot export and restore preserve active imported candidates and requeue
    unfinished work with fresh ownership.
20. Desktop and narrow browser tests preserve exactly two independent candidate
    images and the retained winner's exact ID, URL, bytes, metadata, side, and
    DOM node across imported-stream comparisons.
21. Failure injection after separate-journal persistence, every aggregate
    repository write including bootstrap clear-to-null, commit marking, every
    job archive and archived-ID journal update, target verification, cleaned
    marking, and journal clear proves restart either takes a no-write prepared
    intent through verified cleaned rollback or completes the intended
    aggregate and cleanup without exposing mixed state or losing the journal
    early.
22. Normal, retirement, tie, both-lose, prepared-selection, and restart paths
    all use the same source-aware dequeue. One-candidate and pair-left/pair-right
    draws derive distinct stable operation IDs from the original durable
    receipt. Crash/replay preserves operation ID, candidate, provenance, import
    item ID, served receipt, and refill supply snapshot without double
    consumption; prepared and restart recovery reuse the original ID.
23. Initial-fill failure status is display-safe. Session-level Retry publishes
    only the remaining deficit, exact duplicate requests return the original
    result, and stale requests return 409 without a side effect.
24. Close, Escape, backdrop, and Pause cannot leave an editor with unresolved
    browser inputs; confirmed Abandon is the only exit until all are approved
    or removed and the session seals.

Formatting, documentation checks, linting, type checking, unit and protocol
tests, a production build, Playwright coverage, and manual desktop and narrow
viewport inspection must pass before merge.

## Out of Scope

- Animated or multipage image import.
- Video, PDF, SVG, RAW, HEIC, or formats other than still PNG, JPEG, and WebP.
- Bulk auto-approval or unattended crop decisions.
- Editing or replacing a retained winner.
- Preloading all imported images into reusable-pool membership.
- Cloud upload, synchronization, collaborative imports, or external image APIs.
- Destructive garbage collection of unreferenced immutable assets.
