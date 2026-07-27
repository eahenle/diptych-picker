#!/usr/bin/env bash

set -euo pipefail

destination="${1:-}"
if [[ -z "$destination" ]]; then
  printf '%s\n' "Usage: examples/api/export-save.sh <destination.json>" >&2
  exit 2
fi

base_url="${DIPTYCH_BASE_URL:-http://127.0.0.1:3000}"
destination_directory="$(dirname -- "$destination")"
mkdir -p "$destination_directory"

curl -sS "$base_url/api/game/snapshot" -o "$destination"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$destination"
printf 'Saved %s\n' "$destination"
