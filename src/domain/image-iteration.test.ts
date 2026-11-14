import { describe, expect, it } from "vitest";
import {
  ITERATION_HISTORY_LIMIT,
  parseIterationCommand,
  planImageIteration,
  type ImageIterationInput,
  type IterationHistoryEntry,
  type ObservedIterationFingerprint,
  type IterationProposal,
} from "./image-iteration";

describe("parseIterationCommand", () => {
  it.each([
    ["iterate", 0.5],
    ["iterate frozen", 0.05],
    ["iterate cool", 0.25],
    ["iterate warm", 0.5],
    [" ITERATE HOT ", 0.75],
    ["iterate wild", 0.95],
    ["iterate 0", 0],
    ["iterate 1.00", 1],
    ["iterate .7", 0.7],
  ])("parses %s as temperature %s", (command, temperature) => {
    expect(parseIterationCommand(command)).toEqual({
      temperature,
      preserveAnchors: [],
    });
  });

  it("accepts multiple preservation clauses and keeps the first wording", () => {
    expect(
      parseIterationCommand(
        "iterate 0.8, preserve [Red beacon], PRESERVE red  beacon, preserve bent mast",
      ),
    ).toEqual({
      temperature: 0.8,
      preserveAnchors: ["Red beacon", "bent mast"],
    });
    expect(
      parseIterationCommand("iterate, preserve bent mast").temperature,
    ).toBe(0.5);
  });

  it("accepts punctuation inside a bracketed anchor", () => {
    expect(
      parseIterationCommand(
        "iterate hot, preserve [red, white, and blue stripes], preserve mast",
      ),
    ).toEqual({
      temperature: 0.75,
      preserveAnchors: ["red, white, and blue stripes", "mast"],
    });
  });

  it.each([
    "reiterate hot",
    "iterate 1.1",
    "iterate 1.00000000000000001",
    "iterate -0.1",
    "iterate NaN",
    "iterate Infinity",
    "iterate 0x0",
    "iterate 7e-1",
    "iterate constructor",
    "iterate hot please",
    "iterate hot, avoid boats",
    "iterate hot, preserve []",
    "iterate hot, preserve [red beacon",
    "iterate hot,",
  ])("rejects malformed or out-of-range input %s", (command) => {
    expect(() => parseIterationCommand(command)).toThrow();
  });
});

const source = {
  origin: "visual-analysis",
  axes: {
    gaze: "away",
    palette: "cool gray",
    activity: "repairing",
    composition: "centered portrait",
    aesthetic: "documentary photograph",
    wardrobeLogic: "workwear",
    setting: "harbor workshop",
    viewerRelationship: "observer",
    role: "mechanic",
    narrative: "routine maintenance",
    tensionEngine: "fragile equipment",
  },
  visualAnchors: ["signal lamp"],
} satisfies ObservedIterationFingerprint;

const subject = {
  mandatoryAnchors: ["Red signal lamp"],
  preservedAxes: ["palette"] as const,
  exclusions: ["explosions"],
};

function proposal(
  id: string,
  changes: IterationProposal["changes"],
): IterationProposal {
  return {
    id,
    changes,
    retainedAnchors: ["red signal lamp", "bent mast"],
    visualAnchors: ["signal lamp"],
    safety: "allowed",
    contentLevel: "family-friendly",
  };
}

const framing = proposal("framing", {
  gaze: "toward window",
  composition: "low angle closeup",
  aesthetic: "charcoal drawing",
});
const staging = proposal("staging", {
  ...framing.changes,
  activity: "calibrating",
  setting: "roof observatory",
  wardrobeLogic: "weather gear",
});
const reinterpretation = proposal("reinterpretation", {
  ...staging.changes,
  narrative: "last signal before the storm",
  viewerRelationship: "apprentice",
  tensionEngine: "storm closing in",
});
const far = proposal("far", {
  ...reinterpretation.changes,
  role: "signal keeper",
});

