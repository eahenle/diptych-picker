#!/usr/bin/env bash

set -euo pipefail

source_file="${1:-}"
if [[ -z "$source_file" || ! -f "$source_file" ]]; then
  printf '%s\n' "Usage: examples/api/restore-save.sh <save.json>" >&2
  exit 2
fi

node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$source_file"

base_url="${DIPTYCH_BASE_URL:-http://127.0.0.1:3000}"
curl -sS \
  -H 'Content-Type: application/json' \
  --data-binary "@$source_file" \
  -X PUT \
  "$base_url/api/game/snapshot"
printf '\n'
