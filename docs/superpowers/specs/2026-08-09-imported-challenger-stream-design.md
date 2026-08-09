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
- The editor stays open until every browser input is approved or removed.
- The game activates after editing is complete and five candidates are ready.
- If fewer than five valid imports remain, generation supplies exactly the
  missing count after editing and annotation work is resolved.
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
```

Browser-only files that have not been approved do not enter this repository.
After a refresh, server-owned approved items and their progress resume, while
unapproved inputs must be selected again. The modal explains this boundary
before the player leaves an unfinished editor.

The current game and challenger repositories are replaced atomically at
activation under their existing locks. Activation archives superseded initial
and refill jobs, creates a new session ID, and starts with default preferences,
an empty history, and no prior rating catalog. Two ready candidates form round
one; three form the initial ready buffer.

The active challenger state references the import session and maintains a
prioritized imported queue. Imported items not yet displayed are not reusable
pool members and do not consume pool capacity.

## Input Validation and Normalization

The browser accepts still PNG, JPEG, and WebP inputs. It rejects animated,
multipage, unsupported, empty, or undecodable files before editing. Source
aspect ratio and pixel dimensions have no product-level restriction; a browser
decode or canvas resource failure is reported against that file without
affecting the other inputs.

Source bytes remain in browser memory. Approval applies EXIF orientation and
the player's crop or fit transform, renders a 1024 by 1024 sRGB image, and
encodes it as PNG. The original file and its metadata are never uploaded.

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
from winner-pinned refill jobs because no comparison exists yet.

Activation requires both a sealed editor and five ready candidates. The first
five are ordered by annotation or initial-fill completion time with the durable
item ID as a tie-breaker. Two form the first comparison and three enter the
ready queue. Further completed import annotations append to the prioritized
imported queue.

Activation is atomic. A failure while validating assets or constructing either
repository leaves the previous game and the staged import unchanged and
retryable.

## Challenger and Pool Behavior

Domain provenance expands to include `source: "imported"` for candidate ratings
and buffered candidates. API and snapshot schemas preserve this source without
exposing mailbox paths.

Only the two initially displayed imports receive initial rating records at
activation. An imported ready candidate receives an initial rating when it is
first drawn into a comparison. After that comparison, the existing Elo update
and pool-admission path evaluates it exactly like an eligible generated
candidate.

Pool resize remains rank-based and bounded by the configured `poolMaximum`.
An imported candidate never displaces a strictly stronger member, ties do not
displace an existing member, and an imported loser can fail to enter a full
pool. This makes an oversized import self-pruning through ordinary comparisons
instead of arbitrary import-order truncation.

Refill planning accounts for three sources of pending supply:

- annotated imports waiting to be served;
- import annotations still capable of producing candidates; and
- ordinary ready or generated work.

No ordinary generated refill is published while either of the first two import
sources remains. Existing eligible pool fallback may continue at its normal
cadence if the imported ready queue temporarily runs dry. Once every retained
imported candidate has been displayed at least once and every import annotation
is terminal, the import session becomes completed and ordinary refill planning
resumes.

## UI Status and Recovery

The editing modal shows separate counts for inputs awaiting approval,
annotations in progress, candidates ready, failures requiring action, and the
five-candidate activation threshold.

Before activation, closing the modal pauses the workflow. Reopening Import
Images resumes the server-owned session and allows the user to add or reselect
browser inputs. An explicit **Abandon import** action removes the staging record
after confirmation but does not delete immutable assets or disturb the current
game.

After activation, background import progress moves to Queue details. A failed
late annotation raises a persistent, nonblocking notice that opens the same
Retry, Manual annotation, and Remove controls. Generation remains gated until
the failure is resolved.

Game snapshots include the active import stream, resolved imported candidates,
normalized asset metadata, and pending item state. They exclude session-bound
annotation and initial-fill job IDs. Restore verifies every referenced
immutable asset, creates a fresh game and import session ID, and republishes
only unfinished annotation or initial-fill work. A staged import that has not
activated is not included when exporting the still-current game.

## API Boundaries

The client uses narrow routes for:

- creating or reading the one active import session;
- approving one normalized PNG;
- sealing, pausing, or abandoning the session;
- retrying, manually annotating, or removing one item; and
- polling import progress as display-safe status.

Mutation routes require the expected session and item identifiers and reject
stale state transitions with a conflict response. Responses expose candidate
metadata and progress only; filesystem paths, original filenames, raw mailbox
records, and worker reasoning beyond the validated annotation summary remain
private.

## Failure Handling

- One invalid source does not discard the rest of the browser queue.
- One normalization or annotation failure does not mutate the current game.
- Duplicate normalized images never create duplicate annotation work or
  challenger candidates.
- Initial-fill failure leaves the import staged with Retry and Abandon options.
- Refresh or process restart reconciles completed mailbox results before
  publishing replacement work.
- Selection and import activation share the existing idle-state lock, so a
  game cannot activate across a concurrent comparison.
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
   and large dimensions enter the editor; animation and unsupported bytes do
   not.
2. Crop transforms and fit/background transforms render the expected canonical
   1024-square pixels with orientation applied and metadata removed.
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
    preferences, and no prior ratings or pool members.
11. Imports with zero through four retained images publish exactly the missing
    number of initial-fill generation jobs after annotation resolution.
12. Later annotation results append once and in deterministic completion order.
13. No ordinary generated refill is published while an annotation can still
    produce a candidate or an imported candidate remains unserved.
14. Generation resumes after the import stream is exhausted.
15. Imported candidates receive initial Elo only when first displayed, then use
    the ordinary comparison, admission, tie, both-lose, and pool-resize paths.
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