const baseInput = {
  command: "iterate",
  subject,
  source,
  contentLevel: "family-friendly",
  proposals: [framing, staging, reinterpretation, far],
} satisfies ImageIterationInput;

function plan(overrides: Partial<ImageIterationInput>) {
  const result = planImageIteration({ ...baseInput, ...overrides });
  expect(result.status, JSON.stringify(result)).toBe("planned");
  if (result.status === "planned") return result.plan;
  throw new Error(result.reason);
}

describe("planImageIteration", () => {
  it("plans greater structural distance from cool to wild with the same constraints", () => {
    const cases = [
      ["cool", "framing", 5 / 26],
      ["warm", "staging", 12 / 26],
      ["hot", "reinterpretation", 21 / 26],
      ["wild", "far", 24 / 26],
    ] as const;
    for (const [alias, proposalId, sourceDistance] of cases) {
      expect(
        plan({ command: `iterate ${alias}, preserve [bent mast]` }),
      ).toMatchObject({
        proposalId,
        sourceDistance,
        mandatoryAnchors: ["Red signal lamp", "bent mast"],
        preservedAxes: expect.arrayContaining(["palette"]),
        exclusions: ["explosions"],
        contentLevel: "family-friendly",
      });
    }
  });

  it("returns a structured plan and a projected fingerprint", () => {
    expect(plan({ command: "iterate hot" })).toMatchObject({
      temperature: 0.75,
      proposalId: "reinterpretation",
      changedAxes: expect.arrayContaining([
        { axis: "activity", from: "repairing", to: "calibrating" },
        {
          axis: "tensionEngine",
          from: "fragile equipment",
          to: "storm closing in",
        },
      ]),
      preservedAxes: ["palette", "role"],
      tensionEngine: "storm closing in",
      candidateFingerprint: {
        axes: { palette: "cool gray", setting: "roof observatory" },
        visualAnchors: ["signal lamp"],
      },
    });
  });

  it("treats case and spacing edits as the same axis at zero temperature", () => {
    const sameComposition = proposal("detail", {
      composition: " CENTERED  PORTRAIT ",
    });
    expect(
      plan({ command: "iterate 0", proposals: [framing, sameComposition] }),
    ).toMatchObject({
      proposalId: "detail",
      sourceDistance: 0,
      changedAxes: [],
    });
  });

  it.each([
    ["a missing subject anchor", { ...far, retainedAnchors: ["bent mast"] }],
    [
      "a required anchor declared removed",
      { ...far, removedAnchors: ["  RED Signal Lamp "] },
    ],
    [
      "a missing command anchor",
      { ...far, retainedAnchors: ["Red signal lamp"] },
    ],
    [
      "a changed locked axis",
      { ...far, changes: { ...far.changes, palette: "red" } },
    ],
    ["an excluded visual motif", { ...far, tags: [" EXPLOSIONS "] }],
    ["a blocked safety decision", { ...far, safety: "blocked" as const }],
    [
      "a wider content range",
      { ...far, contentLevel: "adult-allowed" as const },
    ],
  ])("keeps wild proposals with %s ineligible", (_label, rejected) => {
    expect(
      planImageIteration({
        ...baseInput,
        command: "iterate wild, preserve [bent mast]",
        proposals: [rejected],
      }),
    ).toEqual({ status: "blocked", reason: "no-eligible-proposal" });
  });

  it("offers a retry when a vetted proposal exceeds the requested distance", () => {
    expect(
      planImageIteration({
        ...baseInput,
        command: "iterate frozen",
        proposals: [far],
      }),
    ).toEqual({
      status: "blocked",
      reason: "no-proposal-in-range",
    });
  });

  it("leaves the source, proposals, and history intact across repeated planning", () => {
    const input = {
      ...baseInput,
      history: [
        { outcome: "selected", fingerprint: source },
        { outcome: "rejected" },
      ],
    } satisfies ImageIterationInput;
    const original = structuredClone(input);
    const first = planImageIteration(input);
    expect(planImageIteration(input)).toEqual(first);
    expect(input).toEqual(original);
  });

  it("selects a new in-range proposal on retry with the same constraints", () => {
    const retry = { command: "iterate cool", proposals: [far, framing] };
    expect(plan(retry)).toMatchObject({
      proposalId: "framing",
      mandatoryAnchors: ["Red signal lamp"],
    });
  });

  it("counts a changed optional motif toward source distance", () => {
    const newMotif = {
      ...proposal("new motif", {}),
      visualAnchors: ["glass counterweight"],
    };
    expect(
      planImageIteration({
        ...baseInput,
        command: "iterate 0",
        proposals: [newMotif],
      }),
    ).toEqual({
      status: "blocked",
      reason: "no-proposal-in-range",
    });
  });

  it.each([
    [".499", ["brass rivets", "frosted glass", "wide brim"]],
    [".5", ["brass rivets", "frosted glass"]],
    ["hot", ["brass rivets", "frosted glass"]],
    ["wild", ["brass rivets", "frosted glass"]],
  ])(
    "uses the optional lineage budget at %s after reserving all required anchors",
    (temperature, optionalAnchors) => {
      const required = ["Red signal lamp", "copper badge", "bent mast"];
      expect(
        plan({
          command: `iterate ${temperature}, preserve [bent mast]`,
          subject: { mandatoryAnchors: required.slice(0, 2) },
          proposals: [
            {
              ...framing,
              retainedAnchors: [
                ...required,
                "brass rivets",
                "Brass  Rivets",
                "frosted glass",
                "wide brim",
                "patina",
              ],
            },
          ],
        }),
      ).toMatchObject({ mandatoryAnchors: required, optionalAnchors });
    },
  );

  it("reports a preserve/exclude conflict before evaluating proposals", () => {
    expect(
      planImageIteration({
        ...baseInput,
        command: "iterate hot, preserve [Bent mast]",
        subject: { ...subject, exclusions: [" BENT  MAST "] },
        proposals: [],
      }),
    ).toEqual({
      status: "blocked",
      reason: "anchor-conflict",
      conflictingAnchors: ["Bent mast"],
    });
  });

  it("blocks a zero-temperature motif change past the stored fingerprint limit", () => {
    const mandatoryAnchors = Array.from({ length: 8 }, (_, i) => `anchor ${i}`);
    expect(
      planImageIteration({
        ...baseInput,
        command: "iterate 0",
        subject: { mandatoryAnchors },
        source: {
          ...source,
          visualAnchors: [...mandatoryAnchors, "brass rivets"],
        },
        proposals: [
          {
            ...framing,
            changes: {},
            retainedAnchors: mandatoryAnchors,
            visualAnchors: [...mandatoryAnchors, "red enamel dots"],
          },
        ],
      }),
    ).toEqual({ status: "blocked", reason: "no-proposal-in-range" });
  });

  it("scores scene differences independently of extra optional labels", () => {
    const tagged = { ...balanced, visualAnchors: ["spiral railing"] };
    const untagged = { ...balanced, visualAnchors: [] };
    const withMotif = plan({ ...compositionInput, proposals: [tagged] });
    const withoutMotif = plan({ ...compositionInput, proposals: [untagged] });
    expect(withMotif.sourceDistance).toBeGreaterThanOrEqual(
      withoutMotif.sourceDistance,
    );
    const history: IterationHistoryEntry[] = [
      {
        outcome: "selected",
        fingerprint: {
          ...compositionSource,
          axes: { composition: "balanced" },
        },
      },
    ];
    expect(
      plan({ ...compositionInput, proposals: [tagged], history }).repetition
        .selected,
    ).toBe(
      plan({ ...compositionInput, proposals: [untagged], history }).repetition
        .selected,
    );
  });

  it("keeps exclusions effective past the fingerprint label limit", () => {
    const overLimit = {
      ...framing,
      visualAnchors: [
        ...Array.from({ length: 8 }, (_, index) => `shape ${index}`),
        "explosions",
      ],
    };
    expect(
      planImageIteration({ ...baseInput, proposals: [overLimit] }),
    ).toEqual({
      status: "blocked",
      reason: "no-eligible-proposal",
    });
  });

  it("checks inherited exclusions before trimming source observations", () => {
    const overLimit = [
      ...Array.from({ length: 8 }, (_, index) => `shape ${index}`),
      "Explosions",
    ];
    const inherited = { ...framing, visualAnchors: undefined };
    const input = {
      ...baseInput,
      source: { ...source, visualAnchors: overLimit },
    };
    expect(planImageIteration({ ...input, proposals: [inherited] })).toEqual({
      status: "blocked",
      reason: "no-eligible-proposal",
    });
    expect(
      planImageIteration({
        ...input,
        proposals: [{ ...inherited, removedAnchors: ["explosions"] }],
      }).status,
    ).toBe("planned");
  });

  it("requires source annotation for an explicitly preserved axis", () => {
    expect(
      planImageIteration({
        ...baseInput,
        source: { ...source, axes: { role: "mechanic" } },
      }),
    ).toEqual({
      status: "blocked",
      reason: "insufficient-source",
    });
  });

  it("allows a narrower content range while preserving the saved ceiling", () => {
    expect(plan({ contentLevel: "adult-allowed" }).contentLevel).toBe(
      "adult-allowed",
    );
  });

  it("rejects edits for visual axes without a source observation", () => {
    const ungrounded = proposal("unknown-pose", { pose: "crouching" });
    expect(
      planImageIteration({ ...baseInput, proposals: [ungrounded] }),
    ).toEqual({
      status: "blocked",
      reason: "no-eligible-proposal",
    });
  });

  it("carries observed motifs into a projection when none are supplied", () => {
    const unchanged = { ...framing, visualAnchors: undefined };
    expect(
      plan({ command: "iterate cool", proposals: [unchanged] })
        .candidateFingerprint.visualAnchors,
    ).toEqual(["signal lamp"]);
  });

  it("bounds the projected fingerprint without storing arbitrary proposal metadata", () => {
    const manyMotifs = Array.from(
      { length: 10 },
      (_, index) => `shape ${index}`,
    );
    const annotated = {
      ...framing,
      visualAnchors: ["x".repeat(81), ...manyMotifs],
      tags: ["review detail"],
    };
    const result = plan({ command: "iterate cool", proposals: [annotated] });
    expect(result.candidateFingerprint).toEqual({
      origin: "projected",
      axes: { ...source.axes, ...framing.changes },
      visualAnchors: manyMotifs.slice(0, 8),
    });
  });

  it("rejects an oversized required anchor instead of truncating it", () => {
    const anchor = "x".repeat(201);
    expect(() =>
      parseIterationCommand(`iterate hot, preserve ${anchor}`),
    ).toThrow(/preserve/i);
    expect(() =>
      planImageIteration({
        ...baseInput,
        subject: { mandatoryAnchors: [anchor] },
      }),
    ).toThrow(/anchor/i);
  });
});

