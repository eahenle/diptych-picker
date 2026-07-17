# Persistent Codex Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Do not commit: the user explicitly requires all changes to remain uncommitted.

**Goal:** Make the Codex CLI session opened in this repository the persistent AI backend for the preference game, with the web app exchanging durable jobs with a repo-local runner skill.

**Architecture:** The Next.js server owns game state and writes immutable generation requests into a gitignored filesystem mailbox. A persistent Codex coordinator discovers the repo-local skill, starts the app, waits for jobs, delegates native image generation to subagents, and completes jobs through validated helper scripts. The browser polls game state while a job is pending and swaps only the losing image after the server atomically reconciles a completion.

**Tech Stack:** Next.js App Router, TypeScript, JSON filesystem persistence, Node helper scripts, Zod, Sharp, Vitest, Playwright, Codex repo skills and subagents.

## Global Constraints

- Never launch `codex`, `codex exec`, or any model/API process from the web server.
- The persistent interactive Codex CLI session is the only real generation coordinator.
- Native image generation uses the coordinator or delegated subagents, never a process fallback.
- A and B remain separate immutable image assets rendered by two `<img>` elements.
- A selected winner retains its exact candidate object identity, ID, URL, bytes, dimensions, metadata, DOM node, and side.
- Automated tests use deterministic mock completions and make no model or API calls.
- Keep all credentials out of the app and repository; no OpenAI API key is required.
- Do not commit, push, deploy, or open a pull request.

---

### Task 1: Durable mailbox protocol

**Files:**

- Create: `src/server/agent-mailbox.ts`
- Create: `src/server/agent-mailbox.test.ts`
- Modify: `src/domain/game.ts`

**Interfaces:**

- Produces: `GenerationJob`, `GenerationResult`, `GenerationMailbox`, and `FileGenerationMailbox`.
- `enqueue(job): Promise<void>` creates one pending job with exclusive file creation.
- `readResult(jobId): Promise<GenerationResult | null>` reads a completed or failed result without calling a model.
- `archive(jobId): Promise<void>` removes terminal mailbox artifacts after state reconciliation.
- `PendingSelection.generationJobId` binds a persisted round to exactly one job.

- [ ] Write tests that enqueue one job, reject a duplicate ID, restore pending work after a new mailbox instance, read success/failure results, and archive terminal files.
- [ ] Run `npm test -- src/server/agent-mailbox.test.ts` and verify the missing module/API causes the expected failure.
- [ ] Implement the mailbox with atomic temporary-file rename, exclusive pending-job creation, Zod validation, and directories under `.local-data/agent-mailbox`.
- [ ] Add `generationJobId` to the pending selection state and keep winner-preserving domain transitions unchanged.
- [ ] Re-run the focused test and the domain tests until green.

### Task 2: Asynchronous game reconciliation

**Files:**

- Modify: `src/server/game-service.ts`
- Modify: `src/server/game-service.test.ts`
- Modify: `src/server/runtime.ts`
- Modify: `src/app/api/game/select/route.ts`
- Delete: `src/server/codex-cli.ts`
- Delete: `src/server/codex-cli.test.ts`
- Delete: `src/server/provider-config.ts`
- Delete: `src/server/provider-config.test.ts`

**Interfaces:**

- `select(winnerSide, expectedRoundNumber)` persists the generating state and enqueues exactly one job, then returns immediately.
- `reconcile()` consumes a matching terminal result, saves an immutable asset, completes or fails the round, and archives the job.
- The selection request contains retained winner metadata, rejected candidate metadata, recent selection history, recent concepts, and the editable preference seed.

- [ ] Replace service tests with failing async-job tests proving A and B preservation, one enqueue on double selection, failure preservation, refresh/reconcile behavior, recent-concept delivery, and rejection of a result for another job.
- [ ] Run the focused service tests and verify they fail because the service still invokes providers synchronously.
- [ ] Implement enqueue-and-return plus idempotent reconciliation.
- [ ] Wire `GET /api/game` through reconciliation and remove every runtime import/reference to the subprocess backend.
- [ ] Delete the obsolete CLI/provider configuration implementation and run all unit tests.

