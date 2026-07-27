# Examples

The examples are organized by intent:

- [Feature scenarios](feature-scenarios.md) provides one reproducible case for
  every row in the [v1.0 feature matrix](../docs/FEATURE_MATRIX.md).
- [API scripts](api/) are runnable loopback clients. They default to
  `http://127.0.0.1:3000`; override `DIPTYCH_BASE_URL` when using another port.
- [Configurations](configurations/) are copyable environment-file examples.

## Run API examples

Start the offline demo in one terminal:

```bash
npm run demo
```

In another terminal:

```bash
examples/api/status.sh
examples/api/select.sh left
examples/api/set-rules.sh 5 50 10 10
examples/api/export-save.sh output/artifacts/example-save.json
```

Mutation examples operate on the currently running local game. Export first if
the state matters.

## Validation

```bash
npm run docs:check
```

The checker validates local Markdown links, required public documents,
feature/scenario parity, cited test files, shell syntax, and JSON examples.
