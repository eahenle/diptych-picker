# Diptych Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a local-first two-image preference game whose winner asset never changes.

**Architecture:** Next.js App Router serves a client comparison surface and server route handlers. Pure round transitions, provider interfaces, JSON persistence, and immutable local assets keep behavior testable and storage/model implementations replaceable.

**Tech Stack:** Next.js, React, TypeScript, CSS Modules, OpenAI Node SDK, Zod, Vitest, Playwright.

## Global Constraints

- Candidate A and B are separate assets rendered by exactly two separate `<img>` elements.
- Never edit, clone, regenerate, move, or reload the retained winner.
- Keep API keys server-side and model names environment-configurable.
- Automated tests run only in deterministic mock mode.
- Do not commit, push, deploy, or open a pull request.

---

### Task 1: Domain transitions and persistence

**Files:** `src/domain/game.ts`, `src/domain/game.test.ts`, `src/server/repository.ts`, `src/server/repository.test.ts`

- [ ] Write tests for side-specific retention, duplicate-selection rejection, failure preservation, JSON restore, and recent concept collection.
- [ ] Run the tests and confirm failures are caused by missing behavior.
- [ ] Implement focused types, transition helpers, and repository interfaces.
- [ ] Re-run the tests to green.

### Task 2: Challenger providers and game service

**Files:** `src/server/providers.ts`, `src/server/game-service.ts`, `src/server/game-service.test.ts`, `src/server/storage.ts`

- [ ] Write tests proving provider input includes winner, rejected candidate, history, recent concepts, and preference seed.
- [ ] Implement deterministic mock and OpenAI providers plus immutable local storage.
- [ ] Persist `generating` before provider calls and retain candidates on errors.
- [ ] Re-run the focused and full unit suites.

### Task 3: Route handlers and image-first UI

**Files:** `src/app/**`, `src/components/**`

- [ ] Implement game/start/select/asset routes with mock-default provider wiring.
- [ ] Build the two-card client with stable keyed winner elements, keyboard controls, loser-only loading, preload-before-swap, retry, metrics, and confirmed new game.
- [ ] Style the desktop and narrow horizontal rail to match the approved concept.

### Task 4: Acceptance tests, docs, and QA

**Files:** `tests/diptych-picker.spec.ts`, `.env.example`, `README.md`, `playwright.config.ts`

- [ ] Test exactly two independent images, desktop/mobile side-by-side geometry, both selection directions, loser-only loading, winner URL/node stability, refresh persistence, and no duplicate requests.
- [ ] Document mock/real setup, provider models, seeds, storage, and commands.
- [ ] Run format, lint, unit, production build, Playwright, and headed visual checks.
- [ ] Compare screenshots to the concept with `view_image`, fix discrepancies, and record the fidelity ledger.
