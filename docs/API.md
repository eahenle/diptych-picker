# Local API

The API exists for the local web interface, automation, and debugging. It is
not a remotely authenticated service.

Base URL:

```text
http://127.0.0.1:3000
```

Requests with non-loopback hostnames are rejected. Browser mutations must be
same-origin. Do not expose these endpoints through a tunnel or LAN binding.

Runnable shell clients live under [examples/api](../examples/api/).

## Game lifecycle

| Method  | Path               | Purpose                                                                                                                      |
| ------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET`   | `/api/game`        | Start or reconcile the game and return its tagged state, buffer health, displayed Elo, import progress, and provider header. |
| `PATCH` | `/api/game`        | Save a complete preference profile or legacy composed preference seed.                                                       |
| `GET`   | `/api/game/start`  | Read whether a game can be resumed and whether an image-pool import is unfinished, without creating or reconciling state.    |
| `POST`  | `/api/game/start`  | Start fresh, unless a selection is in flight.                                                                                |
| `POST`  | `/api/game/select` | Choose left/right, tie, or both-lose with a stale-round guard.                                                               |
| `GET`   | `/api/game/health` | Return current ready, active, waiting, draining, and pool counts.                                                            |

`GET /api/game` returns one of:

```json
{
  "status": "ready",
  "game": {},
  "bufferHealth": {},
  "eloRatings": {},
  "importProgress": null
}
```

```json
{ "status": "initializing", "batchId": "...", "preferenceSeed": "..." }
```

```json
{
  "status": "initialization-error",
  "batchId": "...",
  "preferenceSeed": "...",
  "errorMessage": "..."
}
```

The response header identifies the active provider:

```text
X-Diptych-Generation-Provider: agent
```

### Make a comparison

Winner:

```json
{ "winnerSide": "left", "roundNumber": 12 }
```

Neutral tie:

```json
{ "outcome": "tie", "roundNumber": 12 }
```

Reject both:

```json
{ "outcome": "both-lose", "roundNumber": 12 }
```

The server returns `200` when the next comparison is immediately ready, `202`
while capacity is pending, `409` for a stale or conflicting selection, and
`404` before a game exists. Use
[select.sh](../examples/api/select.sh) to read the current round and send one
guarded choice.

## Imported challenger pool

| Method   | Path                              | Purpose                                                                   |
| -------- | --------------------------------- | ------------------------------------------------------------------------- |
| `POST`   | `/api/game/import`                | Create a new import or resume the one non-completed session.              |
| `GET`    | `/api/game/import?sessionId=...`  | Reconcile and return display-safe annotation, fill, and activation state. |
| `PATCH`  | `/api/game/import`                | Pause a sealed import or retry one failed initial-fill attempt.           |
| `DELETE` | `/api/game/import`                | Abandon a non-activated import.                                           |
| `POST`   | `/api/game/import/items`          | Upload one approved normalized PNG as multipart `image`.                  |
| `PATCH`  | `/api/game/import/items/<itemId>` | Retry, manually annotate, or remove one imported item.                    |
| `POST`   | `/api/game/import/seal`           | Seal browser input and begin starter preparation.                         |

Creation and polling return a display-safe shape:

```json
{
  "sessionId": "...",
  "status": "preparing",
  "sealedAt": "2026-08-10T12:00:00.000Z",
  "activatedAt": null,
  "activationTarget": 5,
  "activationReady": 3,
  "counts": {
    "total": 4,
    "annotating": 1,
    "ready": 3,
    "failed": 0,
    "removed": 0,
    "served": 0
  },
  "items": [],
  "initialFill": {
    "pending": 0,
    "ready": 0,
    "failed": 0,
    "failedAttemptId": null,
    "failureMessage": null
  }
}
```

The item upload accepts only a complete 1024×1024 `image/png` produced by the
browser editor plus a `sessionId` form field. Original PNG, JPEG, and WebP files
are never sent to this endpoint. Equal normalized digests return `409` and keep
the browser input unresolved.

Item actions are strict discriminated JSON bodies:

```json
{ "action": "retry", "sessionId": "..." }
```

```json
{
  "action": "manual",
  "sessionId": "...",
  "concept": "Violet atrium",
  "prompt": "A geometric atrium under diagonal violet window light",
  "style": ["editorial", "geometric"]
}
```

```json
{ "action": "remove", "sessionId": "..." }
```

Initial-fill retry requires the failed attempt ID and a stable client request
ID. Repeating the exact request is idempotent; a stale attempt returns `409`,
after which the client must refresh rather than retry a newer attempt silently.

```json
{
  "action": "retry-initial-fill",
  "sessionId": "...",
  "failedAttemptId": "...",
  "requestId": "..."
}
```

## Rules and public read models

| Method   | Path                    | Purpose                                                                   |
| -------- | ----------------------- | ------------------------------------------------------------------------- |
| `GET`    | `/api/game/rules`       | Return the current complete rule snapshot.                                |
| `PATCH`  | `/api/game/rules`       | Replace all four bounded rules atomically.                                |
| `GET`    | `/api/game/leaderboard` | Display-safe reusable pool ranked by Elo.                                 |
| `GET`    | `/api/game/history`     | Up to fifty newest-first comparison decisions.                            |
| `GET`    | `/api/game/favorites`   | Display-safe favorites ranked by Elo, including entries outside the pool. |
| `PUT`    | `/api/game/favorites`   | Set one known candidate's favorite flag.                                  |
| `DELETE` | `/api/game/notice`      | Dismiss the current generation notice.                                    |

Rule update:

```json
{
  "bufferTarget": 5,
  "poolMaximum": 50,
  "championRetirementStreak": 10,
  "fallbackMaximumConsecutive": 10
}
```

Favorite update:

```json
{ "candidateId": "candidate-id", "favorite": true }
```

Leaderboard, history, and favorites responses omit generation prompts and
mailbox contents and use `Cache-Control: no-store`.

## Preferences

### Save a profile

`PATCH /api/game` accepts a complete strict profile:

```json
{
  "preferenceProfile": {
    "themes": "Engineered nocturnal scenes with unfamiliar ecosystems",
    "inspiration": "Pacific Northwest field research and fabrication",
    "mediaTypes": "gouache, macro photography",
    "visualStyle": "precise, tactile, quietly uncanny",
    "colorPalette": "ultraviolet, copper, oxblood, cinematic blue",
    "contentLevel": "family-friendly",
    "avoid": "readable text, logos, split compositions",
    "adaptationMode": "adaptive",
    "adaptationStrength": "guided",
    "adaptationLastDecision": 0,
    "adaptationSourceWinnerIds": [],
    "adaptationSourceRejectedIds": []
  }
}
```

Themes must contain at least 20 non-whitespace characters. The server accepts
an optional `expectedPreferenceProfile` for optimistic concurrency and an
optional nullable `variationSourceCandidateId`.

### Analyze a source image

| Method   | Path                                     | Purpose                                                  |
| -------- | ---------------------------------------- | -------------------------------------------------------- |
| `POST`   | `/api/game/preferences/source`           | Upload one `image` form part and create an analysis job. |
| `GET`    | `/api/game/preferences/source?jobId=...` | Poll an analysis job.                                    |
| `DELETE` | `/api/game/preferences/source?jobId=...` | Acknowledge and archive its terminal record.             |

Accepted formats are PNG, JPEG, and WebP, up to 20 MB and 4096×4096. Creation
and in-progress polling return `202`. The result is a draft and is not saved
automatically. See
[source-profile.sh](../examples/api/source-profile.sh).

### Presets

| Method   | Path                            | Body                                    |
| -------- | ------------------------------- | --------------------------------------- |
| `POST`   | `/api/game/preferences/presets` | `{ "name": "...", "profile": { ... } }` |
| `DELETE` | `/api/game/preferences/presets` | `{ "presetId": "..." }`                 |

Names are 1–50 characters. The game retains at most twenty presets.

## Prompt deck

| Method  | Path                                      | Purpose                                                                             |
| ------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `POST`  | `/api/game/preferences/deck`              | Create an immutable prompt card.                                                    |
| `PATCH` | `/api/game/preferences/deck`              | Enable the deck, update card activity/weight, or accept/discard a suggestion.       |
| `POST`  | `/api/game/preferences/deck/blend`        | Request one approval-gated blend of two distinct cards.                             |
| `POST`  | `/api/game/preferences/deck/write`        | Request one approval-gated card from three to five generated favorites.             |
| `POST`  | `/api/game/preferences/deck/write/custom` | Request one approval-gated card from text, up to five private seed images, or both. |

The custom writer endpoint accepts `multipart/form-data` with an optional
`guidance` field (maximum 2,000 trimmed characters) and zero through five
`images` fields. At least one input is required. Each image must be PNG, JPEG,
or WebP, at most 20 MB, and no larger than 4096 by 4096 pixels.

Create a card:

```json
{
  "title": "Monumental fabrication",
  "prompt": "Skilled adults building one improbable machine at architectural scale",
  "negativePrompt": "logos, readable text, split panels",
  "weight": 1,
  "tags": ["fabrication", "monumental"]
}
```

Card updates use a discriminated `kind`:

```json
{ "kind": "deck", "enabled": true }
```

```json
{ "kind": "card", "cardId": "...", "active": true, "weight": 2 }
```

```json
{ "kind": "suggestion", "suggestionId": "...", "action": "accept" }
```

Blend:

```json
{ "cardIds": ["first-id", "second-id"], "ratio": 0.5 }
```

Write from favorites:

```json
{ "candidateIds": ["first-id", "second-id", "third-id"] }
```

## Saves and assets

| Method | Path                       | Purpose                                               |
| ------ | -------------------------- | ----------------------------------------------------- |
| `GET`  | `/api/game/snapshot`       | Download and publish the current versioned JSON save. |
| `PUT`  | `/api/game/snapshot`       | Validate and restore a JSON save.                     |
| `GET`  | `/api/assets/<sha256>.png` | Serve a verified immutable generated image.           |

Export responses include:

```text
Content-Disposition: attachment; filename="<sha256>.json"
X-Diptych-Export-Path: output/artifacts/<sha256>.json
Cache-Control: no-store
```

Save uploads are limited to 25 MB. Restore can return `400` for invalid data,
`409` while the current game is not stable, or `413` for an oversized file.

Use [export-save.sh](../examples/api/export-save.sh) and
[restore-save.sh](../examples/api/restore-save.sh).

## Error shape

Expected client errors use:

```json
{ "error": "Actionable message" }
```

Do not automate by matching the exact prose. Use the HTTP status and documented
response fields.
