---
name: run-diptych-picker
description: Run the Diptych Picker web app with the root interactive Codex session supervising a dedicated persistent mailbox-monitor subagent. Use when starting, operating, resuming, or monitoring the local preference game and processing generation jobs from its repo-local mailbox.
---

# Run Diptych Picker

Keep the root interactive session responsive as supervisor. Start and verify the local app, then delegate all blocking mailbox recovery, polling, job claiming, worker orchestration, and terminal publication to exactly one long-lived monitor subagent. Keep that monitor alive until the user explicitly stops the runner.

## Execution model

- **Root session (supervisor):** Own the user conversation, app-process lifecycle, provider verification, monitor lifecycle, and final status reporting. Never run the blocking mailbox loop or claim a generation job itself.
- **Mailbox monitor (one persistent subagent):** Own heartbeats, startup recovery, ordinary polling, every job claim, owned-initial-batch inspection, worker spawning, completion/failure publication, and recovery status. It may spawn its own image workers and must continue after each terminal job.
- **Image workers (fresh subagents):** Generate exactly one candidate each through native image generation, write only their assigned `image.png` and `proposal.json`, report paths to the monitor, and exit. Never reuse a worker for another candidate.

Before spawning the monitor, determine how many child-agent slots can remain available beneath it while the root session and monitor are active. Set `workerLimit` to that count capped at 3. When the launch prompt supplies `workerLimit=3`, use all three slots after confirming that the current session exposes them. Require `workerLimit >= 2` because a new initial pair must start together. Pass the limit to the monitor. The monitor must use `--max-refills <workerLimit>` and must never claim a refill it cannot immediately delegate. Do not count terminal recovery entries as workers. `agents.max_threads` is only a concurrency ceiling, so the monitor must explicitly spawn one worker per independent claimed job; with at least three pending refills, a three-worker limit means three worker subagents, not two.

## Guardrails

- Work from the repository root containing `package.json` and this skill.
- Never launch `codex`, `codex exec`, another model process, or an external image API. The root session, monitor subagent, and image-worker subagents are the complete agent tree.
- Never ask for or use an OpenAI API key.
- Generate one standalone square PNG per candidate. Never generate a diptych, split frame, comparison sheet, collage, or combined A/B image.
- Never edit, replace, reinterpret, or regenerate the retained winner. Treat its ID, metadata, URL, bytes, file, side, and visible DOM node as immutable.
- The root must use a fresh dedicated monitor subagent each time the runner starts or resumes. Never perform monitoring in the root session and never split mailbox ownership across multiple monitors.
- The monitor must use a fresh subagent for every generated candidate. Each worker must use native image generation and return one PNG path plus the structured proposal.
- The monitor may use parallel workers only for (a) both sides of a new initial batch claimed by the same batch owner or (b) one `refill-batch` returned by `agent:next`. Start exactly two fresh workers together for a new initial pair and exactly one fresh worker per claimed refill, never exceeding `workerLimit`. On recovery, never regenerate a job carrying `terminalStatus`; process only unfinished work. Process ordinary challenger jobs one at a time with one fresh worker.

Read [references/job-protocol.md](references/job-protocol.md) before processing jobs.

## Start the app and monitor

1. Probe the configured local app's `/api/game` response before reusing a healthy server. Read the `X-Diptych-Generation-Provider` response header case-insensitively. Reuse the server only when the header is exactly `agent`. Refuse to reuse a server reporting `mock`; explain that the running app is the deterministic test worker and stop before claiming jobs. Treat a missing or unknown header as an incompatible server and report it instead of silently reusing it.
2. When no server is healthy, start `GENERATION_PROVIDER=agent npm run dev` in a persistent terminal session. The explicit environment value overrides a leftover mock value in `.env.local`; never start the normal runner in mock mode.
3. Poll the configured local app URL for at most 30 seconds, then verify `/api/game` reports `X-Diptych-Generation-Provider: agent` before declaring readiness. If startup fails or the header is not `agent`, stop the process started by this session, report the error, and remain available; do not start a nested Codex process.
4. Spawn exactly one long-lived monitor subagent. Give it the repository path, `workerLimit`, the app URL, whether the root started the app, and instructions to read this `SKILL.md` plus [references/job-protocol.md](references/job-protocol.md) completely before touching the mailbox. Do not ask the monitor to return after one poll or one job.
5. The monitor records readiness with `npm run agent:heartbeat -- --status waiting`.
6. At monitor startup or restart, it runs `npm run agent:next -- --resume --wait-ms 0 --max-refills <workerLimit>`. It processes returned unfinished work, then repeats the same recovery command until it prints no JSON. Initial jobs include their durable `batchOwnerToken`. Do not use `--resume` in the normal polling loop.
7. The monitor repeatedly runs `npm run agent:next -- --wait-ms 30000 --max-refills <workerLimit>`. Ordinary challenger and initial work has priority. When neither is claimable, the helper atomically claims up to `workerLimit` oldest pending refills and emits one `refill-batch`. Never use a wait longer than 30 seconds, a refill limit above 3, or a limit above immediately available worker slots.
8. When no JSON is printed, the monitor refreshes the waiting heartbeat and continues. It sends concise readiness, terminal-job, failure, and blocked-status updates to the root without exiting.
9. The root remains available for user requests and may work on unrelated non-mailbox tasks. It must not call `agent:next`, `agent:complete`, or `agent:fail` while the monitor owns the loop.
10. When stopped by the user, the root tells the monitor to claim no new work. The monitor lets already-started image workers reach a terminal result when practical, records `--status stopped`, reports active recoverable jobs, and exits. The root then stops only an app process it started and reports the final state.

