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
- **Source-profile workers (fresh subagents):** Inspect exactly one user-uploaded source image, write only their assigned `profile.json`, report its path to the monitor, and exit. They describe transferable content and aesthetics without identifying a person or requesting an exact likeness.
- **Leaderboard-profile workers (fresh subagents):** Inspect one immutable, content-addressed set of two through four current pool leaders, write only their assigned `profile.json`, report its path to the monitor, and exit. They synthesize shared visual qualities without modifying or regenerating any source.
- **Import-annotation workers (fresh subagents):** Inspect exactly one normalized imported image, write only its strict `annotation.json`, report its path to the monitor, and exit. They never generate, edit, copy, or publish image bytes.
- **Prompt-card editor workers (fresh subagents):** Review one repeatedly rejected prompt card plus its bounded rejection evidence, write only two approval-gated alternatives to `suggestions.json`, report its path to the monitor, and exit. They never edit the source card or generate an image.
- **Prompt-card blender workers (fresh subagents):** Blend two immutable prompt cards at the requested ratio, write one approval-gated child proposal to `suggestion.json`, report its path to the monitor, and exit. They never edit either parent or generate an image.
- **Prompt-card writer workers (fresh subagents):** Inspect three through five immutable generated favorites, synthesize their shared transferable aesthetics into one approval-gated card proposal in `suggestion.json`, report its path to the monitor, and exit. They never edit a source or generate an image.

Before spawning the monitor, determine how many child-agent slots can remain available beneath it while the root session and monitor are active. Set `workerLimit` to that count capped at 3. When the launch prompt supplies `workerLimit=3`, use all three slots after confirming that the current session exposes them. Require `workerLimit >= 2` because a new initial pair must start together. Pass the limit to the monitor. The monitor must use `--max-refills <workerLimit>` and must never claim a refill it cannot immediately delegate. Do not count terminal recovery entries as workers. `agents.max_threads` is only a concurrency ceiling, so the monitor must explicitly spawn one worker per independent claimed job; with at least three pending refills, a three-worker limit means three worker subagents, not two.

## Guardrails

- Work from the repository root containing `package.json` and this skill.
- Never launch `codex`, `codex exec`, another model process, or an external image API. The root session, monitor subagent, and image-worker subagents are the complete agent tree.
- Never ask for or use an OpenAI API key.
- For candidate-generation jobs, generate one standalone square PNG per candidate. Never generate a diptych, split frame, comparison sheet, collage, or combined A/B image. Source-profile, leaderboard-profile, and import-annotation jobs analyze existing private images and must not generate another image.
- Never edit, replace, reinterpret, or regenerate the retained winner. Treat its ID, metadata, URL, bytes, file, side, and visible DOM node as immutable.
- The root must use a fresh dedicated monitor subagent each time the runner starts or resumes. Never perform monitoring in the root session and never split mailbox ownership across multiple monitors.
- The monitor must use a fresh subagent for every generated candidate. Each worker must use native image generation and return one PNG path plus the structured proposal.
- The monitor may use parallel workers only for (a) both sides of a new initial batch claimed by the same batch owner, (b) one `refill-batch`, or (c) one `import-annotation-batch` returned by `agent:next`. Start exactly two fresh workers together for a new initial pair and exactly one fresh worker per claimed refill or annotation, never exceeding `workerLimit`. On recovery, never regenerate a job carrying `terminalStatus`; process only unfinished work. Process ordinary challenger jobs one at a time with one fresh worker.

Read [references/job-protocol.md](references/job-protocol.md) before processing jobs.

## Start the app and monitor

