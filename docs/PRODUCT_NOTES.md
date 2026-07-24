# Product Notes

## Agreed next directions

These directions are recorded as the current product sequence. Checked items
have shipped and are detailed below; unchecked items remain subject to the
normal implementation and play-testing loop.

1. [x] Make Queue inspectable so the compact count clearly separates ready images,
       jobs actively generating, jobs waiting for a worker, and superseded work
       draining after a preference change. Keep the endpoint aggregate-only.
2. [x] Add **Explore variations** from active candidates, leaderboard entries,
       history, and favorites. Reuse the private source-image analysis pipeline to
       extract transferable visual themes, then preserve parent and profile lineage
       for every resulting branch.
3. [x] Add an attributable preference-revision timeline with field-level diffs,
       rollback, freeze, and save-as-preset controls.
4. [x] Ship the staged weighted prompt deck with attributable verdicts,
       immutable lineage, and approval-gated repair suggestions.
5. [x] Add model-assisted two-card blending that reuses the deck's durable,
       approval-gated suggestion machinery and records both immutable parents.
6. [x] Write prompt cards from sets of three to five generated favorites,
       keeping the images immutable, the proposal approval-gated, and accepted
       card lineage attributable to every source candidate.
7. [ ] Continue the persistent `co-proc` transport design in
       [Co-proc agent transport and prompt deck](CO_PROC_DECK_DESIGN.md), keeping
       durable mailbox operation as the fallback during migration.
8. [ ] After those foundations, consider tournament play.
       The dedicated favorites gallery has shipped. Broad refactoring should
       follow feature boundaries instead of preceding them.

Compatibility remains the default: a moderate, non-blocking advisory alone is
not sufficient reason to introduce a breaking save, API, or workflow change.
Prefer additive validation and migration-safe hardening unless a higher-severity
risk justifies a deliberate compatibility break.

## 2026-07-24

### Editable per-game rules

Preferences now exposes bounded numeric controls for the ready queue target,
reusable pool capacity, champion retirement streak, and consecutive fallback
draw limit. Applying the editor persists one complete rules snapshot for the
current game without saving unrelated profile drafts. Pool reductions retain
the strongest members, queue growth requests safe refill capacity when a
comparison context is available, and future selections read the new retirement
and fallback limits immediately. Rules travel with saved-game exports; legacy
games use environment-backed defaults, and starting fresh restores those
defaults.

### Prompt-card reconciliation boundary

Prompt-card editor, blender, and favorite-set writer jobs now reconcile through
one focused server coordinator instead of three parallel implementations inside
`GameService`. The extraction preserves durable intent validation, missing-work
re-enqueue, mismatched-work archival, editor checkpoint restoration, bounded
suggestion ordering, and the immediate editor check after a comparison records
new rejection evidence. API behavior, persistence shape, mailbox protocol, and
approval gates are unchanged.

### Prompt cards from favorite image sets

The Favorites gallery lets the player select three to five generated favorites
and request a model-authored card that captures their shared transferable
composition, mood, medium, palette, and visual style. Curated seeds and private
source uploads are ineligible. The app normalizes each selected candidate into
a content-addressed, read-only source, records the exact source IDs in durable
job intent, and rejects reordered or mismatched results during reconciliation.
The returned card remains a suggestion until accepted or discarded in
Preferences. Acceptance creates a new immutable card with all source candidate
IDs preserved; it never modifies or replaces the selected images. Save export
omits an in-flight writer job, and loading another save archives the current
writer work before state changes.

### Correlated persistent-channel results

After a leased persistent worker durably completes or fails a job through the
existing token-gated helper, it can now send a strict version-2 `result` frame
with the same lease token, terminal status, and exact normalized mailbox result
path. The channel rejects mismatched tokens, job IDs, status directories, and
paths. The mailbox adapter eagerly reads and caches the result through the same
strict durable parser, so normal game reconciliation sees it immediately.
Missing, malformed, or interrupted live signals fall back to immutable mailbox
results, which remain authoritative across app and worker restarts.

### Durable persistent-worker leases

The opt-in co-proc generation frame now carries a one-use lease token, durable
lease path, and bounded renewal duration. A persistent peer must atomically
move the pending job to active and create its owner-only lease before
acknowledging delivery. Renewals and terminal completion or failure require the
same token; exclusive outcome reservations retain that owner across an
idempotent retry. The mailbox monitor skips live leases, revokes expired leases
under a per-job filesystem lock, and resumes them during ordinary polling
without requiring a restart. Immutable completed/failed files and app
reconciliation remain authoritative.

## 2026-07-23

