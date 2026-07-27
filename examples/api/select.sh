#!/usr/bin/env bash

set -euo pipefail

choice="${1:-}"
if [[ ! "$choice" =~ ^(left|right|tie|both-lose)$ ]]; then
  printf '%s\n' "Usage: examples/api/select.sh left|right|tie|both-lose" >&2
  exit 2
fi

base_url="${DIPTYCH_BASE_URL:-http://127.0.0.1:3000}"
game_file="$(mktemp "${TMPDIR:-/tmp}/diptych-game.XXXXXX")"
request_file="$(mktemp "${TMPDIR:-/tmp}/diptych-selection.XXXXXX")"
response_file="$(mktemp "${TMPDIR:-/tmp}/diptych-selection-response.XXXXXX")"
trap 'rm -f "$game_file" "$request_file" "$response_file"' EXIT

curl -sS "$base_url/api/game" -o "$game_file"

node - "$game_file" "$choice" "$request_file" <<'NODE'
const fs = require("node:fs");
const game = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (game.status !== "ready") {
  throw new Error(`Game is ${game.status}; wait until it is ready`);
}
const roundNumber = game.game.round.roundNumber;
const choice = process.argv[3];
const body =
  choice === "left" || choice === "right"
    ? { winnerSide: choice, roundNumber }
    : { outcome: choice, roundNumber };
fs.writeFileSync(process.argv[4], `${JSON.stringify(body)}\n`, "utf8");
NODE

status_code="$(
  curl -sS \
    -o "$response_file" \
    -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    --data-binary "@$request_file" \
    "$base_url/api/game/select"
)"

node - "$response_file" "$status_code" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(
  `${JSON.stringify({ httpStatus: Number(process.argv[3]), response: body }, null, 2)}\n`,
);
NODE
