# Security

## Supported versions

Security fixes target the current `main` branch and the latest tagged release.

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |
| 0.9.x   | No        |

## Local trust boundary

Diptych Picker is designed for one user on one machine:

- `run-only` and `demo-only` bind the server to `127.0.0.1`.
- API requests reject non-loopback hostnames to limit DNS-rebinding attacks.
- Browser requests that change state must be same-origin.
- The app has no accounts, remote authorization layer, or multi-user isolation.
- Game state, uploaded analysis sources, generated images, prompts, and mailbox
  records remain under the configured local data directory.
- Codex authentication and model execution stay in the Codex CLI. The web app
  neither accepts nor stores an OpenAI API key.

Do not expose the server through a tunnel, reverse proxy, container port, or LAN
binding without adding authentication, transport security, and an explicit
remote deployment threat model.

## Reporting a vulnerability

Use the repository's private GitHub security-advisory form when available.
Include the affected commit or version, reproduction steps, impact, and any
suggested mitigation. Do not place secrets, private images, prompts, or local
data in a public issue.