### Acknowledged persistent-channel dispatch

The opt-in `co-proc` generation adapter now accepts a comma-separated pool of
persistent named channels. It reserves distinct channels for concurrent
enqueues, waits for explicit readiness, sends only an absolute durable job
reference, and requires a matching acknowledgement. Busy or unavailable peers
can be skipped before dispatch, while an unacknowledged frame is never retried
to a second live peer because that could duplicate work. The filesystem mailbox
is still written first and remains the authority for claim, completion,
failure, and restart recovery. Moving those ownership boundaries onto the live
transport remains an unchecked roadmap step pending end-to-end parity.

## 2026-07-22

### Dedicated favorites gallery

The header's Favorites control opens every favorited candidate in deterministic
Elo order, including durable rated images that have left the reusable pool.
Cards expose display-safe concept, style, record, provenance, and pool status
without prompts or mailbox details. Each favorite can be inspected in the
shared full-size navigator, removed in place, or used to start the existing
approval-gated Explore variations flow.

### GameScreen boundary extractions

The first behavior-neutral `GameScreen` decomposition moves snapshot export,
saved-game import, and explicit new-game orchestration into a dedicated
`useGameTransfer` controller. Shared JSON-response and image-preload helpers now
sit outside the main component as well. The existing modal, snapshot endpoints,
selection lock, preload-before-commit behavior, and user-facing errors remain
unchanged; the extraction creates a smaller feature boundary for future transfer
work without coupling it to comparison-loop changes.

Candidate browsing now has the same boundary: comparison-history loading,
pool-leaderboard loading, favorite updates, image-inspector navigation, and
modal return behavior live in `useCandidateBrowser`. Active-candidate,
leaderboard, and history inspection retain their existing navigation and
variation-analysis behavior while the main screen no longer owns their API and
modal state directly.

The preference boundary is proceeding in smaller cohesive steps. Prompt-card
creation, deck/card/suggestion updates, and two-card blend requests now live in
`usePromptDeck`; durable preset save/delete operations live in
`usePreferencePresets`; and draft field edits, freedom changes, analyzed-profile
adoption, preset application, and revision restoration live in
`usePreferenceDraft`. The Preferences modal keeps the same callbacks and
approval-gated behavior while `GameScreen` no longer owns those transport and
state-transition details.

Comparison submission and recovery now live in `useSelectionController`. The
controller owns the single-selection lock, optimistic winner/tie/both-lose
transitions, challenger polling, reconnect backoff, asset preloading, pending
selection recovery, and explicit retry reconciliation. `GameScreen` retains the
rendered comparison and keyboard wiring while its core orchestration drops to a
smaller feature-facing surface.

Initial game loading, initialization polling, aggregate queue-health refreshes,
prompt-card background-job refreshes, and initial-generation retry now live in
`useGameSessionPolling`. This keeps reconnect timing and best-effort health
behavior together while leaving durable state commits explicit at the screen
boundary.

The remaining modal-level preference orchestration now lives in
`usePreferenceEditor`: explicit and queued saves, source-image analysis and job
acknowledgement, candidate-derived variation setup, preset application, revision
restoration, and prompt-deck/preset controller composition. The screen provides
the current durable game and renders the modal, while the controller owns its
workflow state and cleanup.

The first `GameService` extraction moves candidate rating creation, normal
selection Elo updates, asymmetric tie scoring, dual-rejection recording,
reference-side choice, and durable comparison receipts into
`game-comparison.ts`. The service retains lock ordering and persistence while
the comparison rules become a focused domain boundary shared by immediate and
recovered selections.

Refill planning now has the same boundary in `game-refill.ts`: retained/rejected
context recovery, bounded capacity calculation, weighted-card job construction,
leaderboard evidence attachment, durable work validation, and record removal
are isolated from mailbox I/O. `GameService` still decides when to persist and
enqueue each plan, preserving its existing recovery order.

Dependency maintenance is now explicit rather than incidental. The committed
lockfile remains the reproducible install authority; discovery-range upgrades
occur only in isolated maintenance changes with coupled-framework review, the
full validation matrix, and merge-level rollback described in
`docs/DEPENDENCY_POLICY.md`.

## 2026-07-21

### Inspectable generation queue

The Queue metric opens an aggregate-only status view that distinguishes ready
images, jobs actively generating, and jobs still waiting for a worker. Its copy
explicitly explains that the compact `+N` is occupied queue capacity rather than
worker concurrency. When preferences change while work is active, the view also
reports old-profile jobs that are safely draining before replacement capacity
opens. Prompts, job identifiers, and mailbox paths remain private.