const compositionSource = {
  origin: "manual-observation",
  axes: { composition: "overhead" },
} satisfies ObservedIterationFingerprint;
const balanced = proposal("a-balanced", { composition: "balanced" });
const asymmetric = proposal("z-asymmetric", { composition: "asymmetric" });
const compositionInput = {
  command: "iterate 1",
  source: compositionSource,
  subject: { mandatoryAnchors: ["red signal lamp"] },
  proposals: [balanced, asymmetric],
} satisfies Partial<ImageIterationInput>;

describe("iteration anti-convergence", () => {
  const repeated = {
    fingerprint: {
      origin: "visual-analysis",
      axes: { composition: "Balanced" },
      visualAnchors: ["signal lamp"],
    },
  } as const;

  it.each(["selected", "rejected"] as const)(
    "avoids a recurring %s composition",
    (outcome) => {
      const chosen = plan({
        ...compositionInput,
        history: [{ ...repeated, outcome }],
      });
      expect(chosen.proposalId).toBe("z-asymmetric");
    },
  );

  it("penalizes rejected fingerprints more strongly than selected ones", () => {
    const input = { ...compositionInput, proposals: [balanced] };
    const fromSelected = plan({
      ...input,
      history: [{ ...repeated, outcome: "selected" }],
    });
    const fromRejected = plan({
      ...input,
      history: [{ ...repeated, outcome: "rejected" }],
    });
    expect(fromSelected.repetition.selected).toBeGreaterThan(0);
    expect(fromSelected.repetition.rejected).toBe(0);
    expect(fromRejected.repetition.selected).toBe(0);
    expect(fromRejected.repetition.rejected).toBeGreaterThan(
      fromSelected.repetition.selected,
    );
  });

  it("decays fingerprints with age and drops events outside the window", () => {
    const match: IterationHistoryEntry = { ...repeated, outcome: "selected" };
    const noFingerprint = { outcome: "rejected" } as const;
    const olderSlots = Array<IterationHistoryEntry>(
      ITERATION_HISTORY_LIMIT - 1,
    ).fill(noFingerprint);
    const input = { ...compositionInput, proposals: [balanced] };
    const newest = plan({ ...input, history: [...olderSlots, match] });
    const oldest = plan({ ...input, history: [match, ...olderSlots] });
    const expired = plan({
      ...input,
      history: [match, ...olderSlots, noFingerprint],
    });
    expect(oldest.repetition.selected).toBeGreaterThan(0);
    expect(oldest.repetition.selected).toBeLessThan(newest.repetition.selected);
    expect(expired.repetition.selected).toBe(0);
  });

  it("breaks a distance tie away from the paired candidate", () => {
    const pairedCandidate = {
      origin: "manual-observation",
      axes: { composition: "balanced" },
    } as const;
    expect(plan({ ...compositionInput, pairedCandidate }).proposalId).toBe(
      "z-asymmetric",
    );
  });

  it("uses a stable tie break when older history has no visual annotations", () => {
    const history: IterationHistoryEntry[] = [
      { outcome: "selected" },
      { outcome: "rejected" },
    ];
    const first = plan({ ...compositionInput, history });
    expect(first.proposalId).toBe("a-balanced");
    expect(
      plan({ ...compositionInput, proposals: [asymmetric, balanced], history }),
    ).toEqual(first);
  });

  it("ignores projected fingerprints passed back as visual history", () => {
    const projected = plan(compositionInput).candidateFingerprint;
    const history = [
      { fingerprint: projected, outcome: "rejected" },
    ] as unknown as IterationHistoryEntry[];
    expect(plan({ ...compositionInput, history }).proposalId).toBe(
      "a-balanced",
    );
  });

  it("gives no repetition penalty for locked axes and mandatory motifs alone", () => {
    const history: IterationHistoryEntry[] = [
      {
        outcome: "rejected",
        fingerprint: {
          origin: "manual-observation",
          axes: { palette: "cool gray" },
          visualAnchors: ["red signal lamp"],
        },
      },
    ];
    const matchingOnlyRequired = {
      ...staging,
      visualAnchors: ["red signal lamp"],
    };
    expect(
      plan({ proposals: [matchingOnlyRequired], history }).repetition.rejected,
    ).toBe(0);
  });

  it("gives sparse visual evidence less influence than a full match", () => {
    const full = { ...source.axes, ...staging.changes };
    const input = { proposals: [staging] };
    const partialMatch = plan({
      ...input,
      history: [
        {
          outcome: "selected",
          fingerprint: {
            origin: "manual-observation",
            axes: { setting: "roof observatory" },
          },
        },
      ],
    });
    const fullMatch = plan({
      ...input,
      history: [
        { outcome: "selected", fingerprint: { ...source, axes: full } },
      ],
    });
    expect(partialMatch.repetition.selected).toBeGreaterThan(0);
    expect(partialMatch.repetition.selected).toBeLessThan(
      fullMatch.repetition.selected,
    );
  });
});
