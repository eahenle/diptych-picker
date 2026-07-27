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

| Method  | Path               | Purpose                                                                                                     |
| ------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `GET`   | `/api/game`        | Start or reconcile the game and return its tagged state, buffer health, displayed Elo, and provider header. |
| `PATCH` | `/api/game`        | Save a complete preference profile or legacy composed preference seed.                                      |
| `POST`  | `/api/game/start`  | Start fresh, unless a selection is in flight.                                                               |
| `POST`  | `/api/game/select` | Choose left/right, tie, or both-lose with a stale-round guard.                                              |
| `GET`   | `/api/game/health` | Return current ready, active, waiting, draining, and pool counts.                                           |

`GET /api/game` returns one of:

```json
{ "status": "ready", "game": {}, "bufferHealth": {}, "eloRatings": {} }
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

| Method  | Path                               | Purpose                                                                       |
| ------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| `POST`  | `/api/game/preferences/deck`       | Create an immutable prompt card.                                              |
| `PATCH` | `/api/game/preferences/deck`       | Enable the deck, update card activity/weight, or accept/discard a suggestion. |
| `POST`  | `/api/game/preferences/deck/blend` | Request one approval-gated blend of two distinct cards.                       |
| `POST`  | `/api/game/preferences/deck/write` | Request one approval-gated card from three to five generated favorites.       |

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