### Candidate-derived variation setup

Every expanded candidate view now offers **Explore variations**. Because active,
leaderboard, history, and favorited candidates share that inspector, the action
works consistently from each surface. It privately reuses source-image
normalization and analysis to populate an editable preference draft from the
candidate's transferable themes, composition, medium, style, and palette; it
does not save the profile automatically. Saving records the canonical source
candidate on the game and on each resulting generation request. Generated
candidates preserve the parent's ID and concept plus a SHA-256 fingerprint of
the exact composed preference profile that produced them; the expanded view
surfaces the parent concept without exposing prompt text.

### Preference revision history

Confirmed manual saves, candidate-derived variation profiles, and actual
model-authored field rewrites append to a bounded, durable profile timeline. The
first change also captures its preceding baseline, while provenance-only
evidence updates do not create noisy revisions. The Preferences modal shows
newest-first origin, time, changed fields, and variation source where relevant.
A revision can be restored as an editable draft or as a Frozen draft; neither
action changes the game until **Save profile** is confirmed.

### Named preference presets

The Preferences modal can save its current draft under a name without applying
it to the game. Presets are durable in the game and its exported snapshot,
bounded to twenty entries, and a case-insensitive matching name replaces the
older value. Applying a preset only updates the editable draft and clears any
candidate-specific variation lineage; **Save profile** remains the explicit
commit point. Session-specific adaptation evidence and checkpoint counters are
reset so a reused preset begins cleanly in the current game. Deleting a preset
does not alter the active profile or its revision history. The saved shape is
optional so existing games remain valid.

### Comprehensive codebase hardening

The post-feature review is recorded in
[Codebase Review — 2026-07-21](CODEBASE_REVIEW_2026-07-21.md). Its first
non-breaking pass centralizes preference validation across API, mailbox, and
storage boundaries; adds schema-compatibility and launcher-contract tests; and
extends CI to cover a production build plus all Chromium game flows. Larger
`GameScreen` and `GameService` decompositions remain explicitly staged as
behavior-neutral follow-ups rather than being mixed into feature changes.

### Weighted prompt-card deck

The Preferences modal owns an additive prompt-card deck. Cards are immutable
creative directions with optional negatives, tags, active state, and a positive
weight; archiving or changing weight does not rewrite their authored content.
When enabled, each future refill job draws one active card proportionally to its
weight while the explicit preference profile remains authoritative. Generated
candidates retain their card ID, and expanded image inspection resolves the
card title. A selected card-backed candidate multiplies its card weight by 1.1;
wins, rejections, and bounded attributable verdicts persist in the exported
game. Ties are neutral, while **Both lose** records both card-backed candidates
as rejected. Existing games and deck-free jobs continue through the prior
freeform path unchanged. When an active card accumulates four new rejects and
at least four remain in the latest twelve deck verdicts, the app automatically
requests two editor alternatives. The original card stays immutable; each
proposal remains approval-gated until the player accepts it as a new child card
or discards it. The player can also select any two active cards and request a
balanced model-assisted blend. That durable non-image job receives only the two
immutable card snapshots and their influence ratio, returns one reviewable
proposal, and creates a child carrying both parent IDs only after acceptance.
The Favorites gallery similarly accepts three to five generated favorites for
a dedicated writer job. It receives normalized immutable source images, returns
one reviewable proposal, and records every source candidate ID only when the
player accepts the card.

## 2026-07-20

### Large image inspection

Each active candidate has a magnifying-glass control that opens its immutable image in a larger, contained modal without selecting either side or changing generation state. The view identifies the candidate, closes from its dedicated control, backdrop, or `Escape`, and suppresses gameplay shortcuts while open.

### Tie decisions

The comparison screen exposes **Declare tie**, mapped to `C` and `3`. A tie clears both active candidates and records a neutral history decision. When Elo scores differ, only the lower-rated candidate gains the score it would have received for a win; the higher-rated candidate is unchanged. Equal scores do not change. Tie decisions do not alter win/loss counts or supply positive or negative adaptive-preference evidence, and tie-triggered refill work carries an explicit neutral outcome marker.

### Both-lose decisions

The comparison screen exposes **Both lose**, mapped to `D` and `4`. This is a true dual rejection: each active candidate receives one loss, neither Elo score changes because no relative winner was chosen, and both candidates are removed from the reusable pool. Generated candidates become negative adaptive-preference evidence. Both cards remain visible while a complete fresh pair is prepared, and depleted queues use the same paced, distinct pool fallback as ties.

### Score-state cues

