# Product Notes

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

Show a quiet, continuously refreshed Queue and Pool readout beside the round metrics. The readout reports ready challengers, in-flight refill work, and reusable-pool capacity through a narrow stats-only endpoint; it must not expose prompts, candidate metadata, or mailbox internals.

### Depleted-buffer pool cadence

When generation falls behind, keep the selected winner fixed, wait three seconds after each empty-queue selection, and draw a random eligible pool image for the losing panel. Permit up to ten consecutive paced pool draws before requiring a generated or seed-buffer candidate; consuming one resets the allowance.

### Visible Elo

Show each candidate's current rounded Elo score in a compact lower-left image overlay. Keep it visually subordinate to the artwork, expose the same value in the card's accessible name, and refresh it after every comparison.

### Saved games

The main header exposes direct Export and Load controls. Export downloads the exact current game without interrupting play. Load offers to export the current game first, then accepts a previous save. New Game remains an in-app decision point for exporting, loading, starting fresh, or canceling. A save preserves the round, history, detailed preferences, ready queue, Elo ratings, and pool membership while excluding session-bound generator jobs. Loading validates the entire document and every referenced immutable local image before changing current state, then creates a fresh refill session.

## Future feature ideas

Exploration only; these are not yet roadmap commitments.

### Richer comparison signals

Let a player optionally explain a choice with quick tags such as subject, composition, palette, medium, mood, or character. Keep the A/B decision instant, then use any extra signal to distinguish what the winner got right.

Add **Skip / neither** and eventually **both** outcomes so the learning model does not have to treat every forced choice as a strong preference.

### Preference presets and weighting

Allow named profiles for different creative moods, with lightweight importance controls for fields that should act as firm constraints versus loose inspiration. A profile could be duplicated and adjusted without losing the original.

### History, lineage, and favorites

Create a visual history that shows each retained winner's challenger lineage. Let players favorite exceptional images, revisit prior rounds, and export the preference profile or prompt context that produced a useful branch.

### Session controls

Consider a reversible one-step undo and a deliberate restart that can keep or reset the preference profile.

### Deliberate exploration modes

Offer optional modes such as broad discovery, close variations on a favorite, medium study, palette study, or tournament-style comparison. Each mode should change generation strategy without changing the core one-click A/B interaction.
