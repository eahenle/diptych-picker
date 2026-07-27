#!/usr/bin/env bash

set -euo pipefail

base_url="${DIPTYCH_BASE_URL:-http://127.0.0.1:3000}"
headers_file="$(mktemp "${TMPDIR:-/tmp}/diptych-status-headers.XXXXXX")"
body_file="$(mktemp "${TMPDIR:-/tmp}/diptych-status-body.XXXXXX")"
trap 'rm -f "$headers_file" "$body_file"' EXIT

curl -sS -D "$headers_file" "$base_url/api/game" -o "$body_file"

provider="$(
  tr -d '\r' <"$headers_file" |
    awk -F ': ' 'tolower($1) == "x-diptych-generation-provider" { print $2 }'
)"

node - "$body_file" "$provider" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const summary = {
  provider: process.argv[3] || null,
  status: body.status,
  round: body.game?.round?.roundNumber ?? null,
  roundStatus: body.game?.round?.status ?? null,
  bufferHealth: body.bufferHealth ?? null,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
NODE
