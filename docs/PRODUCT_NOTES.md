# Product Notes

## 2026-07-20

### Large image inspection

Each active candidate has a magnifying-glass control that opens its immutable image in a larger, contained modal without selecting either side or changing generation state. The view identifies the candidate, closes from its dedicated control, backdrop, or `Escape`, and suppresses gameplay shortcuts while open.

### Tie decisions

The comparison screen exposes **Declare tie**, mapped to `C` and `3`. A tie clears both active candidates and records a neutral history decision. When Elo scores differ, only the lower-rated candidate gains the score it would have received for a win; the higher-rated candidate is unchanged. Equal scores do not change. Tie decisions do not alter win/loss counts or supply positive or negative adaptive-preference evidence, and tie-triggered refill work carries an explicit neutral outcome marker.

### Comparison history

The Round metric opens a newest-first timeline of prior decisions. Each row resolves display-safe winner and rejected-candidate thumbnails, concepts, and concise style tags from the durable rating catalog without exposing prompts. The first iteration shows up to fifty decisions and retains a total count.

History and pool rows let the player favorite exceptional candidates. Favorite state belongs to the durable rating catalog, is shared across both views, survives new games and save-file round trips, and remains independent of Elo and reusable-pool membership. Richer lineage remains a separate follow-up.

### Profile-wide adaptation

The Preference profile title row exposes **Static / Adaptive** for the entire profile. Static is the default and prevents model mutation of every preference field. Adaptive lets each generated proposal carry a complete trajectory-conditioned profile revision; the app adopts it only if that candidate later wins. Separate bounded winner and rejected-generated-candidate source lists preserve which comparison outcome supplied each signal. Future workers receive those lists plus recent comparison history and must treat winners as positive evidence and generated losers as negative evidence when authoring the next revision. Provenance-only updates do not flush already-buffered work, while a model-authored field revision still invalidates earlier-profile capacity and composes future jobs from the revised fields. Generation failures, cancellations, moderation blocks, and invalid worker output remain operational outcomes and do not influence taste preferences.

### Moderation feedback

Mailbox failures carry an explicit operational, moderation, or invalid-output category. A moderation-blocked background refill is replaced normally but also creates a persistent, non-blocking notice in the game. The notice counts repeated blocks and lets the player dismiss it or open Preferences to steer future generations toward allowed content. Saving a profile clears the notice.

### Queued preference saves

**Save profile** remains actionable while the active round waits for a challenger. Clicking it captures and locks the edited profile, displays animated queued/saving feedback inside the modal, and applies the profile automatically after the round settles. The queued edit deliberately supersedes an adaptive revision from that in-flight round while exact-profile conflict protection still rejects unrelated concurrent edits.

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

Place a **Static / Adaptive** toggle on the top line of the Preference profile modal and apply it to every preference field. Static is the default and preserves the profile as entered. Adaptive explicitly permits the model to revise the full profile from the game trajectory; revisions remain attributable to the influencing winners.

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

Add **Skip / neither** and eventually **both** outcomes so the learning model does not have to treat every forced choice as a strong preference.

Add a distinct **Both lose** action mapped to `D` and `4`. Record that the player rejected both images and clear both candidates from the active round. Define its Elo and reusable-pool removal behavior explicitly before implementation rather than treating it as a tie or silently choosing a winner.

### Image inspection and score-state cues

Replace the visible Elo number with a distinct symbol when a candidate is appearing for the first time, and with another symbol when losing the current round would remove that candidate from the reusable pool.

### Preference presets and weighting

Allow named profiles for different creative moods, with lightweight importance controls for fields that should act as firm constraints versus loose inspiration. A profile could be duplicated and adjusted without losing the original.

### Source-image profile ingestion

Let the player ingest a source image and derive an editable Preference profile aimed at generating variations on its depicted themes and content. The populated fields should describe transferable subject matter, composition, medium, style, palette, and constraints rather than asking future generations to reproduce a specific person's identity or exact likeness.

### History, lineage, and favorites

Extend the visual history to show each retained winner's challenger lineage. Let players revisit prior rounds and export the preference profile or prompt context that produced a useful branch.

### Session controls

Consider a reversible one-step undo and a deliberate restart that can keep or reset the preference profile.

### Deliberate exploration modes

Offer optional modes such as broad discovery, close variations on a favorite, medium study, palette study, or tournament-style comparison. Each mode should change generation strategy without changing the core one-click A/B interaction.