### Task 3: Browser polling and deterministic mock worker

**Files:**

- Modify: `src/components/game-screen.tsx`
- Create: `src/server/mock-agent.ts`
- Modify: `src/server/mock-providers.ts`
- Modify: `tests/diptych-picker.spec.ts`
- Modify: `playwright.config.ts`

**Interfaces:**

- While `round.status === "generating"`, the browser polls `GET /api/game` without replacing either existing candidate.
- A terminal success is preloaded before `mergeServerResult` swaps only the loser.
- Mock mode schedules deterministic mailbox completions in-process and is never enabled by the production runner skill.

- [ ] Add a failing Playwright assertion that the selection POST returns while the loser remains loading until a later poll completes the job.
- [ ] Add unit coverage for one deterministic mock completion per job.
- [ ] Implement bounded polling with cleanup on unmount/new game and preserve the winner node reference through completion.
- [ ] Run the affected Vitest and Playwright tests until green.

### Task 4: Repo-local persistent runner skill

**Files:**

- Create: `.agents/skills/run-diptych-picker/SKILL.md`
- Create: `.agents/skills/run-diptych-picker/agents/openai.yaml`
- Create: `.agents/skills/run-diptych-picker/references/job-protocol.md`
- Create: `.agents/skills/run-diptych-picker/scripts/next-job.mjs`
- Create: `.agents/skills/run-diptych-picker/scripts/complete-job.mjs`
- Create: `.agents/skills/run-diptych-picker/scripts/fail-job.mjs`
- Create: `.agents/skills/run-diptych-picker/scripts/heartbeat.mjs`
- Create: `tests/agent-scripts.test.ts`
- Modify: `package.json`

**Interfaces:**

- `npm run agent:next -- --wait-ms 30000` atomically claims one pending job and prints its JSON.
- `npm run agent:complete -- --job <id> --proposal <json> --image <png>` validates structured proposal fields and a standalone square PNG, copies it into immutable local asset storage, and writes a success result.
- `npm run agent:fail -- --job <id> --message <text>` writes a retryable terminal failure.
- The skill starts the app, remains active, polls in waits no longer than 30 seconds, delegates initial candidates in parallel and each challenger to a fresh image-generation subagent, validates results, reports status, and continues until the user stops it.

- [ ] Use `init_skill.py` to initialize the repo-scoped skill under `.agents/skills`.
- [ ] Write failing script tests for atomic claim, square-PNG validation, immutable asset creation, terminal success, failure, and heartbeat state.
- [ ] Implement the helper scripts without invoking Codex or any external API.
- [ ] Write the concise skill and protocol reference, explicitly forbidding diptychs, winner editing, and `codex exec`.
- [ ] Validate with `quick_validate.py`, confirm discovery with `codex debug prompt-input`, and forward-test the skill using a fresh subagent.

### Task 5: Configuration, documentation, and full verification

**Files:**

- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `README.md`

**Interfaces:**

- Startup is `codex` from the repository root followed by implicit or explicit use of `$run-diptych-picker`.
- Environment variables configure only the local data directory, web server, and deterministic mock timing; model selection belongs to the active CLI session.

- [ ] Remove obsolete CLI model/path/reasoning/timeout environment variables and document the persistent-session lifecycle and offline behavior.
- [ ] Document mailbox/storage paths, seed behavior, retry/recovery, mock mode, and all test commands.
- [ ] Run `npm run format:check`, `npm run lint`, `npm test`, `npm run build`, and `npm run test:e2e`.
- [ ] Start through the repo skill, visually inspect desktop and narrow layouts, and select each side while checking that only the loser asset changes.
- [ ] Search the repository for `codex exec`, `child_process`, OpenAI API keys, combined-image generation, and obsolete provider variables; only prohibitions/documentation may remain.
- [ ] Perform a final whole-change review and resolve all Critical or Important findings without committing.