1. Probe the configured local app's `/api/game` response before reusing a healthy server. Read the `X-Diptych-Generation-Provider` response header case-insensitively. Reuse the server only when the header is exactly `agent`. Refuse to reuse a server reporting `mock`; explain that the running app is the deterministic test worker and stop before claiming jobs. Treat a missing or unknown header as an incompatible server and report it instead of silently reusing it.
2. When no server is healthy, start `./run-only` in a persistent terminal session. That launcher builds into the isolated `.next-run` directory, restores Next's generated TypeScript configuration before serving, and starts with `GENERATION_PROVIDER=agent`; never start the normal runner in mock or Next development mode.
3. Poll the configured local app URL for at most 30 seconds, then verify `/api/game` reports `X-Diptych-Generation-Provider: agent` before declaring readiness. If startup fails or the header is not `agent`, stop the process started by this session, report the error, and remain available; do not start a nested Codex process.
4. Spawn exactly one long-lived monitor subagent. Give it the repository path, `workerLimit`, the app URL, whether the root started the app, and instructions to read this `SKILL.md` plus [references/job-protocol.md](references/job-protocol.md) completely before touching the mailbox. `workerLimit` is the shared one-through-three fresh-worker-slot bound across image-generation and analysis work, not an image-only limit. Do not ask the monitor to return after one poll or one job.
5. The monitor records readiness with `npm run agent:heartbeat -- --status waiting`.
6. At monitor startup or restart, it runs `npm run agent:next -- --resume --wait-ms 0 --max-refills <workerLimit>`. It processes returned unfinished challenger/initial work, `import-annotation-batch` work, cached analysis, or refill batches, then repeats the same recovery command until it prints no JSON. Initial jobs include their durable `batchOwnerToken`. Do not use `--resume` in the normal polling loop.
   The helper excludes active work carrying an unexpired persistent-worker lease. It revokes an expired lease under the job's durable lease lock and returns that work for mailbox recovery. The monitor never creates or renews a co-proc lease.
7. The monitor repeatedly runs `npm run agent:next -- --wait-ms 30000 --max-refills <workerLimit>`. Ordinary challenger, initial, interactive source-profile, and prompt-card work has priority. Then the helper atomically claims up to `workerLimit` oldest import annotations and emits an `import-annotation-batch`; cached leaderboard analysis follows, then refill claims. The ordinary loop also returns expired persistent-worker leases immediately, so takeover does not require a monitor restart. Never use a wait longer than 30 seconds, a refill limit above 3, or a limit above immediately available worker slots.
8. When no JSON is printed, the monitor refreshes the waiting heartbeat and continues. It sends concise readiness, terminal-job, failure, and blocked-status updates to the root without exiting.
9. The root remains available for user requests and may work on unrelated non-mailbox tasks. It must not call `agent:next`, `agent:complete`, or `agent:fail` while the monitor owns the loop.
10. When stopped by the user, the root tells the monitor to claim no new work. The monitor lets already-started image workers reach a terminal result when practical, records `--status stopped`, reports active recoverable jobs, and exits. The root then stops only an app process it started and reports the final state.

The mailbox monitor always uses the unleased file-backed completion and failure
flow below. It never sends co-proc `ack` or `result` frames. A separate
persistent co-proc peer, when configured, must follow
[references/job-protocol.md](references/job-protocol.md): claim and renew with
its lease token, publish through the matching token-gated helper, then send the
strict correlated terminal frame only after durable publication succeeds.

## Process jobs

The monitor inspects each claimed job's `kind`. A missing `kind` is a legacy challenger.

