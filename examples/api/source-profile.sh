#!/usr/bin/env bash

set -euo pipefail

source_file="${1:-}"
if [[ -z "$source_file" || ! -f "$source_file" ]]; then
  printf '%s\n' "Usage: examples/api/source-profile.sh <source.png|jpg|webp>" >&2
  exit 2
fi

base_url="${DIPTYCH_BASE_URL:-http://127.0.0.1:3000}"
response_file="$(mktemp "${TMPDIR:-/tmp}/diptych-source-profile.XXXXXX")"
trap 'rm -f "$response_file"' EXIT

curl -sS \
  -F "image=@$source_file" \
  "$base_url/api/game/preferences/source" \
  -o "$response_file"

job_id="$(
  node -e '
    const body = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (!body.jobId) throw new Error(body.error || "No analysis job was returned");
    process.stdout.write(body.jobId);
  ' "$response_file"
)"

for _attempt in {1..60}; do
  curl -sS \
    "$base_url/api/game/preferences/source?jobId=$job_id" \
    -o "$response_file"
  analysis_status="$(
    node -e '
      const body = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(body.status || "unknown");
    ' "$response_file"
  )"
  if [[ "$analysis_status" != "analyzing" ]]; then
    node -e '
      const body = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    ' "$response_file"
    exit 0
  fi
  sleep 2
done

printf 'Analysis job %s did not finish within 120 seconds.\n' "$job_id" >&2
exit 1
