# Agent mailbox protocol

The data root is `LOCAL_DATA_DIR` when set and `.local-data` otherwise.

- [Paths](#paths)
- [Job request](#job-request)
- [Proposal](#proposal)
- [Completed result](#completed-result)
- [Failed result and heartbeat](#failed-result-and-heartbeat)

## Paths

- `agent-mailbox/pending/<jobId>.json`: immutable request waiting to be claimed
- `agent-mailbox/active/<jobId>.json`: request claimed by the coordinator
- `agent-mailbox/batches/<batchId>.json`: durable initial-batch owner token
- `agent-mailbox/outcomes/<jobId>.json`: exclusive `completed` or `failed` outcome reservation
- `agent-mailbox/completed/<jobId>.json`: successful terminal result
- `agent-mailbox/failed/<jobId>.json`: retryable terminal failure
- `agent-mailbox/heartbeat.json`: last coordinator status
- `agent-work/<jobId>/proposal.json`: structured proposal passed by file
- `agent-work/<jobId>/failure.txt`: failure reason passed by file
- `agent-work/<jobId>/image.png`: worker-generated standalone image
- `assets/<sha256-of-png-bytes>.png`: immutable content-addressed generated candidate asset
- `output/artifacts/<sha256-of-png-bytes>.png`: discoverable immutable export of every completed candidate

Only the helper scripts move or create mailbox artifacts. The app archives terminal artifacts after reconciling them into game state.

## Job request

```json
{
  "id": "job-id",
  "kind": "challenger",
  "createdAt": "ISO-8601 timestamp",
  "roundNumber": 2,
  "winnerSide": "left",
  "retainedWinner": {
    "id": "candidate-id",
    "imageUrl": "/api/assets/candidate-id.png",
    "prompt": "original visual prompt",
    "concept": "concept name",
    "style": ["tag"],
    "createdAt": "ISO-8601 timestamp",
    "winCount": 1,
    "reasoningSummary": "optional"
  },
  "rejectedCandidate": {
    "id": "candidate-id",
    "imageUrl": "/api/assets/candidate-id.png",
    "prompt": "original visual prompt",
    "concept": "concept name",
    "style": ["tag"],
    "createdAt": "ISO-8601 timestamp",
    "winCount": 0
  },
  "selectionHistory": [],
  "recentConcepts": ["concept"],
  "preferenceSeed": "editable preference profile",
  "preferenceProfile": {
    "themes": "explicit subjects and themes",
    "inspiration": "optional aesthetic cues",
    "mediaTypes": "photography",
    "visualStyle": "cinematic",
    "colorPalette": "oxblood and ultraviolet",
    "contentLevel": "family-friendly",
    "avoid": "readable text",
    "adaptationMode": "static",
    "adaptationSourceWinnerIds": []
  }
}
```

`kind` is `challenger`, `initial`, or `refill`. Initial jobs also require the same `batchId` on both jobs and a distinct `initialSide` of `left` or `right`:

```json
{
  "id": "initial-batch-1-left",
  "kind": "initial",
  "batchId": "batch-1",
  "initialSide": "left"
}
```

The remaining request fields carry the same preference context. A missing `kind` is tolerated as a legacy challenger.

The preference seed is the authoritative creative brief for every worker. Explicit subject, subject-count, medium, style, palette, content-level, and avoidance guidance outranks retained-winner metadata, rejected candidates, selection history, and recent concepts. Those secondary fields may guide novelty only within the seed's constraints; they must never redirect the image proposal to an unrelated subject or metaphor. The monitor must reject or fail a proposal and image that contradict an explicit seed constraint rather than publish it.

New jobs include the structured `preferenceProfile`; legacy jobs may omit it and are treated as Static. In Static mode, omit `preferenceRevision` and preserve every preference field exactly. In Adaptive mode, the worker must add a complete `preferenceRevision` conditioned on the retained winner and selection history. The app adopts that revision only if this generated candidate later wins, records that winner's ID as its source, and rebuilds future generation capacity from the revised profile.

Refill jobs carry the same preference context plus durable session and pinned-winner ownership:

```json
{
  "id": "refill-job-1",
  "kind": "refill",
  "sessionId": "session-1",
  "pinnedWinnerId": "candidate-id"
}
```

`pinnedWinnerId` must equal `retainedWinner.id`. Each refill is an independent candidate-generation job and has its own proposal, image, and terminal outcome.

At monitor startup or restart, run `npm run agent:next -- --resume --wait-ms 0 --max-refills <workerLimit>` until it prints no JSON. `workerLimit` is the number of immediately available fresh image-worker subagent slots, capped at 3, that the root supervisor passed to the monitor. The helper prints one unterminated active challenger/initial request or a bounded batch of unterminated active refills when recovery is needed, and claims pending work when none is active. Initial requests include the recovered durable `batchOwnerToken`. Do not use `--resume` in the ordinary polling loop.

`npm run agent:next -- --wait-ms 30000 --max-refills <workerLimit>` prioritizes one pending challenger or initial request. When neither is claimable, it atomically renames up to the requested number of oldest refill requests from `pending` to `active`. The refill limit must be from 1 through 3 and must not exceed immediately available worker slots. The helper never mixes challenger/initial work into a refill batch and emits strict JSON:

```json
{
  "kind": "refill-batch",
  "jobs": [{ "id": "refill-job-1", "kind": "refill" }]
}
```

Every returned refill must immediately receive its own fresh worker. Before claiming the first side of an initial batch, the helper atomically creates one batch ownership record and includes its unguessable `batchOwnerToken` in the printed request. Other ordinary calls skip the owner's pending partner. A wait must be between 0 and 30000 milliseconds. `--max-refills` is not accepted with owned `--batch` inspection.

After receiving an initial job, use `npm run agent:next -- --wait-ms 30000 --batch <batchId> --owner-token <batchOwnerToken>`. Both arguments are required and the token must match the durable ownership record. If a call times out without JSON, repeat that same owned-batch call; do not make an ordinary next-job call while the partner is pending. Continue until the partner or terminal request appears, or the user stops the runner. For a new batch, this claims or returns the opposite-side partner before exactly two parallel workers start. On recovery, if one partner already has a completed or failed result, batch inspection returns that request with `terminalStatus: "completed"` or `"failed"`; never generate that side again and process only the unfinished request. If the unfinished partner was still pending, startup `--resume` claims it under the recovered owner token before batch inspection reports the terminal side.

## Proposal

Write this strict JSON object to `<data-root>/agent-work/<jobId>/proposal.json`:

```json
{
  "concept": "short distinct concept",
  "visualPrompt": "prompt for one standalone square image",
  "styleTags": ["specific visual tag"],
  "reasoningSummary": "why this challenger tests the learned preference",
  "preferenceRevision": {
    "themes": "complete revised themes of at least 20 characters",
    "inspiration": "revised aesthetic cues",
    "mediaTypes": "revised media",
    "visualStyle": "revised visual style",
    "colorPalette": "revised palette",
    "contentLevel": "family-friendly",
    "avoid": "revised exclusions"
  }
}
```

The four base proposal fields are always required. `preferenceRevision` must be omitted for Static jobs and is required for Adaptive jobs; it must contain every preference field except the mode and source IDs. Every proposal string, including each `styleTags` entry, is trimmed and must contain at least one non-whitespace character. Revision fields are trimmed model output, themes must contain at least 20 characters, and the same field limits as the UI apply. `reasoningSummary` must explain how the image proposal follows the authoritative preference seed while staying distinct from recent work. Invalid proposals fail before any outcome, result, or asset is published.

## Completed result

`npm run agent:complete -- --job <id> --proposal-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/proposal.json" --image "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/image.png"` requires the matching active job. It rejects inputs over 50 MB or 4096 by 4096 pixels, then uses Sharp to identify and fully decode exactly one square PNG. It reserves the `completed` outcome, hashes the exact PNG bytes with SHA-256, creates `assets/<sha256>.png` and `output/artifacts/<sha256>.png` without overwriting, and atomically publishes:

```json
{
  "jobId": "job-id",
  "status": "completed",
  "completedAt": "ISO-8601 timestamp",
  "proposal": {
    "concept": "concept",
    "visualPrompt": "prompt",
    "styleTags": ["tag"],
    "reasoningSummary": "reason",
    "preferenceRevision": {
      "themes": "complete revised themes of at least 20 characters",
      "inspiration": "revised aesthetic cues",
      "mediaTypes": "revised media",
      "visualStyle": "revised visual style",
      "colorPalette": "revised palette",
      "contentLevel": "family-friendly",
      "avoid": "revised exclusions"
    }
  },
  "asset": {
    "candidateId": "challenger-job-id",
    "filename": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png",
    "imageUrl": "/api/assets/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png",
    "contentType": "image/png",
    "width": 1024,
    "height": 1024,
    "byteLength": 123456
  }
}
```

## Failed result and heartbeat

Write the reason to `<data-root>/agent-work/<id>/failure.txt`. `npm run agent:fail -- --job <id> --message-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/failure.txt"` requires the matching active job, reserves the `failed` outcome, and atomically publishes a result with `status: "failed"`, an ISO timestamp, the non-empty `message`, and `retryable: true`.

Only one outcome reservation can exist for a job. A retry matching that outcome resumes safely and returns an already-published result unchanged. The opposite outcome is rejected. Completion also resumes when its deterministic asset already exists only if the existing bytes exactly equal the validated source; differing bytes are never overwritten.

`npm run agent:heartbeat -- --status <status> [--job <id>]` atomically replaces `heartbeat.json` with the status, optional job ID, and update timestamp. Use `waiting`, `generating`, and `stopped` coordinator states. The heartbeat does not record the short-lived helper process PID.
