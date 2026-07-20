import { describe, expect, it } from "vitest";
import {
  beginChampionRetirement,
  beginBufferedSelection,
  beginSelection,
  applyWinnerPreferenceRevision,
  completeChampionRetirement,
  completeSelection,
  composePreferenceSeed,
  failSelection,
  isSelectionBoundWait,
  mergeServerResult,
  migrateGameState,
  preferenceProfileFromSeed,
  recordRejectedPreferenceEvidence,
  recentConcepts,
  recoverInterruptedSelection,
  willRetireChampion,
  type Candidate,
  type GameState,
} from "./game";

const candidate = (id: string, side: "left" | "right"): Candidate => ({
  id,
  imageUrl: `/assets/${id}.png`,
  prompt: `${side} prompt`,
  concept: `${side} concept`,
  style: [side],
  createdAt: "2026-07-16T00:00:00.000Z",
  winCount: 0,
});

const game = (): GameState => ({
  round: {
    leftCandidate: candidate("left-1", "left"),
    rightCandidate: candidate("right-1", "right"),
    status: "idle",
    replacingSide: null,
    roundNumber: 1,
    retainedCandidateId: null,
    winStreak: 0,
  },
  history: [],
  preferenceSeed: "novel industrial and natural imagery",
});

describe("round transitions", () => {
  it("builds a structured preference profile without changing a legacy seed", () => {
    expect(
      preferenceProfileFromSeed("prefer strange crafted landscapes"),
    ).toEqual({
      themes: "prefer strange crafted landscapes",
      inspiration: "",
      mediaTypes: "",
      visualStyle: "",
      colorPalette: "",
      contentLevel: "family-friendly",
      avoid: "",
      adaptationMode: "static",
      adaptationSourceWinnerIds: [],
      adaptationSourceRejectedIds: [],
    });
  });

  it("composes fine-grained preferences into generation context", () => {
    expect(
      composePreferenceSeed({
        themes: "mythic engineering and strange ecosystems",
        inspiration: "lean into unusual framing",
        mediaTypes: "large-format photography, linocut",
        visualStyle: "tactile, cinematic, austere",
        colorPalette: "ultraviolet, copper, oxblood",
        contentLevel: "adult-allowed",
        avoid: "cute mascots and readable text",
        adaptationMode: "static",
        adaptationSourceWinnerIds: [],
        adaptationSourceRejectedIds: [],
      }),
    ).toBe(
      [
        "Themes and subjects: mythic engineering and strange ecosystems",
        "Inspiration: lean into unusual framing",
        "Preferred media: large-format photography, linocut",
        "Visual style and mood: tactile, cinematic, austere",
        "Color palette: ultraviolet, copper, oxblood",
        "Content range: Adult themes may be used when relevant; keep content non-explicit and depict only clearly adult people.",
        "Avoid or de-emphasize: cute mascots and readable text",
      ].join("\n"),
    );
  });

  it("only adopts a model-authored winner profile in adaptive mode", () => {
    const profile = preferenceProfileFromSeed(
      "prefer strange crafted landscapes",
    );
    const winner = {
      ...candidate("winner", "left"),
      preferenceRevision: {
        themes: "prefer severe architectural portraits",
        inspiration: "Favor low-key lighting and asymmetrical framing.",
        mediaTypes: "large-format photography",
        visualStyle: "austere",
        colorPalette: "oxblood and black",
        contentLevel: "adult-allowed" as const,
        avoid: "readable text",
      },
    };

    expect(applyWinnerPreferenceRevision(profile, winner)).toBe(profile);
    expect(
      applyWinnerPreferenceRevision(
        { ...profile, adaptationMode: "adaptive" },
        winner,
      ),
    ).toMatchObject({
      themes: "prefer severe architectural portraits",
      inspiration: "Favor low-key lighting and asymmetrical framing.",
      mediaTypes: "large-format photography",
      adaptationMode: "adaptive",
      adaptationSourceWinnerIds: ["winner"],
      adaptationSourceRejectedIds: [],
    });
  });

  it("records bounded rejected-candidate evidence only in adaptive mode", () => {
    const staticProfile = preferenceProfileFromSeed(
      "prefer strange crafted landscapes",
    );
    expect(recordRejectedPreferenceEvidence(staticProfile, "loser")).toBe(
      staticProfile,
    );

    const adaptiveProfile = {
      ...staticProfile,
      adaptationMode: "adaptive" as const,
      adaptationSourceRejectedIds: Array.from(
        { length: 12 },
        (_, index) => `loser-${index + 1}`,
      ),
    };
    expect(
      recordRejectedPreferenceEvidence(adaptiveProfile, "latest-loser")
        .adaptationSourceRejectedIds,
    ).toEqual([
      ...adaptiveProfile.adaptationSourceRejectedIds.slice(1),
      "latest-loser",
    ]);
  });

  it("migrates the transitional inspiration-only toggle to profile-wide adaptation", () => {
    const transitional = game();
    transitional.preferenceProfile = {
      themes: "prefer strange crafted landscapes",
      inspiration: "stark lighting",
      inspirationBase: "stark lighting",
      inspirationMode: "adaptive",
      inspirationSourceWinnerIds: ["winner"],
      mediaTypes: "photography",
      visualStyle: "cinematic",
      colorPalette: "oxblood",
      contentLevel: "family-friendly",
      avoid: "readable text",
    } as unknown as GameState["preferenceProfile"];

    expect(migrateGameState(transitional).preferenceProfile).toEqual({
      themes: "prefer strange crafted landscapes",
      inspiration: "stark lighting",
      mediaTypes: "photography",
      visualStyle: "cinematic",
      colorPalette: "oxblood",
      contentLevel: "family-friendly",
      avoid: "readable text",
      adaptationMode: "adaptive",
      adaptationSourceWinnerIds: ["winner"],
      adaptationSourceRejectedIds: [],
    });
  });

  it("binds an in-flight selection to exactly one generation job", () => {
    const inFlight = beginSelection(
      game(),
      "left",
      "2026-07-16T00:01:00.000Z",
      "job-1",
    );

    expect(inFlight?.pendingSelection).toEqual({
      kind: "generation",
      winnerSide: "left",
      selectedAt: "2026-07-16T00:01:00.000Z",
      generationJobId: "job-1",
    });
  });

  it("completes a buffered selection while retaining the exact winner object", () => {
    const initial = game();
    const winner = initial.round.leftCandidate;
    const challenger = candidate("right-2", "right");

    const pending = beginBufferedSelection(
      initial,
      "left",
      "2026-07-16T00:01:00.000Z",
    );
    const next = completeSelection(pending!, challenger);

    expect(pending?.pendingSelection).toEqual({
      kind: "buffer",
      winnerSide: "left",
      selectedAt: "2026-07-16T00:01:00.000Z",
    });
    expect(next.round.leftCandidate).toBe(winner);
    expect(next.round.rightCandidate).toBe(challenger);
  });

  it("distinguishes a selection-bound wait from idle and retryable states", () => {
    const initial = game();
    const pending = beginBufferedSelection(
      initial,
      "left",
      "2026-07-16T00:01:00.000Z",
    )!;

    expect(isSelectionBoundWait(initial)).toBe(false);
    expect(isSelectionBoundWait(pending)).toBe(true);
    expect(isSelectionBoundWait(failSelection(pending, "retry"))).toBe(false);
  });

  it("rejects a generation job ID that cannot be used as a mailbox filename", () => {
    expect(() =>
      beginSelection(game(), "left", "2026-07-16T00:01:00.000Z", "../job-1"),
    ).toThrow(/invalid generation job ID/i);
  });

  it("selecting A retains the exact A object and all metadata while replacing only B", () => {
    const initial = game();
    const retained = initial.round.leftCandidate;
    const retainedMetadata = structuredClone(retained);
    const inFlight = beginSelection(
      initial,
      "left",
      "2026-07-16T00:01:00.000Z",
      "job-1",
    );
    const challenger = candidate("right-2", "right");
    const next = completeSelection(inFlight!, challenger);

    expect(next.round.leftCandidate).toBe(retained);
    expect(next.round.leftCandidate).toEqual(retainedMetadata);
    expect(next.round.rightCandidate).toBe(challenger);
    expect(next.round.roundNumber).toBe(2);
  });

  it("selecting B retains the exact B object and all metadata while replacing only A", () => {
    const initial = game();
    const retained = initial.round.rightCandidate;
    const retainedMetadata = structuredClone(retained);
    const inFlight = beginSelection(
      initial,
      "right",
      "2026-07-16T00:01:00.000Z",
      "job-1",
    );
    const challenger = candidate("left-2", "left");
    const next = completeSelection(inFlight!, challenger);

    expect(next.round.rightCandidate).toBe(retained);
    expect(next.round.rightCandidate).toEqual(retainedMetadata);
    expect(next.round.leftCandidate).toBe(challenger);
  });

  it("tracks consecutive wins on the round without changing candidate metadata", () => {
    const initial = game();
    const retained = initial.round.leftCandidate;
    const retainedMetadata = structuredClone(retained);
    const first = completeSelection(
      beginSelection(initial, "left", "2026-07-16T00:01:00.000Z", "job-1")!,
      candidate("right-2", "right"),
    );
    const second = completeSelection(
      beginSelection(first, "left", "2026-07-16T00:02:00.000Z", "job-2")!,
      candidate("right-3", "right"),
    );
    const newWinner = second.round.rightCandidate;
    const third = completeSelection(
      beginSelection(second, "right", "2026-07-16T00:03:00.000Z", "job-3")!,
      candidate("left-4", "left"),
    );

    expect(first.round).toMatchObject({
      retainedCandidateId: retained.id,
      winStreak: 1,
    });
    expect(second.round).toMatchObject({
      retainedCandidateId: retained.id,
      winStreak: 2,
    });
    expect(third.round).toMatchObject({
      retainedCandidateId: newWinner.id,
      winStreak: 1,
    });
    expect(retained).toEqual(retainedMetadata);
  });

  it("retires a champion after its tenth consecutive win", () => {
    const initial = game();
    initial.round.retainedCandidateId = initial.round.leftCandidate.id;
    initial.round.winStreak = 9;
    const leftReplacement = candidate("left-2", "left");
    const rightReplacement = candidate("right-2", "right");

    expect(willRetireChampion(initial, "left")).toBe(true);
    const pending = beginChampionRetirement(
      initial,
      "left",
      "2026-07-16T00:10:00.000Z",
    )!;
    expect(pending.round).toMatchObject({
      status: "generating",
      replacingSide: null,
    });
    expect(pending.pendingSelection).toEqual({
      kind: "retirement",
      winnerSide: "left",
      selectedAt: "2026-07-16T00:10:00.000Z",
    });

    const next = completeChampionRetirement(
      pending,
      leftReplacement,
      rightReplacement,
    );
    expect(next.round).toMatchObject({
      leftCandidate: leftReplacement,
      rightCandidate: rightReplacement,
      status: "idle",
      roundNumber: 2,
      retainedCandidateId: null,
      winStreak: 0,
    });
    expect(next.history.at(-1)).toMatchObject({
      winnerId: "left-1",
      loserId: "right-1",
      selectedAt: "2026-07-16T00:10:00.000Z",
    });
  });

  it("requires two fresh distinct candidates to finish retirement", () => {
    const initial = game();
    initial.round.retainedCandidateId = initial.round.rightCandidate.id;
    initial.round.winStreak = 9;
    const pending = beginChampionRetirement(
      initial,
      "right",
      "2026-07-16T00:10:00.000Z",
    )!;
    const replacement = candidate("new", "left");

    expect(() =>
      completeChampionRetirement(pending, replacement, replacement),
    ).toThrow(/two distinct replacements/i);
    expect(() =>
      completeChampionRetirement(
        pending,
        initial.round.leftCandidate,
        replacement,
      ),
    ).toThrow(/two distinct replacements/i);
  });

  it("refuses a second selection while generation is already in progress", () => {
    const initial = game();
    const inFlight = beginSelection(
      initial,
      "left",
      "2026-07-16T00:01:00.000Z",
      "job-1",
    );

    expect(
      beginSelection(inFlight!, "left", "2026-07-16T00:01:01.000Z", "job-2"),
    ).toBeNull();
  });

  it("keeps both exact candidate objects when generation fails", () => {
    const initial = game();
    const left = initial.round.leftCandidate;
    const right = initial.round.rightCandidate;
    const inFlight = beginSelection(
      initial,
      "left",
      "2026-07-16T00:01:00.000Z",
      "job-1",
    );
    const failed = failSelection(inFlight!, "Generator unavailable");

    expect(failed.round.leftCandidate).toBe(left);
    expect(failed.round.rightCandidate).toBe(right);
    expect(failed.round.status).toBe("error");
    expect(failed.errorMessage).toBe("Generator unavailable");
  });

  it("turns a persisted interrupted generation into a retryable error", () => {
    const initial = game();
    const inFlight = beginSelection(
      initial,
      "left",
      "2026-07-16T00:01:00.000Z",
      "job-1",
    )!;

    const recovered = recoverInterruptedSelection(inFlight);

    expect(recovered.round.status).toBe("error");
    expect(recovered.round.leftCandidate).toBe(initial.round.leftCandidate);
    expect(recovered.round.rightCandidate).toBe(initial.round.rightCandidate);
    expect(recovered.pendingSelection?.winnerSide).toBe("left");
    expect(recovered.errorMessage).toMatch(/interrupted/i);
  });

  it("returns unique recent concepts newest first", () => {
    const state = game();
    state.history = [
      {
        winnerId: "a",
        loserId: "b",
        winnerPrompt: "p1",
        loserPrompt: "p2",
        winnerConcept: "forest",
        loserConcept: "forge",
        selectedAt: "1",
      },
      {
        winnerId: "c",
        loserId: "d",
        winnerPrompt: "p3",
        loserPrompt: "p4",
        winnerConcept: "observatory",
        loserConcept: "forest",
        selectedAt: "2",
      },
    ];

    expect(recentConcepts(state, 3)).toEqual([
      "forest",
      "observatory",
      "forge",
    ]);
  });

  it.each(["left", "right"] as const)(
    "reuses the browser's %s winner object without changing any metadata",
    (winnerSide) => {
      const current = game();
      const winner =
        winnerSide === "left"
          ? current.round.leftCandidate
          : current.round.rightCandidate;
      const winnerMetadata = structuredClone(winner);
      const response = structuredClone(current);
      const responseWinner =
        winnerSide === "left"
          ? response.round.leftCandidate
          : response.round.rightCandidate;
      responseWinner.winCount = 99;
      if (winnerSide === "left") {
        response.round.rightCandidate = candidate("right-2", "right");
      } else {
        response.round.leftCandidate = candidate("left-2", "left");
      }
      response.round.roundNumber = 2;
      response.round.retainedCandidateId = winner.id;
      response.round.winStreak = 1;

      const merged = mergeServerResult(current, response, winnerSide);

      expect(
        winnerSide === "left"
          ? merged.round.leftCandidate
          : merged.round.rightCandidate,
      ).toBe(winner);
      expect(winner).toEqual(winnerMetadata);
      expect(merged.round.retainedCandidateId).toBe(winner.id);
      expect(merged.round.winStreak).toBe(1);
    },
  );
});