The lower-left score overlay shows rounded Elo for established candidates, `✦` for a first appearance, and `⊖` when simulating a loss with the current opponent would remove that candidate from the reusable pool. First appearance takes precedence. Each symbol has a plain-language tooltip and is included in the card's accessible name.

### Comparison history

The Round metric opens a newest-first timeline of prior decisions. Each row resolves display-safe winner and rejected-candidate thumbnails, concepts, and concise style tags from the durable rating catalog without exposing prompts. Available thumbnails open the same full-size image inspector as active and leaderboard images. The first iteration shows up to fifty decisions and retains a total count.

History and pool rows let the player favorite exceptional candidates. Favorite state belongs to the durable rating catalog, is shared across both views, survives new games and save-file round trips, and remains independent of Elo and reusable-pool membership. Candidate-derived variation branches now retain direct parent and profile-fingerprint lineage; a richer branching gallery remains a separate follow-up.

### Profile-wide adaptation

The Preference profile title row exposes a three-stop freedom slider for the entire profile. **Frozen** is the default and prevents model mutation of every field. **Guided** permits restrained, incremental full-profile revisions after every 15 completed rounds. **Unfettered** permits broad full-profile revisions after every 5 rounds. A visible cadence meter counts completed rounds since the last checkpoint and, when ready, explains that the next winning generated candidate may update the profile. Both adaptive levels remain winner-gated. Separate bounded winner and rejected-generated-candidate source lists preserve which comparison outcome supplied each signal, and rejection evidence continues accumulating between rewrite checkpoints. Future workers receive those lists plus recent comparison history and must treat winners as positive evidence and generated losers as negative evidence when authoring the next revision. Provenance-only updates do not flush already-buffered work, while a model-authored field revision still invalidates earlier-profile capacity and composes future jobs from the revised fields. Generation failures, cancellations, moderation blocks, and invalid worker output remain operational outcomes and do not influence taste preferences.

### Moderation feedback

Mailbox failures carry an explicit operational, moderation, or invalid-output category. A moderation-blocked background refill is replaced normally but also creates a persistent, non-blocking notice in the game. The notice counts repeated blocks and lets the player dismiss it or open Preferences to steer future generations toward allowed content. Saving a profile clears the notice.

### Queued preference saves

**Save profile** remains actionable while the active round waits for a challenger. Clicking it captures and locks the edited profile, displays animated queued/saving feedback inside the modal, and applies the profile automatically after the round settles. The queued edit deliberately supersedes an adaptive revision from that in-flight round while exact-profile conflict protection still rejects unrelated concurrent edits.

### Source-image profile ingestion

The Preference profile modal accepts one private PNG, JPEG, or WebP source image up to 20 MB and 4096 by 4096 pixels. The server fully decodes it, strips metadata by normalizing it to a content-addressed local PNG, and sends a durable source-profile job to a fresh analysis worker. The worker returns transferable subject, setting, composition, medium, style, palette, content-range, and avoidance guidance without identifying a depicted person or requesting identity, likeness, or exact reproduction. Analysis animates in the modal, preserves the selected freedom level, clears stale adaptation provenance, resets its rewrite checkpoint, and populates an editable draft that is never saved automatically. Source uploads remain private and are not copied into candidate assets or exports.

### Leaderboard-driven preference adaptation

Reusable-pool leaderboard performance is the durable basis for automatic preference steering. Every refill job carries a display-safe sample of at most 12 leaders and trailers with rank, Elo, win/loss record, provenance, favorite status, concept, and concise style tags; prompts, image paths, reasoning, and mailbox state remain private. Adaptive games also reuse the source-image normalization and strict profile-analysis pipeline to inspect the current top four pool images together. A content-addressed digest is cached by ordered leader IDs, refreshed only when that cohort or rank order changes, and included in later refill jobs while its fingerprint remains current. It supplies shared composition, lighting, scale, medium, style, and palette evidence without modifying sources or directly overwriting user-entered preferences. Aggregate rank, repeated performance, and the matching visual synthesis outweigh recent decisions. Recent comparisons remain short-term novelty context or a tie-breaker only when leaderboard evidence is sparse, and omitted middle ranks are neutral rather than negative.

## 2026-07-19

### Comparison-loop follow-ups

- Export remains responsive while a challenger is loading by saving the last stable comparison and its matching pre-selection ratings, queue, pool membership, and pacing state without mutating live generation.
- A champion reaching a ten-win streak should retire from the active comparison and be replaced. This is distinct from the depleted-buffer allowance of ten pool draws.

### Pool leaderboard