- For `kind: "challenger"`, process the one claimed job with one fresh worker subagent.
- For `kind: "source-profile"`, process the one claimed job with one fresh source-profile worker. Resolve `sourceImage.path` beneath the data root, give the worker that exact local image, and do not call image generation.
- For `kind: "leaderboard-profile"`, process the one claimed job with one fresh leaderboard-profile worker. Require two through four unique ranked `sources`, resolve every `sourceImage.path` beneath the data root, give the worker all and only those local images plus their rank metadata, and do not call image generation.
- For `kind: "prompt-card-editor"`, process the one claimed job with one fresh prompt-card editor worker. Require one immutable `card` plus four through twelve `recentRejections`; give the worker only that bounded evidence and do not call image generation.
- For `kind: "prompt-card-blender"`, process the one claimed job with one fresh prompt-card blender worker. Require exactly two distinct immutable `cards` and a ratio from 0.1 through 0.9; give the worker only those inputs and do not call image generation.
- For `kind: "prompt-card-writer"`, process the one claimed job with one fresh prompt-card writer worker. Require three through five unique generated `sources`, resolve every `sourceImage.path` beneath the data root, give the worker all and only those local images plus their display-safe concept and style metadata, and do not call image generation.
- For `kind: "import-annotation-batch"`, require a non-empty `jobs` array of at most `workerLimit` entries and require every entry to have `kind: "import-annotation"`. Before handing an image to a worker, resolve each entry in this order: (1) set the data root to `${LOCAL_DATA_DIR:-.local-data}` and derive its only candidate path as `<data-root>/assets/<asset.filename>`; (2) require `asset.filename` to be `<asset.digest>.png`, `asset.url` to be `/api/assets/<asset.filename>`, PNG `asset.contentType`, 1024-by-1024 dimensions, and a byte length; (3) realpath the asset root and candidate file, require the file to remain contained beneath that root and be a regular file; (4) hash its exact bytes and require the SHA-256 and byte length to equal `asset.digest` and `asset.byteLength`. Only then spawn one fresh analysis worker for each entry together, including all three worker slots for a three-entry batch. Each worker receives that resolved canonical imported candidate asset and returns one strict `annotation.json`; do not generate, edit, or copy image bytes. A job never supplies an arbitrary image path and import annotations never look up `profile-sources`.
- For `kind: "initial"`, require `batchId`, `initialSide`, and `batchOwnerToken`. Before spawning a worker, run `npm run agent:next -- --wait-ms 30000 --batch <batchId> --owner-token <batchOwnerToken>` to claim or inspect the other side. An ordinary `agent:next` call cannot claim that owner's pending partner. If no partner JSON is printed, spawn nothing. Keep repeating this owned batch command with the same batch ID, owner token, and 30000 ms wait until partner or terminal JSON appears, or until the user stops the runner. Do not return to ordinary polling while an owned initial partner is pending. For a new pair, start exactly two fresh subagents in parallel only after both unfinished sides are available. If batch inspection returns the other side with `terminalStatus: "completed"` or `"failed"`, do not spawn a worker for that terminal side; start one fresh worker for the claimed unfinished side only.
- For `kind: "refill-batch"`, require a non-empty `jobs` array of at most `workerLimit` entries and require every entry to have `kind: "refill"`. Spawn exactly one fresh native image-generation worker per entry, together in parallel. Give each worker only its complete job JSON and its own work directory. Never combine refill prompts or images. Complete or fail every claimed refill independently even if a sibling worker fails, then return to waiting.

Resolve the data root as `${LOCAL_DATA_DIR:-.local-data}`. Create `<data-root>/agent-work/<jobId>/` for each worker. Have the worker save its native image-generation output as `image.png` and its strict proposal JSON as `proposal.json` there. Do not pass proposal JSON or failure text directly as command-line arguments.

For a source-profile or leaderboard-profile job, create the same work directory and have the worker save only `profile.json`. For an import-annotation job, create the same work directory and have the worker save only `annotation.json`. `profile-sources` contains only private analysis copies for source-profile, leaderboard-profile, and prompt-card-writer jobs; import annotations use their canonical assets path above. For a prompt-card editor job, have the worker save only `suggestions.json`. For a prompt-card blender or writer job, have the worker save only `suggestion.json`. Do not pass analysis JSON directly as a command-line argument.

Give each worker the complete job JSON and these constraints:

