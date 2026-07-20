# Co-proc Agent Transport and Prompt Deck

Status: co-proc attachable transport and the opt-in durable-notification adapter
are implemented on feature branches; persistent channel workers and deck state
remain staged follow-ups.

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

Every message includes `version`, `type`, and a correlation `id`. Examples omit `version: 1` for brevity.

```json
{"type":"gen","id":"job-123","prompt":"...","card_id":"card-1"}
{"type":"result","id":"job-123","card_id":"card-1","path":"/absolute/path/image.png"}
{"type":"suggest_edits","id":"edit-1","card_id":"card-1","recent_verdicts":[]}
{"type":"blend","id":"blend-1","a":"card-1","b":"card-2","ratio":0.6}
{"type":"write_from_set","id":"write-1","source_image_ids":["image-1","image-2","image-3"],"style_notes":"..."}
```

Generation results must name a fully decoded standalone square image at an absolute path. The existing immutable asset validation and SHA-256 publication rules remain the terminal acceptance boundary.

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

The Preference profile modal has a top-line **Static / Adaptive** toggle that applies to every preference field. Static is the default and keeps the user's profile out of model mutation. Adaptive permits complete trajectory-conditioned profile revisions and preserves the influencing winner IDs for each change. The current composed profile remains authoritative for the image being generated; an adaptive revision only becomes active after its generated candidate wins.

## Safety and prompt quality

- Cards describe generic archetypes and styles, not a private person's likeness.
- Any real-person avatar requires explicit opt-in and an approval flow.
- Rewrite likeness-tuned cards into generic archetypes before generation.
- Prefer clothing, styling, era, lighting, mood, and pose descriptors over sexualized body phrasing.
- Keep prompts concise and avoid combinations likely to cause inconsistent anatomy or moderation blocks.

## Delivery sequence

1. Extend `co-proc` with attachable, buffered, cross-process IPC and its own tests. Implemented on `feature/attachable-ipc`.
2. Add a Diptych transport adapter behind the existing generation interface while retaining durable job reconciliation. Implemented as an opt-in notification adapter on `feature/co-proc-transport-adapter`.
3. Move generation workers to persistent named channels and remove mailbox polling only after parity tests pass.
4. Add deck persistence, weighted draw, winner updates, verdict tracking, and editor suggestions.
5. Add blend, write-from-set, lineage UI, and winner-driven inspiration controls.
6. Fix export responsiveness during loading and add ten-win champion retirement with focused regression tests.
