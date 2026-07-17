---
name: run-diptych-picker
description: Run the Diptych Picker web app with the current interactive Codex session as its persistent image-generation coordinator. Use when starting, operating, resuming, or monitoring the local preference game and processing generation jobs from its repo-local mailbox.
---

# Run Diptych Picker

Keep this interactive session alive as the coordinator. Start the local app, claim durable jobs, delegate native image generation, validate completions, and continue until the user explicitly stops the runner.

## Guardrails

- Work from the repository root containing `package.json` and this skill.
- Never launch `codex`, `codex exec`, another model process, or an external image API. This session is the coordinator.
- Never ask for or use an OpenAI API key.
- Generate one standalone square PNG per candidate. Never generate a diptych, split frame, comparison sheet, collage, or combined A/B image.
- Never edit, replace, reinterpret, or regenerate the retained winner. Treat its ID, metadata, URL, bytes, file, side, and visible DOM node as immutable.
- Use a fresh subagent for every generated candidate. Each subagent must use native image generation and return one PNG path plus the structured proposal.
- Use parallel workers only after both sides of a new initial batch have been claimed by the same batch owner. Start exactly two fresh workers together for that new pair. On recovery, never regenerate a side carrying `terminalStatus`; process only the unfinished side. Process later challenger jobs one at a time with one fresh worker each.

Read [references/job-protocol.md](references/job-protocol.md) before processing jobs.

## Start and remain active

1. Probe the configured local app's `/api/game` response before reusing a healthy server. Read the `X-Diptych-Generation-Provider` response header case-insensitively. Reuse the server only when the header is exactly `agent`. Refuse to reuse a server reporting `mock`; explain that the running app is the deterministic test worker and stop before claiming jobs. Treat a missing or unknown header as an incompatible server and report it instead of silently reusing it.
2. When no server is healthy, start `GENERATION_PROVIDER=agent npm run dev` in a persistent terminal session. The explicit environment value overrides a leftover mock value in `.env.local`; never start the normal runner in mock mode.
3. Poll the configured local app URL for at most 30 seconds, then verify `/api/game` reports `X-Diptych-Generation-Provider: agent` before declaring readiness. If startup fails or the header is not `agent`, stop the process started by this session, report the error, and remain available; do not start a nested Codex process.
4. Record readiness with `npm run agent:heartbeat -- --status waiting`.
5. Once at coordinator startup or restart, run `npm run agent:next -- --resume --wait-ms 0` to recover one unterminated active job and, for an initial job, its durable `batchOwnerToken`. Process it if printed. Do not use `--resume` in the normal polling loop.
6. Repeatedly run `npm run agent:next -- --wait-ms 30000`. Ordinary calls atomically claim only pending work, so concurrent helpers cannot echo one live active job. Never use a wait longer than 30 seconds.
7. When no JSON is printed, refresh the waiting heartbeat and continue.
8. When stopped by the user, finish no new work, record `--status stopped`, stop the app process started by this session, and report any active job left for recovery.

## Process jobs

Inspect the claimed job's `kind`. A missing `kind` is a legacy challenger.

- For `kind: "challenger"`, process the one claimed job with one fresh subagent.
- For `kind: "initial"`, require `batchId`, `initialSide`, and `batchOwnerToken`. Before spawning a worker, run `npm run agent:next -- --wait-ms 30000 --batch <batchId> --owner-token <batchOwnerToken>` to claim or inspect the other side. An ordinary `agent:next` call cannot claim that owner's pending partner. If no partner JSON is printed, spawn nothing. Keep repeating this owned batch command with the same batch ID, owner token, and 30000 ms wait until partner or terminal JSON appears, or until the user stops the runner. Do not return to ordinary polling while an owned initial partner is pending. For a new pair, start exactly two fresh subagents in parallel only after both unfinished sides are available. If batch inspection returns the other side with `terminalStatus: "completed"` or `"failed"`, do not spawn a worker for that terminal side; start one fresh worker for the claimed unfinished side only.

Resolve the data root as `${LOCAL_DATA_DIR:-.local-data}`. Create `<data-root>/agent-work/<jobId>/` for each worker. Have the worker save its native image-generation output as `image.png` and its strict proposal JSON as `proposal.json` there. Do not pass proposal JSON or failure text directly as command-line arguments.

Give each worker the complete job JSON and these constraints:

- Use the preference seed, retained-winner metadata, rejected-candidate metadata, recent history, and recent concepts to propose something novel.
- Use the retained winner only as preference evidence. Do not modify it or generate a variation/edit of its image.
- Avoid the rejected concept and recent concepts unless a genuinely different treatment is essential.
- Produce exactly one standalone square PNG through native image generation, fully decoded and saved to a local path.
- Write a strict proposal object with `concept`, `visualPrompt`, `styleTags`, and `reasoningSummary` to the assigned `proposal.json`, and return both work-file paths.

For each claimed job:

1. Record `npm run agent:heartbeat -- --status generating --job <id>`.
2. Delegate to a fresh worker and inspect its proposal and image path.
3. Complete with `npm run agent:complete -- --job <id> --proposal-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/proposal.json" --image "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/image.png"`. Let the helper validate and immutably copy the asset; never copy it manually over an existing asset.
4. If generation or validation cannot complete, write a concise reason to `<data-root>/agent-work/<id>/failure.txt`, then run `npm run agent:fail -- --job <id> --message-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/failure.txt"`. Failures are retryable.
5. Record the terminal outcome, return the heartbeat to `waiting`, and continue the loop.

Do not exit after a successful or failed job. The mailbox is durable: startup `--resume` recovers unterminated active work, matching outcome retries safely continue after interruption, and terminal artifacts remain until the app reconciles and archives them.