- Treat `preferenceSeed` as the authoritative creative brief. The proposal, visual prompt, and generated image must satisfy every explicit subject, count, medium, style, palette, content-level, and avoidance constraint it contains. Do not replace its requested subject with a metaphor, adjacent theme, or novel concept from prior rounds.
- When `promptCard` is present, use its concise prompt as the selected archetype or style direction and honor its `negativePrompt` in addition to the profile's Avoid field. The explicit `preferenceSeed` remains authoritative when the card and profile differ. Do not invent a different card, and do not copy card IDs or metadata into visible image text.
- Read `preferenceProfile.adaptationMode` and `preferenceProfile.adaptationStrength` when present. Legacy jobs without a structured profile are Frozen; legacy Adaptive jobs without a strength are Guided. For Frozen jobs, omit `preferenceRevision` and do not mutate any preference field. For Guided and Unfettered jobs, write a complete `preferenceRevision` whose primary taste evidence is `leaderboardEvidence`, strengthened by `leaderboardVisualProfile` when present: favor transferable qualities that persist among high-ranked candidates with repeated wins and strong Elo, and steer away from qualities concentrated among repeatedly losing low-ranked candidates. Guided revisions must be restrained and incremental across the full profile: preserve explicit user intent and constraints, and change wording only where leaderboard evidence clearly supports it. Unfettered revisions may broadly rewrite every field when the leaderboard supports a new direction. Treat the cached visual profile as a synthesis of the exact current top cohort, weighted by the numeric rank evidence, not as permission to copy any source or overwrite explicit safety constraints. Rank, win/loss record, repeated performance, favorites, and the matching visual synthesis outweigh the retained winner or latest decision. The evidence is a bounded top-and-bottom sample of the current pool; do not infer that omitted middle ranks are negative. Use retained/rejected candidates and `selectionHistory` only as short-term novelty context or a tie-breaker when aggregate evidence is sparse. `adaptationSourceWinnerIds` and `adaptationSourceRejectedIds` identify outcomes already incorporated as provenance, not stronger evidence than the leaderboard. The revision must include `themes`, `inspiration`, `mediaTypes`, `visualStyle`, `colorPalette`, `contentLevel`, and `avoid`, but never adaptation metadata or source IDs. Keep it concise and describe transferable preferences rather than a person's identity or likeness.
- When a refill job has `comparisonOutcome: "tie"`, treat its `retainedWinner`, `rejectedCandidate`, and latest tie history entry as neutral context. A tie must not supply positive or negative preference evidence, even though the compatibility fields still identify the lower-rated reference candidate and the other tied candidate.
- When a refill job has `comparisonOutcome: "both-lose"`, treat both candidates in the latest history entry as negative preference evidence. The `retainedWinner` compatibility field is not a winner in this outcome; avoid both rejected concepts while remaining inside the preference seed.
- Retained-winner metadata, rejected-candidate metadata, history, and recent concepts are secondary. Use them only to choose a novel treatment that remains inside the preference seed; when they conflict, the preference seed wins.
- Use the retained winner only as preference evidence. Do not modify it or generate a variation/edit of its image.
- Avoid the rejected concept and recent concepts unless a genuinely different treatment is essential.
- Produce exactly one standalone square PNG through native image generation, fully decoded and saved to a local path.
- Write a strict proposal object with required `concept`, `visualPrompt`, `styleTags`, and `reasoningSummary` fields plus `preferenceRevision` only for a Guided or Unfettered job. In `reasoningSummary`, state how the proposal follows the preference seed, responds to aggregate leaderboard evidence at the selected freedom level, and remains distinct from recent work, then return both work-file paths.

For a source-profile worker instead:

- Inspect the exact local PNG resolved as `<data-root>/<sourceImage.path>`; do not generate or edit an image.
- Write `profile.json` with exactly `profile` and `reasoningSummary`. `profile` contains `themes`, `inspiration`, `mediaTypes`, `visualStyle`, `colorPalette`, `contentLevel`, and `avoid` under the same limits as the Preference modal. Themes must contain at least 20 characters.
- Describe the depicted subject matter, setting, composition, medium, lighting, mood, palette, and useful constraints as transferable generation guidance. Never name or identify a depicted person, infer sensitive personal traits, request facial identity or likeness, or ask future workers to reproduce the source exactly. Add identity, logo, readable-text, or exact-copy exclusions when relevant.
- Choose `adult-allowed` only when the depicted themes materially require mature non-explicit treatment; otherwise use `family-friendly`. The result remains an editable draft and is never auto-saved.

