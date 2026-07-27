#!/usr/bin/env bash

set -euo pipefail

candidate_id="${1:-}"
favorite="${2:-true}"
if [[ -z "$candidate_id" || ! "$favorite" =~ ^(true|false)$ ]]; then
  printf '%s\n' "Usage: examples/api/favorite.sh <candidate-id> [true|false]" >&2
  exit 2
fi

base_url="${DIPTYCH_BASE_URL:-http://127.0.0.1:3000}"
request_file="$(mktemp "${TMPDIR:-/tmp}/diptych-favorite.XXXXXX")"
trap 'rm -f "$request_file"' EXIT

node - "$request_file" "$candidate_id" "$favorite" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(
  process.argv[2],
  `${JSON.stringify({
    candidateId: process.argv[3],
    favorite: process.argv[4] === "true",
  })}\n`,
  "utf8",
);
NODE

curl -sS \
  -H 'Content-Type: application/json' \
  --data-binary "@$request_file" \
  -X PUT \
  "$base_url/api/game/favorites"
printf '\n'
