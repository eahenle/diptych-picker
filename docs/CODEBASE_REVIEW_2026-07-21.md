# Codebase Review — 2026-07-21

## Scope and evidence

This review followed completion of the queue, image-inspection, preference,
variation-lineage, and saved-profile roadmap notes. It covered:

- domain invariants and serialized game/challenger state;
- API input validation and backward-compatible migrations;
- game, challenger, bootstrap, and snapshot lock ordering;
- mailbox ownership, bounded worker delegation, and recovery scripts;
- modal focus/keyboard boundaries and the main browser flows;
- production compilation, shell entrypoints, and CI coverage;
- module size, repeated contracts, and maintainability hotspots.

The baseline passed formatting, lint, strict TypeScript, 349 unit/integration
tests, nine mailbox-protocol tests, 19 Chromium scenarios, shell syntax checks,
and a Next.js production build.

## Findings and actions

### Addressed in this pass

1. **Preference validation could drift across five boundaries.** Game saves,
   challenger saves, mailbox jobs, profile updates, and preset updates carried
   independent Zod definitions. A new preference field therefore required
   coordinated edits that TypeScript could not enforce. The shared strict,
   request-defaulting, and legacy-persistence schemas now live in one module,
   with focused compatibility tests. The tolerant persisted parser remains
   separate from strict new-data validation by design.
2. **Pull-request CI did not compile the production application.** The existing
   check suite caught types and tests but not Next.js route/build integration.
   CI now runs the production build after the fast validation gate.
3. **Browser regressions were verified locally but not by CI.** A separate
   Chromium job now exercises the full mock-provider game loop, including
   selection, tie/both-lose, queue fallback, inspection, history, favorites,
   preferences, presets, source analysis, export/import, and queued saves.
4. **Launcher scripts had no automated syntax/contract gate.** The normal test
   command now validates all three shell entrypoints and their side-effect-free
   command-preview modes. This protects the production runner and the
   `multi-cli` launcher without starting a second app or agent session.
5. **Transport documentation lagged merged state.** The co-proc prerequisite and
   Diptych notification adapter are now recorded as merged, while persistent
   named workers and deck authority remain explicitly staged.

### Reviewed and retained

- Game/challenger operations consistently acquire the game lock before the
  challenger lock. Snapshot import/export uses the same order. Preset-only
  metadata needs only the game lock and does not touch generation capacity.
- Durable mailbox publication remains the authority; optional co-proc
  notifications cannot make an enqueue fail. The persistent monitor is still
  the only mailbox poller during parity staging.
- Save, API, and job additions remain optional or migration-normalized. No
  advisory in this pass justified a breaking format or endpoint change.
- Raw `<img>` usage is limited to product surfaces whose stable native image
  nodes or immutable local assets are explicit invariants, and each exception
  is locally documented.

### Deferred structural work

1. `GameScreen` and `GameService` are the main complexity hotspots at roughly
   two thousand lines each. Split them along existing feature boundaries
   (preference editor, transfer, inspection; selection, refill, reconciliation)
   in behavior-neutral PRs with the current tests as characterization coverage.
2. Candidate and selection-history schemas are repeated with deliberately
   different timestamp/path strictness between storage and mailbox boundaries.
   Extract shared field fragments only when the context-specific constraints
   can remain obvious; a single overly permissive schema would be worse.
3. The manifest uses `latest` dependency ranges while `npm ci` is reproducible
   through the committed lockfile. Adopt an explicit dependency-update policy
   in a separate maintenance change rather than mixing upgrades into feature or
   hardening work.
4. Prompt-deck persistence, weighted draws, verdict attribution, and
   approval-gated card-editor suggestions landed in subsequent feature passes.
   Persistent co-proc workers remain staged, and transport work should retain
   the current durable mailbox as fallback until end-to-end result parity is
   proven.

## Follow-up status — 2026-07-22

- `GameScreen` is now split across transfer, candidate browsing, selection,
  session polling, and preference-editor controllers.
- `GameService` comparison recording and refill planning now live in focused
  domain modules while the service retains lock, persistence, mailbox, and
  reconciliation ownership.
- The manifest's discovery ranges and lockfile authority are now governed by
  [Dependency update policy](DEPENDENCY_POLICY.md), including isolated updates
  and the full validation gate.
- User-facing game rules now have a focused `game-rules` domain validator,
  strict API boundary, per-game persistence, and Preferences editor. Runtime
  health, pool, scoring, retirement, refill, and fallback paths all read the
  effective saved rules while legacy saves continue using configured defaults.