For a leaderboard-profile worker instead:

- Inspect every exact local PNG in `sources` together; do not generate, edit, rank, or copy an image.
- Write `profile.json` with the same exact `profile` and `reasoningSummary` schema as a source-profile job.
- Synthesize recurring subject relationships, composition, scale, lighting, mood, medium, visual style, and palette across the cohort. Weight higher ranks, repeated wins, Elo, and favorites more strongly, but report only qualities visibly supported across the set rather than overfitting one leader.
- Describe transferable visual evidence for future Adaptive revisions. Preserve source identity immutability; never identify a depicted person, infer sensitive traits, request identity or likeness, or ask for exact reproduction. The result is an internal cached digest and never directly overwrites the user's profile.

For an import-annotation worker instead:

- Inspect exactly the normalized local PNG addressed by the job asset; do not generate, edit, copy, upload, or publish image bytes.
- Write `annotation.json` with exactly `concept`, `prompt`, `style`, `reasoningSummary`, and `source`. Strings and every style tag must be trimmed and nonempty; `style` contains one through eight unique short tags. Set `source` to `automated`.
- Keep `prompt` factual and display-safe. Never identify a person, infer sensitive traits, expose readable private text, or request identity, likeness, exact copying, or reproduction.

For a prompt-card editor worker instead:

- Treat the supplied card as immutable source material and the recent rejection reasons as bounded evidence, not permission to change the user's overall Preference profile.
- Write `suggestions.json` with exactly `proposals`, an array of exactly two objects. Each object contains `title`, `prompt`, `negativePrompt`, `tags`, and `reasoningSummary` under the same card limits. Keep each prompt concise and coherent, preserve the intended vibe, and address the repeated rejection evidence through meaningfully different treatments.
- Never overwrite or archive the source card, invent identity or likeness instructions, or generate an image. Both alternatives remain inactive proposals until the user accepts one as a new immutable child card.

For a prompt-card blender worker instead:

- Treat both supplied cards as immutable source material. Blend their compatible creative directions according to `ratio`, where the first card receives that share of influence and the second receives the remainder. Do not change the user's overall Preference profile.
- Write `suggestion.json` with exactly `proposal`, an object containing `title`, `prompt`, `negativePrompt`, `tags`, and `reasoningSummary` under the normal card limits. Produce one concise, coherent direction rather than concatenating contradictory clauses; combine applicable negatives and tags without duplication.
- Never overwrite or archive either parent, invent identity or likeness instructions, or generate an image. The blend remains an inactive proposal until the user accepts it as a new immutable child with both parent IDs.

For a prompt-card writer worker instead:

- Inspect every exact local PNG in `sources` together; do not generate, edit, rank, or copy an image.
- Extract only visibly shared, transferable subject relationships, composition, scale, lighting, mood, medium, material, style, and palette. Produce one coherent new direction rather than an exact reproduction or collage.
- Write `suggestion.json` with exactly `proposal`, using the same `title`, `prompt`, `negativePrompt`, `tags`, and `reasoningSummary` limits as a blender proposal. State which shared qualities support the proposal and how it remains distinct from every source.
- Never identify a depicted person, infer sensitive traits, request identity or likeness, reproduce readable text or logos, or generate an image. The selected generated favorites remain immutable; the proposal remains inactive until the user accepts it as a new card with all source candidate IDs.

For each claimed candidate-generation job (including every entry in a refill batch):

