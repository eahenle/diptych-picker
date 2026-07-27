# v1.0 feature scenarios

These cases are written for a clean offline demo unless they explicitly require
agent mode. Each ID matches exactly one row in
[the feature matrix](../docs/FEATURE_MATRIX.md).

## DP-001 — Deterministic offline demo

Run `npm ci && npm run demo`, open <http://127.0.0.1:3000>, and confirm two
images appear without starting Codex. Restart with the same
`DIPTYCH_DEMO_DATA_DIR`; the current round should persist.

## DP-002 — Agent-backed local generation

Run `npm run codex:play`, wait for readiness, then run
`examples/api/status.sh`. Confirm the provider is `agent`. Make one choice and
confirm the Queue eventually returns to its configured target through newly
generated challengers.

## DP-003 — Exact-winner A/B selection

Record both image URLs, select A, and confirm A keeps the same URL and side
while only B changes. Repeat with B and confirm the invariant reverses.

## DP-004 — Neutral tie

Press `C` or `3`. Confirm both images change, the history records a tie, and
neither candidate receives positive or negative preference treatment from that
decision.

## DP-005 — Both-lose rejection

Press `D` or `4`. Confirm both images change, both receive a loss without an Elo
change, and neither remains in the reusable pool.

## DP-006 — FIFO challenger queue and refill

Open Queue and note the ready order. Select one winner several times. Confirm
each losing side receives the former FIFO head and that generation adds
capacity at the tail rather than replacing stale-but-valid ready work.

## DP-007 — Depleted-buffer fallback

Use the isolated test configuration with a short fallback delay, empty the
ready queue, and select a winner. Confirm the winner stays visible while the
loser waits, then a reusable-pool candidate appears. After the configured limit,
confirm another pool draw is blocked until generated work arrives.

## DP-008 — Champion retirement

Set the champion streak limit to 2. Choose the same side twice. Confirm the
two-win champion retires and the next comparison contains two different
candidates.

## DP-009 — Elo-ranked reusable pool

Complete several comparisons, select Pool, and confirm entries are ordered by
descending Elo with win/loss and curated/generated provenance. Confirm no
generation prompt appears in the dialog or API response.

## DP-010 — Comparison history

Complete a win, tie, and both-lose decision. Select the Round metric. Confirm
newest-first ordering, outcome labels, display-safe thumbnails, and the complete
decision count.

## DP-011 — Full-size immutable inspection

Open image B, note its URL, close the inspector, and reopen the same candidate
from Pool or History. Confirm the inspector uses the identical immutable URL
and closes with Escape.

## DP-012 — Durable favorites gallery

Favorite a candidate from an inspector, open Favorites, refresh the page, and
confirm it remains. Remove that candidate from the reusable pool through play;
confirm it still appears in Favorites until explicitly unfavorited.

## DP-013 — Candidate-derived variations and lineage

Choose Explore variations on a generated candidate. Review the analyzed draft,
save it, and select through future generated work. Export the game and confirm a
descendant records the canonical parent ID and preference fingerprint.

## DP-014 — Fine-grained preference profile

Open Preferences and enter distinct themes, media, style, palette, content
range, and avoidance guidance. Save and confirm the composed brief changes and
old-profile ready work is replaced while already-running work drains.

## DP-015 — Frozen, Guided, and Unfettered adaptation

Save one profile at each freedom level. Frozen should never adopt a worker
revision. Guided should show a 15-round cadence and permit restrained changes.
Unfettered should show a 5-round cadence and permit broad changes only after an
eligible winning generated result.

## DP-016 — Private source-image analysis

Run `examples/api/source-profile.sh path/to/source.png` in agent mode, or use
Analyze image in Preferences. Confirm the result is an editable unsaved draft,
does not identify a person, and leaves the normalized image under the private
local data directory.

## DP-017 — Preference revisions and named presets

Save two materially different profiles. Open the revision timeline, restore the
first as a draft, and confirm the live game does not change before Save. Name
the draft, change it, apply the preset, and confirm application is also
draft-only.

## DP-018 — Weighted immutable prompt deck

Create two prompt cards, enable the deck, and set weights 1 and 3. Confirm
future card-backed jobs cite only existing active card IDs and that changing a
weight does not edit the immutable card text.

## DP-019 — Approval-gated prompt-card repair

Accumulate four recent rejections for one card. Confirm two repair suggestions
arrive without changing the source card. Discard one and accept the other;
confirm acceptance creates a new active immutable child.

## DP-020 — Model-assisted two-card blending

Select two active cards, request a 50/50 blend, and wait for its suggestion.
Confirm neither parent changes. Accept the proposal and confirm the new active
card records both parent IDs.

## DP-021 — Prompt card from generated favorites

Favorite three distinct generated candidates, select them in Favorites, and
request a card. Curated seeds should be ineligible. Confirm the review-only
proposal records every source candidate ID when accepted.

## DP-022 — Inspectable queue health

Open Queue while three refills are pending and workers are available. Confirm
ready, active, waiting, and draining counts add up consistently and never exceed
the configured ready-plus-in-flight target.

## DP-023 — Moderation notice and recovery

In a controlled test, return a moderation-classified refill failure. Confirm
the app schedules replacement capacity, keeps play available, and shows a
persistent notice with Adjust preferences and Dismiss actions.

## DP-024 — Editable per-game rules

Run `examples/api/set-rules.sh 3 12 4 2` or use Preferences. Reload and confirm
all four values persist. Start fresh and confirm environment defaults return.

## DP-025 — Versioned export and restore

Make a decision, favorite a candidate, and run
`examples/api/export-save.sh /tmp/diptych-save.json`. Play another round, then
run `examples/api/restore-save.sh /tmp/diptych-save.json`. Confirm the earlier
round, favorite, rules, and pool state return.

## DP-026 — Fresh-session reset with learned pool retention

After generated candidates have ratings, choose New game → Start fresh. Confirm
round number, history, preferences, rules, and prompt deck reset while eligible
learned candidates and their ratings remain available.

## DP-027 — Keyboard, responsive layout, and duplicate-click guard

Use `A`, `B`, `C`, and `D` for four decisions. Resize to 390×844 and confirm the
cards stack without horizontal overflow. Double-click one card and confirm only
one selection request and one round advance occur.

## DP-028 — Optional generated initial pair

Copy
`examples/configurations/generated-initial-pair.env.example` to an isolated
environment, start agent mode, and confirm the browser shows initialization
without seed images. Both initial jobs must complete before round 1 appears.

## DP-029 — Durable mailbox and crash recovery

Start a generated refill, stop the CLI after its durable claim, and leave
`.local-data` intact. Run `npm run codex:play` again. Confirm the existing job is
resumed or reconciled and no duplicate candidate is published.

## DP-030 — Experimental acknowledged co-proc transport

Configure three valid channels from
`examples/configurations/co-proc.env.example`. Enqueue three refills and confirm
distinct ready channels receive correlated jobs. Stop a peer until its lease
expires; confirm the ordinary monitor recovers that job without restarting the
app.

## DP-031 — Curated plus learned local pool

Start fresh and confirm five curated candidates are rated at 1000. Complete
comparisons with generated candidates and confirm eligible generated entries
join the same bounded pool. Lower pool capacity and confirm only the strongest
members remain.

## DP-032 — Content-addressed assets and exports

Generate one candidate and export one save. Compute SHA-256 for each file and
confirm its filename matches the digest under `.local-data/assets/` or
`output/artifacts/`. Repeated publication of identical bytes must reuse the same
path without overwriting different content.
