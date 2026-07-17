import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Candidate, GameState } from "@/domain/game";

export const DEFAULT_PREFERENCE_SEED = `Favor genuine novelty informed by gothic and industrial aesthetics; science fiction and retrofuturism; Pacific Northwest landscapes; engineering, fabrication, chemistry, computers, and 3D printing; foxes, mushrooms, strange ecosystems, and mythic imagery; metal and industrial music aesthetics; confident, highly competent adult characters; dark purple, ultraviolet, oxblood, copper, black, and cinematic blue palettes; and occasional warmth, humor, or parent-child wonder. These are inspiration, not a checklist.`;

const seedDefinitions: Array<Omit<Candidate, "createdAt"> & { file: string }> =
  [
    {
      id: "seed-coastal-observatory",
      imageUrl: "/seed-assets/coastal-observatory.png",
      prompt: "Pacific Northwest coastal radio observatory at blue hour",
      concept: "Coastal radio observatory",
      style: ["cinematic landscape", "retrofuturism", "Pacific Northwest"],
      winCount: 0,
      file: "coastal-observatory.png",
    },
    {
      id: "seed-crystal-synthesizer",
      imageUrl: "/seed-assets/crystal-synthesizer.png",
      prompt: "Crystalline analog synthesizer scientific still life",
      concept: "Crystal-grown synthesizer",
      style: ["macro photography", "fabrication", "strange ecosystem"],
      winCount: 0,
      file: "crystal-synthesizer.png",
    },
  ];

export async function gameFromSeedAssets(
  now: string,
  forceGenerated = false,
): Promise<GameState | null> {
  if (forceGenerated) return null;
  try {
    await Promise.all(
      seedDefinitions.map((seed) =>
        access(
          join(
            /* turbopackIgnore: true */ process.cwd(),
            "public",
            "seed-assets",
            seed.file,
          ),
        ),
      ),
    );
  } catch {
    return null;
  }

  const [left, right] = initialCandidateContext(now);
  return {
    round: {
      leftCandidate: left,
      rightCandidate: right,
      status: "idle",
      replacingSide: null,
      roundNumber: 1,
      retainedCandidateId: null,
      winStreak: 0,
    },
    history: [],
    preferenceSeed: DEFAULT_PREFERENCE_SEED,
  };
}

export function initialCandidateContext(now: string): [Candidate, Candidate] {
  return seedDefinitions.map((seed) => ({
    id: seed.id,
    imageUrl: seed.imageUrl,
    prompt: seed.prompt,
    concept: seed.concept,
    style: seed.style,
    winCount: seed.winCount,
    createdAt: now,
  })) as [Candidate, Candidate];
}