The Pool metric opens a display-safe leaderboard of current reusable candidates ranked by Elo. Each row includes its thumbnail, concept, concise style tags, win–loss record, and curated/generated provenance without exposing prompts or mailbox state.

### Deck-driven generation and agent transport

Replace freeform generation as the primary interaction with a weighted deck of concise archetype and style cards. The Next.js app remains the proposed authority for deck state, verdicts, lineage, and learned preferences; `co-proc` supplies the live agent-control transport after it gains attachable cross-process endpoints.

The detailed handoff, protocol, safety constraints, and staged migration are in [Co-proc agent transport and prompt deck](CO_PROC_DECK_DESIGN.md).

### Winner-driven inspiration

Eventually derive editable inspiration signals from winning generated images. Learn transferable attributes such as lighting, composition, palette, mood, medium, and concept—not a person's identity or likeness. Keep this inferred inspiration profile separate from explicit card weights and verdict edits, show which winners influenced it, and let the player weaken, edit, reset, or disable it.

Place a **Frozen / Guided / Unfettered** freedom slider on the top line of the Preference profile modal and apply it to every preference field. Frozen is the default and preserves the profile as entered. Guided permits restrained revisions every 15 rounds; Unfettered permits broad revisions every 5 rounds. Revisions remain attributable to the influencing winners.

## 2026-07-17

### Responsive comparison panels

When the window is too narrow for two useful side-by-side panels, the comparison should adapt instead of requiring horizontal scrolling. Prefer scaling while both images remain comfortably legible, then stack A above B on genuinely narrow viewports.

Acceptance notes:

- both candidates remain fully visible and independently selectable;
- the stacked layout preserves A-then-B reading order;
- desktop and wider tablet layouts remain side by side;
- keyboard controls and winner-node preservation do not change.

### Fine-grained preference profile

Expand the Preferences modal beyond one freeform prompt so it actively encourages more precise input. At minimum, provide separate fields for themes or subjects, media type, visual style, color palette, and whether output should stay family-friendly or may include adult themes.

Additional useful guidance includes content to avoid, clear field examples, and preserving a single composed preference seed for generation compatibility.

### Live image-supply health

Show a quiet, continuously refreshed Queue and Pool readout beside the round metrics. The readout reports ready challengers, in-flight refill work, and reusable-pool capacity through a narrow stats-only endpoint; it must not expose prompts, candidate metadata, or mailbox internals. Treat the configured queue target as a hard cap across ready plus in-flight work, including superseded jobs that are still draining after a preference change.

### Depleted-buffer pool cadence

When generation falls behind, keep the selected winner fixed, wait three seconds after each empty-queue selection, and draw a random eligible pool image for the losing panel. Permit up to ten consecutive paced pool draws before requiring a generated or seed-buffer candidate; consuming one resets the allowance.

### Visible Elo

Show each candidate's current rounded Elo score in a compact lower-left image overlay. Keep it visually subordinate to the artwork, expose the same value in the card's accessible name, and refresh it after every comparison.

### Saved games

The main header exposes direct Export and Load controls. Export content-addresses the exact JSON bytes, writes `<sha256>.json` to the configured artifact directory, downloads the same file without interrupting play, and reports the server-side path. Generated PNG artifacts use the same full SHA-256 naming contract. Load offers to export the current game first, then accepts a previous save. New Game remains an in-app decision point for exporting, loading, starting fresh, or canceling. A save preserves the round, history, detailed preferences, ready queue, Elo ratings, and pool membership while excluding session-bound generator jobs. Loading validates the entire document and every referenced immutable local image before changing current state, then creates a fresh refill session.

## Future feature ideas

Exploration only; these are not yet roadmap commitments.

### Richer comparison signals

Let a player optionally explain a choice with quick tags such as subject, composition, palette, medium, mood, or character. Keep the A/B decision instant, then use any extra signal to distinguish what the winner got right.

Add **Skip / neither** outcomes so the learning model does not have to treat every forced choice as a strong preference.

### Preference presets and weighting

Allow named profiles for different creative moods, with lightweight importance controls for fields that should act as firm constraints versus loose inspiration. A profile could be duplicated and adjusted without losing the original.

### History, lineage, and favorites

Extend the visual history to show each retained winner's challenger lineage. Let players revisit prior rounds and export the preference profile or prompt context that produced a useful branch.

### Session controls

Consider a reversible one-step undo and a deliberate restart that can keep or reset the preference profile.

### Deliberate exploration modes

Offer optional modes such as broad discovery, close variations on a favorite, medium study, palette study, or tournament-style comparison. Each mode should change generation strategy without changing the core one-click A/B interaction.