1. Record `npm run agent:heartbeat -- --status generating --job <id>`.
2. Delegate to a fresh worker and inspect its proposal and image path. Reject the handoff if its proposal or visible image contradicts an explicit preference-seed constraint; ask that worker to revise or regenerate, and fail the job rather than publish an out-of-brief result if it cannot comply.
3. Complete with `npm run agent:complete -- --job <id> --proposal-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/proposal.json" --image "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/image.png"`. Let the helper validate the PNG, name it from its exact SHA-256 content digest, and publish immutable copies to local asset storage and `output/artifacts`; never copy it manually over an existing asset.
4. If generation or validation cannot complete, write a concise reason to `<data-root>/agent-work/<id>/failure.txt`, then run `npm run agent:fail -- --job <id> --message-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/failure.txt" --category <category>`. Use `moderation` only for a provider safety or moderation block, `invalid-output` for an unusable worker handoff, and `operational` for interruptions or other infrastructure failures. Failures are retryable.
5. Record the terminal outcome. For a refill batch, wait until every claimed entry has independently reached `completed` or `failed`. Return the heartbeat to `waiting`, and continue the loop.

For each claimed source-profile or leaderboard-profile job:

1. Record `npm run agent:heartbeat -- --status analyzing --job <id>`.
2. Delegate to one fresh worker of the matching analysis kind and inspect its `profile.json`. Reject identity/likeness instructions, missing fields, or out-of-bounds values; ask the same worker to revise once, then fail invalid output if it cannot comply.
3. Complete with `npm run agent:complete-profile -- --job <id> --profile-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/profile.json"`.
4. On failure, use the same file-backed `agent:fail` command and categories as generation jobs. Return the heartbeat to `waiting` and continue the loop.

For each claimed import-annotation batch entry:

1. Record `npm run agent:heartbeat -- --status analyzing --job <id>`.
2. Delegate to its fresh import-annotation worker, inspect its `annotation.json`, and reject missing fields, invalid tags, image bytes, identity/likeness instructions, or private readable text. Ask that worker to revise once, then fail invalid output if it cannot comply.
3. Complete independently with `npm run agent:complete-import-annotation -- --job <id> --annotation-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/annotation.json"`. The helper forces `source: "automated"` and publishes only metadata.
4. On failure, use the same file-backed `agent:fail` command and categories as generation jobs. Wait until every entry reaches a terminal outcome, return the heartbeat to `waiting`, and continue polling.

For each claimed prompt-card editor job:

1. Record `npm run agent:heartbeat -- --status analyzing --job <id>`.
2. Delegate to one fresh prompt-card editor worker and inspect its `suggestions.json`. Require exactly two valid, distinct proposals that preserve the source intent and respond to the rejection evidence; ask the same worker to revise once, then fail invalid output if it cannot comply.
3. Complete with `npm run agent:complete-card-editor -- --job <id> --suggestions-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/suggestions.json"`.
4. On failure, use the same file-backed `agent:fail` command and categories as generation jobs. Return the heartbeat to `waiting` and continue the loop.

For each claimed prompt-card blender job:

1. Record `npm run agent:heartbeat -- --status analyzing --job <id>`.
2. Delegate to one fresh prompt-card blender worker and inspect its `suggestion.json`. Require one valid, coherent proposal honoring both parents and the requested ratio; ask the same worker to revise once, then fail invalid output if it cannot comply.
3. Complete with `npm run agent:complete-card-blender -- --job <id> --suggestion-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/suggestion.json"`.
4. On failure, use the same file-backed `agent:fail` command and categories as generation jobs. Return the heartbeat to `waiting` and continue the loop.

For each claimed prompt-card writer job:

1. Record `npm run agent:heartbeat -- --status analyzing --job <id>`.
2. Delegate to one fresh prompt-card writer worker and inspect its `suggestion.json`. Require one valid, coherent proposal visibly grounded in qualities shared by the three through five immutable sources; ask the same worker to revise once, then fail invalid output if it cannot comply.
3. Complete with `npm run agent:complete-card-writer -- --job <id> --suggestion-file "${LOCAL_DATA_DIR:-.local-data}/agent-work/<id>/suggestion.json"`.
4. On failure, use the same file-backed `agent:fail` command and categories as generation jobs. Return the heartbeat to `waiting` and continue the loop.

Do not exit after a successful or failed job. The mailbox is durable: startup `--resume` recovers unterminated active work, matching outcome retries safely continue after interruption, and terminal artifacts remain until the app reconciles and archives them.
