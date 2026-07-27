import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import {
  preferenceProfileFromSeed,
  type Candidate,
  type GameState,
} from "@/domain/game";

export const DEFAULT_PREFERENCE_SEED = `Favor genuine novelty informed by gothic and industrial aesthetics; science fiction and retrofuturism; Pacific Northwest landscapes; engineering, fabrication, chemistry, computers, and 3D printing; foxes, mushrooms, strange ecosystems, and mythic imagery; metal and industrial music aesthetics; confident, highly competent adult characters; dark purple, ultraviolet, oxblood, copper, black, and cinematic blue palettes; and occasional warmth, humor, or parent-child wonder. These are inspiration, not a checklist.`;

const MANIFEST_PATH = join(
  /* turbopackIgnore: true */ process.cwd(),
  "public",
  "seed-assets",
  "manifest.json",
);

const curatedCandidateSchema = z
  .object({
    id: z.string().regex(/^seed-[a-z0-9]+(?:-[a-z0-9]+)*$/),
    file: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\.png$/),
    prompt: z.string().min(1),
    concept: z.string().min(1),
    style: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const curatedManifestSchema = z
  .object({
    candidates: z
      .array(curatedCandidateSchema)
      .length(5, "Manifest must contain exactly five curated candidates"),
  })
  .strict()
  .superRefine(({ candidates }, context) => {
    if (new Set(candidates.map(({ id }) => id)).size !== candidates.length) {
      context.addIssue({
        code: "custom",
        message: "Manifest must contain unique candidate IDs",
        path: ["candidates"],
      });
    }
    if (
      new Set(candidates.map(({ file }) => file)).size !== candidates.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Manifest must contain unique PNG files",
        path: ["candidates"],
      });
    }
  });

async function verifySeedPng({ file }: { file: string }): Promise<void> {
  const path = join(
    /* turbopackIgnore: true */ process.cwd(),
    "public",
    "seed-assets",
    file,
  );
  try {
    const image = sharp(await readFile(path), {
      failOn: "error",
      limitInputPixels: 4096 * 4096,
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== "png" ||
      !metadata.width ||
      metadata.width !== metadata.height
    ) {
      throw new Error(
        `expected a square PNG, received ${metadata.format ?? "unknown"} ${metadata.width ?? "unknown"}x${metadata.height ?? "unknown"}`,
      );
    }
    await image.raw().toBuffer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid curated seed asset ${file}: ${message}`);
  }
}

export async function loadCuratedCandidates(now: string): Promise<Candidate[]> {
  const manifest = curatedManifestSchema.parse(
    JSON.parse(await readFile(MANIFEST_PATH, "utf8")),
  );
  await Promise.all(manifest.candidates.map(verifySeedPng));
  return manifest.candidates.map(({ file, ...candidate }) => ({
    ...candidate,
    imageUrl: `/seed-assets/${file}`,
    createdAt: now,
    winCount: 0,
  }));
}

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
    preferenceProfile: preferenceProfileFromSeed(DEFAULT_PREFERENCE_SEED),
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
