function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

export const challengerConfig = {
  bufferTarget: numberFromEnv("CHALLENGER_BUFFER_SIZE", 5),
  poolMaximum: numberFromEnv("CANDIDATE_POOL_SIZE", 50),
  initialRating: 1000,
  eloKFactor: 32,
  turnaroundEmaAlpha: 0.25,
  initialTurnaroundMs: 300_000,
  fallbackMinimumMs: 30_000,
  fallbackMaximumMs: 300_000,
  fallbackMaximumConsecutive: 2,
} as const;
