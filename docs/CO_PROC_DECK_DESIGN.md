# Co-proc Agent Transport and Prompt Deck

Status: co-proc attachable transport and the opt-in durable-notification adapter
are merged into their repositories' main branches. The Diptych adapter now has
an opt-in ready/acknowledged multi-channel dispatch stage while durable mailbox
claim leases, token-gated terminal publication, and correlated live terminal
signals are staged on top of that pool, with expiry takeover by the mailbox
monitor. Prompt-card persistence, weighted draws, candidate attribution, and
win/reject statistics are implemented, including approval-gated editor
suggestions after repeated card rejections; removing mailbox reconciliation
remains a staged follow-up.

## Objective

Replace the filesystem mailbox control path with low-latency, backpressured NDJSON messaging through the `co-proc` multiplexer. Keep image bytes out of the control plane: messages carry immutable IDs, metadata, and file paths only.

The Next.js app should remain the main loop and authority for game state, deck state, verdicts, lineage, and winner-derived inspiration. This preserves the current restart and save-file boundaries while allowing `co-proc` to specialize in live process transport.

## Current and target flow

Current:

```text
app -> pending job file -> mailbox monitor -> image worker
app <- terminal result file <- mailbox monitor <- image worker
```

Target:

```text
Next.js main/deck authority <-> attachable co-proc channels <-> persistent agent turns
                                      |
                                      +-> gen_a / gen_b
                                      +-> editor_agent
                                      +-> blender_agent
                                      +-> writer_agent
```

The live socket or pipe layer replaces polling, lock files, and outcome-file signaling. Durable app state must still record outstanding job IDs and terminal reconciliation so a process restart can recover safely; transport availability is not durability.

The current parity stage keeps the filesystem as the durability boundary. A
configured pool reserves one ready named channel per concurrent enqueue and
writes the durable job reference before dispatch. The version-2 generation
frame supplies a one-use token; the peer atomically claims the pending file and
creates an owner-only renewable lease before acknowledging. Completion and
failure helpers require that token while the lease is live. Pre-dispatch busy
or unavailable channels can be skipped; an unacknowledged post-dispatch frame
is not sent to a second channel. The mailbox monitor ignores live leases,
revokes expired ones under a per-job lock, and resumes that work through the
normal polling loop. After durable completion or failure, the peer sends a
correlated terminal frame with the same token and exact result path. The app
eagerly validates and ingests that durable result while retaining immutable
terminal files as the restart and recovery authority.

## Co-proc prerequisite

The current `co-proc` registry owns numbered FDs inside one zsh process. Diptych requires an additional attachable mode with per-user endpoints under `/tmp/co-proc/$UID/` (or a secure equivalent beneath `$TMPDIR`). Independent processes and agent turns must be able to discover and attach to a named channel without inheriting the parent shell's FDs.

Required transport properties:

- owner-only runtime directory and endpoint permissions;
- one NDJSON message per line with a versioned envelope;
- continuous `zselect` draining into per-name buffers to avoid a full pipe blocking an unrelated channel;
- explicit `ready`, `busy`, `ack`, `result`, and `error` signals for backpressure and terminal outcomes;
- bounded message size and rejection of malformed or unterminated frames;
- cleanup of stale endpoints only after PID and ownership checks;
- no image bytes or private uploads in messages.

See the companion proposal in the `co-proc` repository: `docs/development/attachable-ipc.md`.

## Protocol

Every message includes `version`, `type`, and a correlation `id`. Readiness
remains version 1 while leased generation dispatch and acknowledgement use
version 2.

```json
{"version":1,"type":"ready","id":"gen_a"}
{"version":2,"type":"gen","id":"job-123","kind":"refill","job_path":"/absolute/mailbox/pending/job-123.json","lease_path":"/absolute/mailbox/leases/job-123.json","lease_token":"uuid","lease_duration_ms":120000}
{"version":2,"type":"ack","id":"job-123","lease_token":"uuid","lease_expires_at":"ISO-8601 timestamp"}
{"version":2,"type":"result","id":"job-123","lease_token":"uuid","status":"completed","result_path":"/absolute/mailbox/completed/job-123.json"}
```

Persistent generation peers publish through the existing file-backed completion
or failure helper with the same lease token. Generation results must name a
fully decoded standalone square image at an absolute path. The existing
immutable asset validation and SHA-256 publication rules remain the terminal
acceptance boundary.

