# v1.0 release checklist

Use this checklist for the first `1.0.0` release and adapt it for later
versions. Do not tag a release with unresolved required items.

## Scope

- [ ] Every intended public feature appears in
      [the feature matrix](FEATURE_MATRIX.md).
- [ ] Every matrix row has public documentation, one reproducible scenario, and
      automated evidence.
- [ ] Experimental behavior is explicitly labeled and excluded from the normal
      quickstart path.
- [ ] No proposal document implies that unshipped behavior is current.

## Documentation

- [ ] `npm run docs:check` passes.
- [ ] Quickstart works from a clean clone on Node.js 24.
- [ ] Every command in Getting started, Contributing, and Examples has been run
      exactly as written.
- [ ] Offline demo, agent launch, save round trip, and all API scripts have been
      exercised.
- [ ] User-guide screenshots, if added, show current UI and contain no private
      local data.
- [ ] README, package version, changelog, security support statement, and release
      notes agree on the version.

## Licensing and provenance

- [ ] `LICENSE` contains the intended copyright holder and year.
- [ ] `package.json` declares `MIT`.
- [ ] Every bundled seed is listed in
      [the seed notes](../public/seed-assets/README.md).
- [ ] Every shipped image or screenshot has recorded redistribution permission.
- [ ] No removed or unlicensed asset remains in Git history for the release
      tree, manifest, documentation, tests, or examples.

## Security and privacy

- [ ] [Security](../SECURITY.md) matches the actual loopback and same-origin
      enforcement.
- [ ] The app has no API-key input, remote account surface, or model subprocess.
- [ ] Public APIs omit prompts, source-image paths, and mailbox contents.
- [ ] `.gitignore` excludes local data, artifacts, environment overrides, and
      private worker handoffs.
- [ ] `npm audit --omit=dev` reports no high or critical production findings.

## Validation

- [ ] `npm ci`
- [ ] `npm run check`
- [ ] `npm run build`
- [ ] `npm run test:e2e`
- [ ] `npm audit --omit=dev`
- [ ] GitHub `validate` job passes.
- [ ] GitHub `e2e` job passes.
- [ ] Manual offline-demo smoke test passes.
- [ ] Manual agent-provider smoke test returns
      `X-Diptych-Generation-Provider: agent`.
- [ ] Interrupted-job recovery has been exercised without duplicate publication.

## Release

- [ ] Update `package.json` and `package-lock.json` to `1.0.0`.
- [ ] Move Unreleased changelog entries into `1.0.0 — YYYY-MM-DD`.
- [ ] Update `SECURITY.md` supported versions.
- [ ] Merge the release pull request with green checks.
- [ ] Create annotated tag `v1.0.0` from the verified merge commit.
- [ ] Publish GitHub release notes from the changelog and feature matrix.
- [ ] Verify the release archive contains the five intended seed PNGs and no
      local data.
- [ ] Run the documented clean-clone quickstart from the release archive.

## Post-release

- [ ] Confirm the GitHub release and source archives are publicly accessible.
- [ ] Open follow-up issues for deferred work rather than expanding the tagged
      release.
- [ ] Begin the next changelog under Unreleased.