## Process jobs

The monitor inspects each claimed job's `kind`. A missing `kind` is a legacy challenger.

- For `kind: "challenger"`, process the one claimed job with one fresh worker subagent.
- For `kind: "initial"`, require `batchId`, `initialSide`, and `batchOwnerToken`. Before spawning a worker, run `npm run agent:next -- --wait-ms 30000 --batch <batchId> --owner-token <batchOwnerToken>` to claim or inspect the other side. An ordinary `agent:next` call cannot claim that owner's pending partner. If no partner JSON is printed, spawn nothing. Keep repeating this owned batch command with the same batch ID, owner token, and 30000 ms wait until partner or terminal JSON appears, or until the user stops the runner. Do not return to ordinary polling while an owned initial partner is pending. For a new pair, start exactly two fresh subagents in parallel only after both unfinished sides are available. If batch inspection returns the other side with `terminalStatus: "completed"` or `"failed"`, do not spawn a worker for that terminal side; start one fresh worker for the claimed unfinished side only.
- For `kind: "refill-batch"`, require a non-empty `jobs` array of at most `workerLimit` entries and require every entry to have `kind: "refill"`. Spawn exactly one fresh native image-generation worker per entry, together in parallel. Give each worker only its complete job JSON and its own work directory. Never combine refill prompts or images. Complete or fail every claimed refill independently even if a sibling worker fails, then return to waiting.

Resolve the data root as `${LOCAL_DATA_DIR:-.local-data}`. Create `<data-root>/agent-work/<jobId>/` for each worker. Have the worker save its native image-generation output as `image.png` and its strict proposal JSON as `proposal.json` there. Do not pass proposal JSON or failure text directly as command-line arguments.

Give each worker the complete job JSON and these constraints:

- Treat `preferenceSeed` as the authoritative creative brief. The proposal, visual prompt, and generated image must satisfy every explicit subject, count, medium, style, palette, content-level, and avoidance constraint it contains. Do not replace its requested subject with a metaphor, adjacent theme, or novel concept from prior rounds.
- Read `preferenceProfile.adaptationMode` when present; legacy jobs without a structured profile are Static. For Static jobs, omit `preferenceRevision` and do not mutate any preference field. For Adaptive jobs, write a complete `preferenceRevision` conditioned on the retained winner and selection history. It must include `themes`, `inspiration`, `mediaTypes`, `visualStyle`, `colorPalette`, `contentLevel`, and `avoid`, but never mode or source IDs. Keep it concise and describe transferable preferences rather than a person's identity or likeness.
- Retained-winner metadata, rejected-candidate metadata, history, and recent concepts are secondary. Use them only to choose a novel treatment that remains inside the preference seed; when they conflict, the preference seed wins.
- Use the retained winner only as preference evidence. Do not modify it or generate a variation/edit of its image.
- Avoid the rejected concept and recent concepts unless a genuinely different treatment is essential.
- Produce exactly one standalone square PNG through native image generation, fully decoded and saved to a local path.
- Write a strict proposal object with required `concept`, `visualPrompt`, `styleTags`, and `reasoningSummary` fields plus `preferenceRevision` only for an Adaptive job. In `reasoningSummary`, state how the proposal follows the preference seed while remaining distinct from recent work, then return both work-file paths.

For each claimed job (including every entry in a refill batch):

1. Record `npm run agent:heartbeat -- --status generating --job <id>`.
2. Delegate to a fresh worker and inspect its proposal and image path. Reject the handoff if its proposal or visible image contradicts an explicit preference-seed constraint; ask that worker to revise or regenerate, and fail the job rather than publish an out-of-brief result if it cannot comply.
3. Complete with `npm run agent:complete -- --job <id> --proposal-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/proposal.json" --image "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/image.png"`. Let the helper validate the PNG, name it from its exact SHA-256 content digest, and publish immutable copies to local asset storage and `output/artifacts`; never copy it manually over an existing asset.
4. If generation or validation cannot complete, write a concise reason to `<data-root>/agent-work/<id>/failure.txt`, then run `npm run agent:fail -- --job <id> --message-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/failure.txt"`. Failures are retryable.
5. Record the terminal outcome. For a refill batch, wait until every claimed entry has independently reached `completed` or `failed`. Return the heartbeat to `waiting`, and continue the loop.

Do not exit after a successful or failed job. The mailbox is durable: startup `--resume` recovers unterminated active work, matching outcome retries safely continue after interruption, and terminal artifacts remain until the app reconciles and archives them.
