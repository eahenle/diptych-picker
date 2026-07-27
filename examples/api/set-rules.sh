#!/usr/bin/env bash

set -euo pipefail

if (( $# != 4 )); then
  printf '%s\n' \
    "Usage: examples/api/set-rules.sh <queue 1-10> <pool 2-50> <streak 2-50> <fallback 1-50>" >&2
  exit 2
fi

for value in "$@"; do
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "Every rule must be a whole number." >&2
    exit 2
  fi
done

base_url="${DIPTYCH_BASE_URL:-http://127.0.0.1:3000}"
request_file="$(mktemp "${TMPDIR:-/tmp}/diptych-rules.XXXXXX")"
trap 'rm -f "$request_file"' EXIT

node - "$request_file" "$1" "$2" "$3" "$4" <<'NODE'
const fs = require("node:fs");
const rules = {
  bufferTarget: Number(process.argv[3]),
  poolMaximum: Number(process.argv[4]),
  championRetirementStreak: Number(process.argv[5]),
  fallbackMaximumConsecutive: Number(process.argv[6]),
};
fs.writeFileSync(process.argv[2], `${JSON.stringify(rules)}\n`, "utf8");
NODE

curl -sS \
  -H 'Content-Type: application/json' \
  --data-binary "@$request_file" \
  -X PATCH \
  "$base_url/api/game/rules"
printf '\n'
