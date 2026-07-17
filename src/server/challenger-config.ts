function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function integerFromEnv(name: string, fallback: number): number {
  const value = numberFromEnv(name, fallback);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

const fallbackMinimumMs = numberFromEnv("CHALLENGER_FALLBACK_MIN_MS", 30_000);
const fallbackMaximumMs = numberFromEnv("CHALLENGER_FALLBACK_MAX_MS", 300_000);
if (fallbackMaximumMs < fallbackMinimumMs) {
  throw new Error(
    "CHALLENGER_FALLBACK_MAX_MS must be greater than or equal to CHALLENGER_FALLBACK_MIN_MS",
  );
}

export const challengerConfig = {
  bufferTarget: numberFromEnv("CHALLENGER_BUFFER_SIZE", 5),
  poolMaximum: numberFromEnv("CANDIDATE_POOL_SIZE", 50),
  initialRating: 1000,
  eloKFactor: 32,
  turnaroundEmaAlpha: 0.25,
  initialTurnaroundMs: numberFromEnv(
    "CHALLENGER_INITIAL_TURNAROUND_MS",
    300_000,
  ),
  fallbackMinimumMs,
  fallbackMaximumMs,
  fallbackMaximumConsecutive: integerFromEnv(
    "CHALLENGER_FALLBACK_MAX_CONSECUTIVE",
    2,
  ),
} as const;
