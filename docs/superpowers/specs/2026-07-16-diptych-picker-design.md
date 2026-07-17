# Diptych Picker design

Diptych Picker is a local-first, image-led tournament. Two independent square `<img>` assets remain side by side at every viewport. Selecting either side retains that exact candidate object and asset on the same side; the opposing card alone enters a loading state and receives one new immutable challenger after browser preload.

The visual system follows `diptych-picker-concept.png`: near-black gallery canvas, cool charcoal surfaces, fine copper and ultraviolet accents, an editorial serif title, compact uppercase metrics, and minimal chrome. A horizontal comparison rail preserves the two-up layout on narrow screens.

The Next.js server owns generation and persistence. `ChallengerPromptProvider`, `ImageProvider`, `AssetStore`, and `GameRepository` interfaces separate model calls, immutable asset storage, and JSON state. Mock mode is deterministic and never calls an external API. OpenAI mode uses server-only environment variables, structured prompt output, one standalone Image API generation, and local immutable assets.

Selection writes a `generating` round before invoking providers, preventing duplicate generations. Failures retain both existing candidates and persist an error/retry state. Recent history and concept windows are supplied to every prompt proposal. Seed PNGs initialize the first game; removing them exposes the generate-first start screen.
