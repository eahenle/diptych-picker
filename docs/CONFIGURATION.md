# Configuration

Diptych Picker reads environment variables when the server starts. Put local
overrides in `.env.local` or prefix the launch command.

## Runtime variables

| Variable                              | Default                         | Purpose                                                                                                    |
| ------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `PORT`                                | `3000`                          | Loopback HTTP port selected by Next.js.                                                                    |
| `LOCAL_DATA_DIR`                      | `.local-data`                   | State, mailbox, private normalized sources, and immutable generated assets.                                |
| `GENERATION_PROVIDER`                 | `agent` in production launchers | `agent` uses the durable external mailbox; `mock` is allowed only for tests and the explicit offline demo. |
| `GENERATE_INITIAL_CANDIDATES`         | `false`                         | Generate both initial images instead of using the five tracked seeds.                                      |
| `CHALLENGER_BUFFER_SIZE`              | `5`                             | Default ready-queue target; valid effective range 1–10.                                                    |
| `CANDIDATE_POOL_SIZE`                 | `50`                            | Default reusable-pool capacity; valid effective range 2–50.                                                |
| `CHALLENGER_INITIAL_TURNAROUND_MS`    | `300000`                        | Initial generation-turnaround estimate used by health and fallback planning.                               |
| `CHALLENGER_FALLBACK_DELAY_MS`        | `3000`                          | Delay before a depleted queue can draw from the local pool.                                                |
| `CHALLENGER_FALLBACK_MAX_CONSECUTIVE` | `10`                            | Default consecutive local-pool fallback limit; valid effective range 1–50.                                 |
| `MOCK_GENERATION_DELAY_MS`            | `650`                           | Deterministic mock-worker delay used by tests and the offline demo.                                        |

`GENERATION_PROVIDER=mock` alone is not sufficient to run a production mock
server. The `demo-only` launcher supplies the explicit offline-demo safety flag.

## Launcher variables

| Variable                | Default            | Purpose                                                     |
| ----------------------- | ------------------ | ----------------------------------------------------------- |
| `DIPTYCH_CODEX_THREADS` | `8`                | Total threads requested by `npm run codex:play`; minimum 5. |
| `DIPTYCH_DEMO_DATA_DIR` | `.local-data/demo` | Isolated state used by `npm run demo`.                      |

## Optional co-proc variables

These settings enable the experimental notification transport. The durable
mailbox remains the fallback.

| Variable                              | Default         | Purpose                                                |
| ------------------------------------- | --------------- | ------------------------------------------------------ |
| `CO_PROC_GENERATION_CHANNELS`         | unset           | Comma-separated ready channel names.                   |
| `CO_PROC_GENERATION_CHANNEL`          | unset           | Legacy single-channel form.                            |
| `CO_PROC_GENERATION_READY_TIMEOUT_MS` | `100`           | Wait for a ready frame.                                |
| `CO_PROC_GENERATION_ACK_TIMEOUT_MS`   | `500`           | Wait for a correlated durable-claim acknowledgement.   |
| `CO_PROC_GENERATION_LEASE_MS`         | `120000`        | Renewable lease duration; valid range 10000–600000 ms. |
| `CO_PROC_RUNTIME_ROOT`                | co-proc default | Override only for a non-default co-proc runtime root.  |

## Per-game overrides

The Preferences modal stores a complete rule snapshot in the current game:

- queue target 1–10;
- pool capacity 2–50;
- champion streak 2–50;
- fallback limit 1–50.

Per-game values override environment defaults and survive export/import.
Starting fresh restores the environment-configured defaults.

## Example configurations

- [Agent mode](../examples/configurations/agent.env.example)
- [Generated initial pair](../examples/configurations/generated-initial-pair.env.example)
- [Experimental co-proc channels](../examples/configurations/co-proc.env.example)

Do not commit `.env.local`, credentials, private paths, or local data.
