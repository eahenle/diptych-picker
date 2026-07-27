# User guide

## The comparison loop

Each round shows exactly two independent images. Choose the stronger image:

- click A or press `A` / `1`;
- click B or press `B` / `2`;
- choose **Tie** or press `C` / `3` when both are equally useful;
- choose **Both lose** or press `D` / `4` when neither should influence future
  work positively.

A normal win preserves the exact winner—its file, URL, side, and visible image
node do not change—and replaces only the loser. A tie replaces both candidates
without positive or negative preference evidence. Both-lose gives each
candidate a loss, removes both from the reusable pool, and supplies negative
evidence for adaptive generation.

The default champion retires after ten consecutive wins. Change that limit
under **Preferences → Game rules**.

## Queue and fallback

The **Queue** metric reports:

- ready challengers that can be shown immediately;
- jobs actively generating;
- jobs waiting for a worker;
- superseded work draining after a preference change.

Select the metric for the detailed breakdown. A new five-seed game displays two
images and starts with three immediately ready challengers. After the first
comparison provides real preference evidence, background generation restores
the configured queue target, which defaults to five.

If the queue empties, the exact winner remains visible. After the fallback
delay, the game can draw from the reusable local pool. Once the configured
consecutive fallback limit is reached, the losing side waits for generated
capacity instead of cycling indefinitely.

## Scores, pool, and history

Every completed comparison updates Elo with K=32. A candidate's rounded score
appears after its first comparison:

- `✦` marks a first appearance;
- `⊖` means a loss would remove the candidate from the reusable pool.

Select **Pool** to open the Elo-ranked reusable pool. Entries expose display-safe
concept, style, provenance, win/loss, and favorite information; prompts and
mailbox details remain private.

Select **Round** to open up to fifty newest-first decisions. History thumbnails
can be inspected at full size.

## Inspect, favorite, and branch

Open either active image or any image in Pool, History, or Favorites to inspect
its immutable full-size asset.

Mark exceptional candidates as favorites. Favorites remain available even when
their Elo or pool membership changes, and the Favorites gallery is ordered
deterministically by Elo.

Choose **Explore variations** from an inspector to analyze that candidate as
transferable visual guidance. The analysis opens as an editable preference
draft and changes nothing until saved. Generated descendants record the
canonical parent candidate and a fingerprint of the exact saved profile.

## Preference profile

Open **Preferences** to edit:

- themes;
- inspiration;
- media types;
- visual style;
- color palette;
- content range;
- things to avoid.

Themes require at least 20 characters. Saving a materially changed profile
invalidates ready work created for the previous brief, lets already-running
jobs drain safely, and requests replacement capacity with the new brief.

### Freedom levels

- **Frozen** prevents model-authored profile changes.
- **Guided** permits restrained, leaderboard-supported revisions every 15
  completed rounds.
- **Unfettered** permits broad, leaderboard-supported revisions every 5 rounds.

Adaptive revisions remain winner-gated. Aggregate leaderboard evidence—rank,
Elo, repeated outcomes, favorites, and a cached synthesis of the current top
cohort—outweighs any single recent decision.

### Analyze an image

**Analyze image** accepts one PNG, JPEG, or WebP up to 20 MB and 4096×4096. The
private source is normalized under local storage and analyzed for transferable
subject matter, composition, medium, style, palette, and constraints.

The result is an unsaved draft. It does not identify a person or request an
exact likeness. Acknowledge the result after adopting or discarding it so its
mailbox record can be archived.

### Revisions and presets

The revision timeline records confirmed manual saves, variation branches, and
adopted model-authored rewrites. Restore an entry as an editable or Frozen
draft; the game changes only after Save.

Named presets capture the complete draft. Saving the same name replaces the
previous preset case-insensitively. Up to twenty presets are retained.

## Prompt deck

Prompt cards are immutable archetype or style directions that supplement the
main preference profile.

You can:

- create a card with a title, prompt, negative prompt, tags, and positive
  weight;
- enable or disable the deck;
- activate cards and tune positive weights up to 100;
- blend two active cards at a ratio from 0.1 through 0.9;
- write one card from three to five distinct generated favorites.

Weighted draws affect future jobs only. Card-backed winners gain 10% weight,
and card-backed wins and rejections remain attributable.

Four recent rejections of one card can request two repair alternatives. Repair,
blend, and favorite-set writer results are approval-gated suggestions: accept
one to create a new immutable child, or discard it. Source cards and source
images never change.

## Game rules

Under **Preferences → Game rules**, configure the current game:

| Rule                       | Range | Default |
| -------------------------- | ----: | ------: |
| Ready queue target         |  1–10 |       5 |
| Reusable pool capacity     |  2–50 |      50 |
| Champion streak limit      |  2–50 |      10 |
| Consecutive fallback limit |  1–50 |      10 |

Applying rules is separate from saving preferences. Pool reductions trim the
weakest members immediately. Queue growth schedules available refill capacity.
Rules are included in save exports. **New game → Start fresh** restores
environment-configured defaults.

## Save, restore, and start fresh

**Export** downloads the current versioned JSON and publishes the identical
content-addressed file under `output/artifacts/`.

**Load** validates the complete document and every referenced immutable local
asset before replacing state. In-flight job IDs are excluded from exports;
restored games create a fresh session and request missing capacity safely.

**New game** can export first, load a prior save, or start fresh. Starting fresh
clears the current round, history, and preference profile while preserving
learned ratings and immutable images.

## Moderation and operational failures

Moderation blocks are classified separately from infrastructure failures.
Blocked refill capacity is replaced automatically, while a persistent notice
offers **Adjust preferences** or **Dismiss**. Operational failures remain
retryable through durable mailbox recovery.

For backup, restart, and interrupted-job details, see
[Data and recovery](DATA_AND_RECOVERY.md).