During dispatch staging, a persistent generation peer writes
`{"type":"ready","id":"gen_a"}` before accepting work. The app responds with
the version-2 `gen` frame only after observing readiness. That frame includes
`lease_token`, `lease_path`, and `lease_duration_ms`. The peer runs the durable
claim helper, then confirms the matching token and exact `lease_expires_at` in
its version-2 `ack`. It renews before expiry and passes the token to the
completion or failure helper. Only after that helper has durably published its
strict result does the peer send a version-2 `result` frame with the matching
token, terminal status, and exact normalized path under `completed/` or
`failed/`. The app rejects another token, status directory, job ID, or path,
then eagerly reads the result through the same strict mailbox parser. A missing
or invalid terminal frame never discards the durable result. A peer may report
`busy` before dispatch or an `error` correlated to a job.

## Prompt-card deck

```json
{
  "id": "emo_alt_2008",
  "prompt": "Photorealistic portrait with a 2008 emo and scene aesthetic, realistic lighting, detailed styling, and a natural pose.",
  "negative_prompt": "cartoon, illustration",
  "weight": 1.0,
  "tags": ["alt", "portrait"],
  "parents": [],
  "stats": { "wins": 0, "rejects": 0 }
}
```

Rules:

- Draw cards randomly in proportion to positive `weight`.
- Multiply the selected winner's weight by `1.1` and record the comparison event.
- Keep immutable card revisions. Editor and blend outputs create new cards with parent IDs instead of overwriting their sources.
- Keep blend prompts coherent and under 80 words.
- Store deck, verdict, and lineage changes atomically under app ownership.

## Verdicts and specialized agents

Record verdicts as `{ card_id, result_id, verdict, reason }`. When a card exceeds three rejects inside the configured recent window, send `suggest_edits` to the editor agent. It returns two concise card proposals that preserve the intended vibe while addressing the repeated rejection reason. The developer approves, edits, or discards them before they enter the deck.

The blender agent combines two cards into one prompt and records both parents. The writer agent accepts three to five existing generated image IDs, extracts shared aesthetic properties rather than identity, and returns a new card with source lineage. Private uploads are not eligible sources.

## Winner-driven inspiration

Maintain a separate, editable inspiration profile inferred from winning generated images. It may describe lighting, composition, palette, mood, medium, pose, and concept. It must not encode facial identity or request a doppelganger. Each revision records its influencing winner IDs and can be weakened, reset, or disabled by the player.

The Preference profile modal has a top-line **Frozen / Guided / Unfettered** freedom slider that applies to every preference field. Frozen is the default and keeps the user's profile out of model mutation. Guided permits restrained revisions every 15 completed rounds; Unfettered permits broad revisions every 5. Both adaptive levels preserve the influencing winner IDs for each change. The current composed profile remains authoritative for the image being generated; a revision only becomes active after its generated candidate wins at an eligible checkpoint.

## Safety and prompt quality

- Cards describe generic archetypes and styles, not a private person's likeness.
- Any real-person avatar requires explicit opt-in and an approval flow.
- Rewrite likeness-tuned cards into generic archetypes before generation.
- Prefer clothing, styling, era, lighting, mood, and pose descriptors over sexualized body phrasing.
- Keep prompts concise and avoid combinations likely to cause inconsistent anatomy or moderation blocks.

## Delivery sequence

1. Extend `co-proc` with attachable, buffered, cross-process IPC and its own tests. Merged in `co-proc` PR #4.
2. Add a Diptych transport adapter behind the existing generation interface while retaining durable job reconciliation. Merged in Diptych Picker PR #8 as an opt-in notification adapter.
3. Move generation workers to persistent named channels and remove mailbox
   polling only after parity tests pass. In progress: ready/acknowledged
   multi-channel dispatch, durable renewable claim leases, token-gated outcome
   ownership, expiry takeover, and live terminal-result ingestion are
   implemented. Immutable mailbox results still provide full restart parity
   and fallback reconciliation.
4. Add deck persistence, weighted draw, winner updates, verdict tracking, and editor suggestions. Implemented.
5. Add blend, write-from-set, lineage UI, and winner-driven inspiration controls.
6. Fix export responsiveness during loading and add ten-win champion retirement with focused regression tests.
