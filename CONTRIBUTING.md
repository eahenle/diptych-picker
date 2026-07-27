# Contributing

Thank you for improving Diptych Picker.

## Before opening a change

1. Read the [Getting started guide](docs/GETTING_STARTED.md).
2. Check [Product notes](docs/PRODUCT_NOTES.md) and existing issues for current
   scope.
3. Keep one pull request focused on one feature, fix, documentation set, or
   dependency update.
4. Preserve compatibility for saved games, local APIs, and mailbox records
   unless the change explicitly includes a migration.

Do not commit `.env.local`, `.local-data`, `output/artifacts`, private source
images, credentials, or generated worker handoffs.

## Set up

```bash
npm ci
npm run hooks:install
```

Node.js 24 or newer is required. Reproducible installs and upgrade scope follow
the [dependency policy](docs/DEPENDENCY_POLICY.md).

## Develop

Use the deterministic demo for interface work:

```bash
npm run demo
```

Use the normal development server only when hot reload is useful:

```bash
GENERATION_PROVIDER=mock DIPTYCH_OFFLINE_DEMO=true npm run dev
```

Use `npm run codex:play` only for work that genuinely requires the persistent
agent workflow. Never start a second mailbox monitor against the same local
data directory.

## Product invariants

Changes must preserve these boundaries unless the proposal explicitly replaces
them:

- exactly two independent candidate images are visible once a game is ready;
- the selected winner's ID, URL, bytes, side, and visible image node remain
  unchanged;
- only one persistent monitor owns mailbox polling;
- one fresh worker produces one standalone square image;
- generated work never edits the retained winner;
- the durable mailbox remains authoritative;
- app and demo launchers bind to `127.0.0.1`;
- the web app never receives an API key or starts a model process;
- public read models omit prompts, private sources, and mailbox details.

## Tests

Run the fast required gate:

```bash
npm run check
```

Run production and browser gates before requesting merge:

```bash
npm run build
npm run test:e2e
npm audit --omit=dev
```

`npm run check` includes documentation coverage and link validation. Feature
changes must add or update:

1. public documentation;
2. one `DP-###` row in [the feature matrix](docs/FEATURE_MATRIX.md), when the
   behavior is newly public;
3. the matching case in
   [feature scenarios](examples/feature-scenarios.md);
4. automated test evidence.

## Code and data boundaries

- Keep domain transitions pure where practical.
- Acquire the game lock before the challenger lock.
- Persist generation intent before publishing mailbox work.
- Validate complete worker results against their durable expected job.
- Treat seed and generated assets as immutable.
- Keep API schemas strict for new requests and explicitly tolerant only at
  migration boundaries.

## Seed images

The five tracked seed PNGs are distributed under the repository MIT License.
Do not add an image without recording its depiction, repository provenance, and
redistribution terms in
[the seed notes](public/seed-assets/README.md). Generated documentation
screenshots must not expose private local data.

## Pull requests

Explain:

- the user-visible outcome;
- compatibility or migration impact;
- validation run locally;
- any behavior intentionally left experimental.

GitHub CI must pass both `validate` and `e2e`. Review the final diff for
generated `next-env.d.ts` or unrelated local artifacts before merge.

## Security reports

Follow [SECURITY.md](SECURITY.md). Do not place secrets, private images,
prompts, or local data in a public issue.
