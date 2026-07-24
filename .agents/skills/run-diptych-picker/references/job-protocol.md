# Agent mailbox protocol

The data root is `LOCAL_DATA_DIR` when set and `.local-data` otherwise.

- [Paths](#paths)
- [Persistent-worker leases](#persistent-worker-leases)
- [Job request](#job-request)
- [Proposal](#proposal)
- [Completed result](#completed-result)
- [Failed result and heartbeat](#failed-result-and-heartbeat)

## Paths

- `agent-mailbox/pending/<jobId>.json`: immutable request waiting to be claimed
- `agent-mailbox/active/<jobId>.json`: request claimed by the coordinator
- `agent-mailbox/batches/<batchId>.json`: durable initial-batch owner token
- `agent-mailbox/leases/<jobId>.json`: renewable persistent-worker claim
- `agent-mailbox/expired-leases/<jobId>.<token>.json`: revoked lease audit
- `agent-mailbox/lease-locks/<jobId>.lock/`: short-lived ownership lock
- `agent-mailbox/outcomes/<jobId>.json`: exclusive `completed` or `failed` outcome reservation
- `agent-mailbox/completed/<jobId>.json`: successful terminal result
- `agent-mailbox/failed/<jobId>.json`: retryable terminal failure
- `agent-mailbox/heartbeat.json`: last coordinator status
- `agent-work/<jobId>/proposal.json`: structured proposal passed by file
- `agent-work/<jobId>/failure.txt`: failure reason passed by file
- `agent-work/<jobId>/image.png`: worker-generated standalone image
- `agent-work/<jobId>/profile.json`: source-profile or leaderboard-profile analysis passed by file
- `agent-work/<jobId>/suggestions.json`: two prompt-card editor proposals passed by file
- `agent-work/<jobId>/suggestion.json`: one prompt-card blender or writer proposal passed by file
- `profile-sources/<sha256-of-normalized-png-bytes>.png`: private, metadata-stripped source upload
- `assets/<sha256-of-png-bytes>.png`: immutable content-addressed generated candidate asset
- `output/artifacts/<sha256-of-png-bytes>.png`: discoverable immutable export of every completed candidate

Only the helper scripts move or create mailbox artifacts. The app archives terminal artifacts after reconciling them into game state.

## Persistent-worker leases

The optional co-proc path uses a version-2 generation frame with an unguessable
`lease_token`, an absolute `lease_path`, and `lease_duration_ms` from 10000
through 600000. The peer must claim before acknowledging:

```bash
npm run agent:claim-lease -- \
  --job <id> \
  --channel <channel> \
  --lease-token <token> \
  --lease-ms <duration>
```

The helper serializes ownership with the per-job lease lock, verifies that no
terminal result exists, creates an owner-only lease, and atomically moves the
matching pending file to active. It is idempotent only for the same live token.
The peer then returns a version-2 `ack` with the same token and the exact
`expiresAt` printed by the helper. An acknowledgement without that durable
lease is unconfirmed delivery.

The owner renews before expiry:

```bash
npm run agent:renew-lease -- \
  --job <id> \
  --lease-token <token> \
  --lease-ms <duration>
```

Every completion or failure command accepts `--lease-token <token>`. A live
lease rejects an omitted or different token, and the exclusive outcome
reservation records the token so a matching idempotent publication retry
remains possible. The mailbox monitor never creates a lease. `agent:next`
skips live leases; under the same lock it revokes an expired lease and returns
that active job during ordinary polling or startup recovery. A stale peer
cannot reserve an outcome after takeover.

After a leased completion or failure helper has successfully published the
durable result, the persistent peer sends exactly one correlated terminal
frame:

```json
{
  "version": 2,
  "type": "result",
  "id": "job-id",
  "lease_token": "uuid",
  "status": "completed",
  "result_path": "/absolute/data-root/agent-mailbox/completed/job-id.json"
}
```

`status` is `completed` or `failed`, and `result_path` must be the absolute,
normalized path for the matching job beneath that exact mailbox directory.
The app rejects another token, job ID, status directory, or path, then eagerly
ingests the file through the normal strict result parser. The durable file
remains authoritative if the frame is missing, malformed, delayed, or lost
during a restart. The mailbox monitor does not hold a lease and never sends
co-proc terminal frames.

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
  "leaderboardEvidence": {
    "poolSize": 18,
    "entries": [
      {
        "rank": 1,
        "candidateId": "candidate-id",
        "concept": "display-safe concept",
        "style": ["concise tag"],
        "rating": 1124,
        "wins": 9,
        "losses": 2,
        "source": "generated",
        "favorite": false
      }
    ]
  },
  "preferenceSeed": "editable preference profile",
  "promptCard": {
    "id": "card-1",
    "title": "Industrial nocturne",
    "prompt": "A severe industrial nocturne with tactile materials and off-axis cinematic light.",
    "negativePrompt": "readable text, logos",
    "tags": ["industrial", "nocturne"]
  },
  "preferenceProfile": {
    "themes": "explicit subjects and themes",
    "inspiration": "optional aesthetic cues",
    "mediaTypes": "photography",
    "visualStyle": "cinematic",
    "colorPalette": "oxblood and ultraviolet",
    "contentLevel": "family-friendly",
    "avoid": "readable text",
    "adaptationMode": "static",
    "adaptationStrength": "guided",
    "adaptationLastDecision": 0,
    "adaptationSourceWinnerIds": [],
    "adaptationSourceRejectedIds": []
  }
}
```

`kind` is `challenger`, `initial`, `refill`, `source-profile`, `leaderboard-profile`, `prompt-card-editor`, `prompt-card-blender`, or `prompt-card-writer`. Initial jobs also require the same `batchId` on both jobs and a distinct `initialSide` of `left` or `right`:

```json
{
  "id": "initial-batch-1-left",
  "kind": "initial",
  "batchId": "batch-1",
  "initialSide": "left"
}
```

The remaining request fields carry the same preference context. A missing `kind` is tolerated as a legacy challenger.

An interactive source-image analysis has no comparison or preference context. The server fully decodes the PNG, JPEG, or WebP upload, strips metadata by normalizing it to PNG, stores it privately under the data root, and enqueues:

```json
{
  "id": "source-profile-job-1",
  "kind": "source-profile",
  "createdAt": "ISO-8601 timestamp",
  "sourceImage": {
    "filename": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png",
    "path": "profile-sources/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png",
    "contentType": "image/png",
    "width": 1200,
    "height": 900,
    "byteLength": 123456
  }
}
```

The source remains private: it is not copied to generated assets or exports. A fresh source-profile worker inspects the existing file without calling image generation. It describes transferable subject matter, setting, composition, medium, lighting, mood, palette, and constraints without identifying a depicted person or requesting identity, likeness, or exact reproduction.

Adaptive games cache a visual synthesis of the exact current top cohort. Pool assets are read through their validated local storage, normalized through the same content-addressed `profile-sources` pipeline as an uploaded source, and enqueued without exposing prompts or modifying the originals:

```json
{
  "id": "leaderboard-profile-job-1",
  "kind": "leaderboard-profile",
  "createdAt": "ISO-8601 timestamp",
  "fingerprint": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "sources": [
    {
      "candidateId": "pool-leader",
      "rank": 1,
      "rating": 1124,
      "wins": 9,
      "losses": 2,
      "favorite": false,
      "source": "generated",
      "concept": "display-safe concept",
      "style": ["concise tag"],
      "sourceImage": {
        "filename": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png",
        "path": "profile-sources/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png",
        "contentType": "image/png",
        "width": 1024,
        "height": 1024,
        "byteLength": 123456
      }
    },
    {
      "candidateId": "pool-runner-up",
      "rank": 2,
      "rating": 1098,
      "wins": 7,
      "losses": 3,
      "favorite": true,
      "source": "curated",
      "concept": "second display-safe concept",
      "style": ["second concise tag"],
      "sourceImage": {
        "filename": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.png",
        "path": "profile-sources/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.png",
        "contentType": "image/png",
        "width": 1024,
        "height": 1024,
        "byteLength": 123457
      }
    }
  ]
}
```

A leaderboard-profile job contains two through four unique leaders. Its SHA-256 fingerprint depends on their ordered rank and candidate IDs, so ordinary Elo changes do not repeat visual analysis while a meaningful cohort or rank-order change does. One fresh analysis worker inspects every source together, emits the same strict profile shape as source-image ingestion, and never calls image generation. A failed fingerprint is not retried until the cohort changes. The completed digest is cached internally; it never directly overwrites user-entered preferences.

When an active card accumulates four new rejects and at least four of them remain inside the deck's latest twelve verdicts, the app reserves that rejection checkpoint and enqueues one editor request:

```json
{
  "id": "prompt-card-editor-job-1",
  "kind": "prompt-card-editor",
  "createdAt": "ISO-8601 timestamp",
  "card": {
    "id": "card-1",
    "title": "Industrial nocturne",
    "prompt": "A severe industrial nocturne with tactile materials and off-axis cinematic light.",
    "negativePrompt": "readable text, logos",
    "tags": ["industrial", "nocturne"]
  },
  "recentRejections": [
    {
      "resultId": "candidate-1",
      "reason": "Selected comparison winner",
      "recordedAt": "ISO-8601 timestamp"
    },
    {
      "resultId": "candidate-2",
      "reason": "Selected comparison winner",
      "recordedAt": "ISO-8601 timestamp"
    },
    {
      "resultId": "candidate-3",
      "reason": "Selected comparison winner",
      "recordedAt": "ISO-8601 timestamp"
    },
    {
      "resultId": "candidate-4",
      "reason": "Both images rejected",
      "recordedAt": "ISO-8601 timestamp"
    }
  ]
}
```

The actual request contains four through twelve rejection entries. One fresh editor worker returns exactly two alternatives; it never mutates the source card or generates an image. Suggestions remain approval-gated until the player accepts one as a new immutable child card or discards it.

An explicit two-card blend enqueues both immutable card snapshots and the requested first-card influence ratio:

```json
{
  "id": "prompt-card-blender-job-1",
  "kind": "prompt-card-blender",
  "createdAt": "ISO-8601 timestamp",
  "cards": [
    {
      "id": "card-1",
      "title": "Industrial nocturne",
      "prompt": "A severe industrial nocturne with tactile materials and off-axis cinematic light.",
      "negativePrompt": "readable text, logos",
      "tags": ["industrial", "nocturne"]
    },
    {
      "id": "card-2",
      "title": "Glass botany",
      "prompt": "Translucent botanical structures in soft green daylight.",
      "negativePrompt": "hard shadows",
      "tags": ["botanical", "glass"]
    }
  ],
  "ratio": 0.5
}
```

The ratio ranges from 0.1 through 0.9 and assigns that share of influence to the first card. One fresh blender worker returns exactly one coherent child proposal; it never mutates either parent or generates an image. The proposal remains approval-gated until accepted or discarded.

An explicit write-from-set request contains three through five unique generated
favorites with display-safe metadata and immutable normalized source images:

```json
{
  "id": "prompt-card-writer-job-1",
  "kind": "prompt-card-writer",
  "createdAt": "ISO-8601 timestamp",
  "sources": [
    {
      "candidateId": "generated-favorite-1",
      "concept": "Copper observatory",
      "style": ["editorial", "tactile"],
      "sourceImage": {
        "filename": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png",
        "path": "profile-sources/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png",
        "contentType": "image/png",
        "width": 1024,
        "height": 1024,
        "byteLength": 2048
      }
    }
  ]
}
```

The actual request has three through five source objects. One fresh writer
worker inspects every exact image together and returns one coherent proposal
grounded only in shared transferable qualities. It never identifies a person,
copies a source, or generates an image. The proposal remains approval-gated;
acceptance creates a new immutable card with every source candidate ID.

The preference seed is the authoritative creative brief for every worker. Explicit subject, subject-count, medium, style, palette, content-level, and avoidance guidance outranks retained-winner metadata, rejected candidates, selection history, and recent concepts. Those secondary fields may guide novelty only within the seed's constraints; they must never redirect the image proposal to an unrelated subject or metaphor. The monitor must reject or fail a proposal and image that contradict an explicit seed constraint rather than publish it.

New refill jobs include `leaderboardEvidence`, a display-safe sample of at most 12 current reusable candidates. It contains the highest and lowest ranks when the pool is larger than the bound, plus the full pool size; it never contains prompts, image paths, reasoning, or mailbox state. When the cached fingerprint still matches the current leaders, the refill also includes `leaderboardVisualProfile` with the shared visual synthesis, source candidate IDs, reasoning, and analysis timestamp. Rank, Elo, win/loss record, repeated performance, favorites, and the matching visual synthesis are the primary basis for Adaptive steering. High-ranked candidates with repeated success are positive aggregate evidence; repeatedly losing low-ranked candidates are negative aggregate evidence. Omitted middle ranks are neutral, not negative. Recent selections, retained/rejected compatibility fields, and recent concepts are secondary novelty context and may break a tie only when aggregate evidence is sparse.

New jobs include the structured `preferenceProfile`. The freedom slider has three stops. Frozen uses `adaptationMode: "static"`; workers omit `preferenceRevision` and preserve every field exactly. Guided uses `adaptationMode: "adaptive"` with `adaptationStrength: "guided"`; workers emit restrained, incremental full-profile revisions and the app may adopt one after every 15 completed decisions. Unfettered uses `adaptationStrength: "unfettered"`; workers may broadly rewrite the full profile and the app may adopt one after every 5 completed decisions. Legacy jobs without a profile are Frozen, and legacy Adaptive profiles without a strength migrate to Guided. Both adaptive levels remain winner-gated and based primarily on `leaderboardEvidence`; rejection evidence continues accumulating between cadence checkpoints. `adaptationLastDecision` records the last eligible rewrite checkpoint. The profile carries separate bounded source-ID lists for positive and negative provenance.

Tie-triggered refill jobs include `"comparisonOutcome": "tie"`. Their compatibility fields use the lower-rated tied candidate as `retainedWinner` (or the left candidate when ratings are equal) and the other tied candidate as `rejectedCandidate`, but both are neutral preference context. The latest history item is an explicit tie with left/right candidate metadata; it must not be interpreted as positive or negative adaptive evidence.

Dual-rejection refill jobs include `"comparisonOutcome": "both-lose"`. Their compatibility fields still name one candidate as `retainedWinner`, but neither candidate won. Treat both candidates in the latest `both-lose` history item as negative preference evidence, avoid both rejected concepts, and do not carry either candidate's identity or likeness forward.

Refill jobs carry the same preference context plus durable session and pinned-winner ownership:

```json
{
  "id": "refill-job-1",
  "kind": "refill",
  "sessionId": "session-1",
  "pinnedWinnerId": "candidate-id",
  "comparisonOutcome": "tie"
}
```

`pinnedWinnerId` must equal `retainedWinner.id`. `comparisonOutcome` is optional and appears as `tie` or `both-lose`; ordinary refill jobs omit it. Each refill is an independent candidate-generation job and has its own proposal, image, and terminal outcome.

At monitor startup or restart, run `npm run agent:next -- --resume --wait-ms 0 --max-refills <workerLimit>` until it prints no JSON. `workerLimit` is the number of immediately available fresh image-worker subagent slots, capped at 3, that the root supervisor passed to the monitor. The helper prints one unterminated active challenger/initial request or a bounded batch of unterminated active refills when recovery is needed, and claims pending work when none is active. Initial requests include the recovered durable `batchOwnerToken`. Do not use `--resume` in the ordinary polling loop.

`npm run agent:next -- --wait-ms 30000 --max-refills <workerLimit>` prioritizes one pending challenger, initial, or interactive source-profile request, then prompt-card editor, blender, or writer work, then cached leaderboard-profile analysis. When none is claimable, it atomically renames up to the requested number of oldest refill requests from `pending` to `active`. The refill limit must be from 1 through 3 and must not exceed immediately available worker slots. The helper never mixes priority work into a refill batch and emits strict JSON:

```json
{
  "kind": "refill-batch",
  "jobs": [{ "id": "refill-job-1", "kind": "refill" }]
}
```

Every returned refill must immediately receive its own fresh worker. Before claiming the first side of an initial batch, the helper atomically creates one batch ownership record and includes its unguessable `batchOwnerToken` in the printed request. Other ordinary calls skip the owner's pending partner. A wait must be between 0 and 30000 milliseconds. `--max-refills` is not accepted with owned `--batch` inspection.

Both startup recovery and pending claims exclude jobs with a live
persistent-worker lease. Ordinary polling also scans active leased work,
revokes leases whose expiry has passed, and returns those jobs with the same
priority and refill batching rules. Outcome-reserved jobs remain with their
recorded publisher instead of being reassigned mid-publication.

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

The four base proposal fields are always required. `preferenceRevision` must be omitted for Frozen jobs and is required for Guided and Unfettered jobs; it must contain every preference field except adaptation metadata and positive/negative source IDs. Every proposal string, including each `styleTags` entry, is trimmed and must contain at least one non-whitespace character. Revision fields are trimmed model output, themes must contain at least 20 characters, and the same field limits as the UI apply. `reasoningSummary` must explain how the image proposal follows the authoritative preference seed, responds to aggregate numeric and visual leaderboard evidence at the selected freedom level, and stays distinct from recent work. Invalid proposals fail before any outcome, result, or asset is published.

## Completed result

`npm run agent:complete -- --job <id> --proposal-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/proposal.json" --image "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/image.png" [--lease-token <token>]` requires the matching active job. A persistent peer must supply its lease token; mailbox-monitor work is unleased and omits it. The helper rejects inputs over 50 MB or 4096 by 4096 pixels, then uses Sharp to identify and fully decode exactly one square PNG. It reserves the `completed` outcome, hashes the exact PNG bytes with SHA-256, creates `assets/<sha256>.png` and `output/artifacts/<sha256>.png` without overwriting, and atomically publishes:

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

For a source-profile job, write this strict object to `<data-root>/agent-work/<jobId>/profile.json`:

```json
{
  "profile": {
    "themes": "transferable depicted themes of at least 20 characters",
    "inspiration": "composition, lighting, and mood cues",
    "mediaTypes": "depicted or analogous media",
    "visualStyle": "transferable style guidance",
    "colorPalette": "transferable palette guidance",
    "contentLevel": "family-friendly",
    "avoid": "exact identity, likeness, logos, readable text, and exact copying"
  },
  "reasoningSummary": "How the profile supports variations without reproducing identity or exact likeness."
}
```

`npm run agent:complete-profile -- --job <id> --profile-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/profile.json"` requires the matching active profile-analysis job and verifies every referenced normalized source before reserving the outcome. For a source-profile job it publishes the editable draft without saving it to the game:

```json
{
  "jobId": "source-profile-job-1",
  "kind": "source-profile",
  "status": "completed",
  "completedAt": "ISO-8601 timestamp",
  "profile": {
    "themes": "transferable depicted themes of at least 20 characters",
    "inspiration": "composition, lighting, and mood cues",
    "mediaTypes": "depicted or analogous media",
    "visualStyle": "transferable style guidance",
    "colorPalette": "transferable palette guidance",
    "contentLevel": "family-friendly",
    "avoid": "exact identity, likeness, logos, readable text, and exact copying"
  },
  "reasoningSummary": "Transferable analysis only."
}
```

The same `agent:complete-profile` command completes a leaderboard-profile job. It verifies every normalized source and publishes the job's exact fingerprint with the shared profile analysis:

```json
{
  "jobId": "leaderboard-profile-job-1",
  "kind": "leaderboard-profile",
  "status": "completed",
  "completedAt": "ISO-8601 timestamp",
  "fingerprint": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "profile": {
    "themes": "shared transferable themes across the leaders",
    "inspiration": "recurring composition, lighting, and mood cues",
    "mediaTypes": "shared or analogous media",
    "visualStyle": "recurring visual treatment",
    "colorPalette": "shared palette relationships",
    "contentLevel": "family-friendly",
    "avoid": "identity, likeness, readable text, logos, and exact copying"
  },
  "reasoningSummary": "Visible qualities shared across the weighted leaders."
}
```

For a prompt-card editor job, write exactly two proposals to `<data-root>/agent-work/<jobId>/suggestions.json`, then run `npm run agent:complete-card-editor -- --job <id> --suggestions-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/suggestions.json"`. The helper validates the matching active request and publishes:

```json
{
  "jobId": "prompt-card-editor-job-1",
  "kind": "prompt-card-editor",
  "status": "completed",
  "completedAt": "ISO-8601 timestamp",
  "cardId": "card-1",
  "proposals": [
    {
      "title": "Industrial nocturne — focused",
      "prompt": "A focused industrial nocturne with quieter supporting detail and deliberate off-axis light.",
      "negativePrompt": "readable text, logos",
      "tags": ["industrial", "nocturne"],
      "reasoningSummary": "Preserves the source mood while simplifying competing detail."
    },
    {
      "title": "Industrial nocturne — oblique",
      "prompt": "An oblique industrial nocturne with stronger negative space and a restrained tactile palette.",
      "negativePrompt": "readable text, logos",
      "tags": ["industrial", "nocturne"],
      "reasoningSummary": "Changes composition while retaining the original card's intent."
    }
  ]
}
```

For a prompt-card blender job, write exactly one proposal to `<data-root>/agent-work/<jobId>/suggestion.json`, then run `npm run agent:complete-card-blender -- --job <id> --suggestion-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/suggestion.json"`. The helper validates the matching active request and publishes:

```json
{
  "jobId": "prompt-card-blender-job-1",
  "kind": "prompt-card-blender",
  "status": "completed",
  "completedAt": "ISO-8601 timestamp",
  "cardIds": ["card-1", "card-2"],
  "proposal": {
    "title": "Copper glasshouse",
    "prompt": "A copper-lit editorial portrait inside a translucent botanical glasshouse.",
    "negativePrompt": "readable text, logos, hard shadows",
    "tags": ["industrial", "nocturne", "botanical", "glass"],
    "reasoningSummary": "Balances the two immutable source directions at the requested ratio."
  }
}
```

For a prompt-card writer job, write exactly one proposal to
`<data-root>/agent-work/<jobId>/suggestion.json`, then run
`npm run agent:complete-card-writer -- --job <id> --suggestion-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/suggestion.json"`.
The helper preserves the request's exact source lineage and publishes:

```json
{
  "jobId": "prompt-card-writer-job-1",
  "kind": "prompt-card-writer",
  "status": "completed",
  "completedAt": "ISO-8601 timestamp",
  "sourceCandidateIds": [
    "generated-favorite-1",
    "generated-favorite-2",
    "generated-favorite-3"
  ],
  "proposal": {
    "title": "Copper ecology",
    "prompt": "A tactile editorial ecology with copper edge light, generous negative space, and monumental organic forms.",
    "negativePrompt": "exact copies, recognizable identity, readable text, logos",
    "tags": ["editorial", "tactile", "copper", "organic"],
    "reasoningSummary": "Synthesizes shared lighting, scale, and material qualities while remaining distinct from every source."
  }
}
```

## Failed result and heartbeat

Write the reason to `<data-root>/agent-work/<id>/failure.txt`. `npm run agent:fail -- --job <id> --message-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/failure.txt" --category <category> [--lease-token <token>]` requires the matching active job, reserves the `failed` outcome, and atomically publishes a result with `status: "failed"`, an ISO timestamp, the non-empty `message`, `retryable: true`, and its category. Persistent peers supply their lease token; the mailbox monitor omits it after an expired lease has been revoked. Use `moderation` only for a provider safety or moderation block, `invalid-output` for an unusable worker handoff, and `operational` for interruptions or infrastructure failures. The UI surfaces moderation failures so the player can adjust their profile.

Only one outcome reservation can exist for a job. A retry matching that outcome resumes safely and returns an already-published result unchanged. The opposite outcome is rejected. Completion also resumes when its deterministic asset already exists only if the existing bytes exactly equal the validated source; differing bytes are never overwritten.

`npm run agent:heartbeat -- --status <status> [--job <id>]` atomically replaces `heartbeat.json` with the status, optional job ID, and update timestamp. Use `waiting`, `generating`, `analyzing`, and `stopped` coordinator states. The heartbeat does not record the short-lived helper process PID.
