# Data and recovery

Diptych Picker keeps game data on the local machine. The default root is
`.local-data`; set `LOCAL_DATA_DIR` to isolate another game.

## Directory layout

| Path                     | Contents                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `game-state.json`        | Current round, history, preferences, rules, prompt deck, and save metadata.                           |
| `challenger-state.json`  | Ready queue, refill receipts, Elo ratings, pool membership, favorites, and turnaround/fallback state. |
| `initial-bootstrap.json` | Restart-safe generated-initial-pair ownership.                                                        |
| `agent-mailbox/`         | Pending, active, outcome, terminal-result, heartbeat, and tombstone records.                          |
| `agent-work/`            | Per-job worker handoffs and failure details.                                                          |
| `assets/`                | Immutable generated PNGs named by SHA-256.                                                            |
| `profile-sources/`       | Private normalized source images used for analysis.                                                   |

`output/artifacts/` is separate, git-ignored, and intended for discoverable
exports. It receives content-addressed generated PNGs and exported game JSON.

## Crash and restart behavior

Game and challenger writes are atomic. The fixed lock order is game first,
challenger second. Mailbox claims and terminal outcomes use their own atomic
ownership boundaries.

After an interrupted agent session:

```bash
npm run codex:play
```

The monitor resumes unfinished work before claiming new jobs. A completed job
is reconciled from its terminal record and is not regenerated. An expired
experimental co-proc lease returns to ordinary mailbox recovery.

## Export versus filesystem backup

Use **Export** for a portable, validated game document. It contains the current
round, history, profile, rules, prompt deck, queue, ratings, favorites, and pool
membership. It deliberately excludes in-flight job IDs.

A save still references immutable local image URLs. To move a game to another
checkout, copy the referenced `.local-data/assets/` files as well as the JSON.
Restore refuses a save whose required local image is missing or invalid.

For a complete same-machine backup:

1. pause new monitor claims;
2. let active workers publish terminal results when practical;
3. stop the app;
4. copy the configured local-data directory and `output/artifacts/`;
5. restart and verify `/api/game`.

## Starting fresh

**New game → Start fresh** clears the active round, history, preference
profile, rules override, and prompt deck for the new session. Learned ratings
and immutable generated images remain available.

To create a completely isolated game without deleting prior data:

```bash
LOCAL_DATA_DIR=.local-data/clean-room npm run run:production
```

Use a separate terminal/port if another server is already running.

## Privacy

Do not publish or attach `.local-data` wholesale. It can contain:

- user-entered prompts and preference history;
- private uploaded source images;
- generated images;
- detailed mailbox job context;
- complete local save state.

Public leaderboard, history, and favorites APIs intentionally omit prompts and
mailbox details. Source analysis never uploads through the web server to a
remote service; the interactive agent receives only the local normalized file
needed for its assigned job.

## Recovery checks

```bash
curl -sS http://127.0.0.1:3000/api/game/health
curl -sS -D - http://127.0.0.1:3000/api/game -o /dev/null
```

In agent mode the second response must include
`X-Diptych-Generation-Provider: agent`.
