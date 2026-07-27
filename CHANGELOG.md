# Changelog

All notable public changes are recorded here. This project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Complete v1.0 public documentation, feature matrix, reproducible scenarios,
  API examples, contributor workflow, and release checklist.
- Automated documentation coverage and local-link validation.

### Changed

- Public documentation now distinguishes shipped behavior from experimental
  co-proc transport stages.

## 0.9.0 — 2026-07-27

### Added

- Deterministic offline demo and agent-backed local generation workflow.
- Durable challenger queue, Elo-ranked reusable pool, fallback pacing, and
  champion retirement.
- Win, tie, and both-lose comparisons with immutable winner preservation.
- Full-size inspection, history, favorites, candidate-derived variations, and
  lineage.
- Fine-grained preferences, source-image analysis, adaptive freedom levels,
  revision history, and presets.
- Weighted prompt cards, repair suggestions, two-card blending, and card
  writing from generated favorites.
- Editable per-game rules and versioned save export/import.
- Durable mailbox recovery, content-addressed assets, and experimental
  acknowledged co-proc notification transport.
- Loopback request protections, reproducible dependency policy, comprehensive
  unit/integration tests, and Chromium CI.

### Changed

- Reduced the redistributable curated seed set to five images. New games display
  two and queue three; generated work restores the configured target after the
  first comparison.

### Licensing

- Licensed the software, documentation, and five bundled seed PNGs under MIT.
