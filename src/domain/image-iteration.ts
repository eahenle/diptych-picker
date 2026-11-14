import { z } from "zod";
import type { PreferenceContentLevel } from "./game";

const temperatureAliases = {
  frozen: 0.05,
  cool: 0.25,
  warm: 0.5,
  hot: 0.75,
  wild: 0.95,
} as const;

// Structural changes count more toward distance than changes to surface detail.
const axisWeights = {
  gaze: 1,
  palette: 1,
  activity: 2,
  pose: 2,
  composition: 2,
  aesthetic: 2,
  wardrobeLogic: 2,
  setting: 3,
  viewerRelationship: 3,
  role: 3,
  narrative: 3,
  tensionEngine: 3,
} as const;

export type IterationAxis = keyof typeof axisWeights;
const axes = Object.keys(axisWeights) as IterationAxis[];
type AxisLabels = Partial<Record<IterationAxis, string>>;

export const ITERATION_HISTORY_LIMIT = 12;
const featureLabelLimit = 80;
const visualAnchorLimit = 8;
const constraintLabelLimit = 200;
const constraintCountLimit = 16;
const proposalIdLimit = 100;
const distanceTolerance = 0.125;
const repetitionWeights = { selected: 0.125, rejected: 0.25 } as const;
const totalRecencyWeight =
  (ITERATION_HISTORY_LIMIT * (ITERATION_HISTORY_LIMIT + 1)) / 2;

export interface IterationRequest {
  temperature: number;
  preserveAnchors: readonly string[];
}

export interface IterationFingerprint {
  axes: Readonly<AxisLabels>;
  visualAnchors?: readonly string[];
}

export interface ObservedIterationFingerprint extends IterationFingerprint {
  origin: "visual-analysis" | "manual-observation";
}

export interface IterationSubject {
  mandatoryAnchors: readonly string[];
  preservedAxes?: readonly IterationAxis[];
  exclusions?: readonly string[];
}

export interface IterationProposal {
  id: string;
  changes: Readonly<AxisLabels>;
  /** List optional lineage anchors in preference order after the required claims. */
  retainedAnchors: readonly string[];
  removedAnchors?: readonly string[];
  visualAnchors?: readonly string[];
  tags?: readonly string[];
  /** A trusted caller supplies the safety decision and content classification. */
  safety: "allowed" | "blocked";
  contentLevel: PreferenceContentLevel;
}

export interface IterationHistoryEntry {
  outcome: "selected" | "rejected";
  fingerprint?: ObservedIterationFingerprint;
}

export interface ImageIterationInput {
  command: string;
  subject: IterationSubject;
  contentLevel: PreferenceContentLevel;
  source: ObservedIterationFingerprint;
  proposals: readonly IterationProposal[];
  pairedCandidate?: ObservedIterationFingerprint;
  /** Oldest first. Missing fingerprints occupy a slot without adding a penalty. */
  history?: readonly IterationHistoryEntry[];
}

interface ChangedAxis {
  axis: IterationAxis;
  from: string;
  to: string;
}

export interface IterationPlan {
  temperature: number;
  proposalId: string;
  sourceDistance: number;
  mandatoryAnchors: readonly string[];
  optionalAnchors: readonly string[];
  preservedAxes: readonly IterationAxis[];
  changedAxes: readonly ChangedAxis[];
  tensionEngine: string | null;
  exclusions: readonly string[];
  contentLevel: PreferenceContentLevel;
  candidateFingerprint: IterationFingerprint & { origin: "projected" };
  repetition: Readonly<Record<IterationHistoryEntry["outcome"], number>>;
}

const anchorLabelSchema = z.string().trim().refine(isConstraintLabel, {
  message: "Use a valid anchor label of 1 to 200 characters",
});

export const generationIterationPlanSchema = z
  .object({
    temperature: z.number().min(0).max(1),
    mandatoryAnchors: z.array(anchorLabelSchema).max(constraintCountLimit),
    optionalAnchors: z.array(anchorLabelSchema).max(visualAnchorLimit),
    exclusions: z.array(anchorLabelSchema).max(constraintCountLimit),
  })
  .strict()
  .refine(
    (plan) =>
      plan.optionalAnchors.length <= optionalAnchorBudget(plan.temperature),
    {
      path: ["optionalAnchors"],
      message: "Optional anchors exceed the budget for this temperature",
    },
  )
  .refine((plan) => {
    const labels = [
      ...plan.mandatoryAnchors,
      ...plan.optionalAnchors,
      ...plan.exclusions,
    ];
    return new Set(labels.map(labelKey)).size === labels.length;
  }, "Preserved anchors and exclusions must be distinct");

export type GenerationIterationPlan = z.infer<
  typeof generationIterationPlanSchema
>;

export type IterationPlanResult =
  | { status: "planned"; plan: IterationPlan }
  | {
      status: "blocked";
      reason: "anchor-conflict";
      conflictingAnchors: readonly string[];
    }
  | {
      status: "blocked";
      reason:
        "insufficient-source" | "no-eligible-proposal" | "no-proposal-in-range";
    };

export function parseIterationCommand(command: string): IterationRequest {
  const text = command.trim();
  const head = /^iterate(?:[ \t]+([^\s,]+))?(?=\s*(?:,|$))/i.exec(text);
  if (!head) throw new Error("Use iterate [temperature], preserve [anchor].");

  const token = head[1]?.toLowerCase() ?? "warm";
  let temperature: number;
  if (Object.hasOwn(temperatureAliases, token)) {
    temperature = temperatureAliases[token as keyof typeof temperatureAliases];
  } else if (/^(?:0(?:\.\d+)?|\.\d+|1(?:\.0+)?)$/.test(token)) {
    temperature = Number(token);
  } else {
    throw new Error("Use a temperature from 0 to 1 or a temperature alias.");
  }

  const preserveAnchors: string[] = [];
  let remaining = text.slice(head[0].length).trim();
  while (remaining) {
    const clause =
      /^,\s*preserve[ \t]+(?:\[([^\]]+)\]|([^,\]]+))\s*(?=,|$)/i.exec(
        remaining,
      );
    const anchor = (clause?.[1] ?? clause?.[2])?.trim();
    if (!clause || !anchor || anchor.includes("[")) {
      throw new Error("Each preserve clause needs an anchor.");
    }
    preserveAnchors.push(anchor);
    remaining = remaining.slice(clause[0].length);
  }
  return {
    temperature,
    preserveAnchors: constraintLabels(preserveAnchors, "preserve anchor"),
  };
}

export function planImageIteration(
  input: ImageIterationInput,
): IterationPlanResult {
  const { temperature, preserveAnchors } = parseIterationCommand(input.command);
  const mandatoryAnchors = constraintLabels(
    [...input.subject.mandatoryAnchors, ...preserveAnchors],
    "mandatory anchor",
  );
  const exclusions = constraintLabels(
    input.subject.exclusions ?? [],
    "exclusion",
  );
  const requiredLabels = new Set(mandatoryAnchors.map(labelKey));
  const excludedLabels = new Set(exclusions.map(labelKey));
  const conflictingAnchors = mandatoryAnchors.filter((anchor) =>
    excludedLabels.has(labelKey(anchor)),
  );
  if (conflictingAnchors.length > 0)
    return { status: "blocked", reason: "anchor-conflict", conflictingAnchors };

  const source = observedFingerprint(input.source);
  if (!source) return { status: "blocked", reason: "insufficient-source" };
  const sourceAxes = axes.filter((axis) => source.axes[axis] !== undefined);
  const lockedAxes = new Set(input.subject.preservedAxes);
  if (
    sourceAxes.length === 0 ||
    [...lockedAxes].some((axis) => !sourceAxes.includes(axis))
  ) {
    return { status: "blocked", reason: "insufficient-source" };
  }

  const sourceAxesWeight = sourceAxes.reduce(
    (sum, axis) => sum + axisWeights[axis],
    0,
  );
  const maxDistance =
    temperature === 0 ? 0 : Math.min(1, temperature + distanceTolerance);
  const paired = observedFingerprint(input.pairedCandidate);
  const recent = (input.history ?? [])
    .slice(-ITERATION_HISTORY_LIMIT)
    .reverse()
    .map((entry) => ({
      outcome: entry.outcome,
      fingerprint: observedFingerprint(entry.fingerprint),
    }));
  const sourceMotifs = optionalMotifs(source.visualAnchors, requiredLabels);
  const optionalBudget = optionalAnchorBudget(temperature);
  const noveltyAxes = sourceAxes.filter((axis) => !lockedAxes.has(axis));
  const noveltyAxisWeight = noveltyAxes.reduce(
    (sum, axis) => sum + axisWeights[axis],
    0,
  );
  const noveltyWeight = noveltyAxisWeight + 1;
  const proposalIds = new Set<string>();
  let best: { score: number; plan: IterationPlan } | undefined;
  let hasEligibleProposal = false;

  for (const proposal of input.proposals) {
    if (
      !proposal.id.trim() ||
      proposal.id.length > proposalIdLimit ||
      proposalIds.has(proposal.id)
    ) {
      throw new Error(
        "Each proposal needs a unique ID of 1 to 100 characters.",
      );
    }
    proposalIds.add(proposal.id);
    if (
      proposal.safety !== "allowed" ||
      (proposal.contentLevel !== "family-friendly" &&
        !(
          input.contentLevel === "adult-allowed" &&
          proposal.contentLevel === "adult-allowed"
        ))
    )
      continue;

    const retainedAnchors = uniqueLabels(proposal.retainedAnchors);
    const retained = new Set(retainedAnchors.map(labelKey));
    const removed = new Set((proposal.removedAnchors ?? []).map(labelKey));
    if (
      [...requiredLabels].some((anchor) => !retained.has(anchor)) ||
      [...retained].some((anchor) => removed.has(anchor))
    )
      continue;

    const projection = projectAxes(source.axes, proposal.changes, lockedAxes);
    if (!projection) continue;
    const { candidateAxes, changedAxes } = projection;
    const visualAnchors =
      proposal.visualAnchors ??
      input.source.visualAnchors?.filter(
        (anchor) => !removed.has(labelKey(anchor)),
      );
    if (visualAnchors?.some((anchor) => removed.has(labelKey(anchor))))
      continue;

    const visualLabels = [
      ...axes.map((axis) => proposal.changes[axis] ?? input.source.axes[axis]),
      ...(visualAnchors ?? []),
      ...(proposal.tags ?? []),
      ...retained,
    ];
    if (
      visualLabels.some(
        (label) => label !== undefined && excludedLabels.has(labelKey(label)),
      )
    )
      continue;

    const projectedAnchors = visualAnchorLabels(visualAnchors);
    const candidateFingerprint = {
      origin: "projected" as const,
      axes: candidateAxes,
      ...(projectedAnchors.length > 0
        ? { visualAnchors: projectedAnchors.slice(0, visualAnchorLimit) }
        : {}),
    };
    const candidateMotifs = optionalMotifs(projectedAnchors, requiredLabels);
    const hasMotifs = sourceMotifs.length > 0 || candidateMotifs.length > 0;
    const changedWeight = changedAxes.reduce(
      (sum, { axis }) => sum + axisWeights[axis],
      0,
    );
    const motifDistance = hasMotifs
      ? 1 - anchorSimilarity(sourceMotifs, candidateMotifs)
      : 0;
    const sourceDistance =
      (changedWeight + motifDistance) / (sourceAxesWeight + Number(hasMotifs));
    hasEligibleProposal = true;
    if (sourceDistance > maxDistance) continue;

    const candidateNoveltyMotifs = candidateMotifs.slice(0, visualAnchorLimit);
    const similarity = (evidence: IterationFingerprint) => {
      const matched = noveltyAxes.reduce(
        (weight, axis) =>
          weight +
          (candidateAxes[axis] === evidence.axes[axis] ? axisWeights[axis] : 0),
        0,
      );
      const motifMatch = anchorSimilarity(
        candidateNoveltyMotifs,
        optionalMotifs(evidence.visualAnchors, requiredLabels).slice(
          0,
          visualAnchorLimit,
        ),
      );
      return (matched + motifMatch) / noveltyWeight;
    };
    const repetition = { selected: 0, rejected: 0 };
    for (const [age, { outcome, fingerprint }] of recent.entries()) {
      if (!fingerprint || !Object.hasOwn(repetitionWeights, outcome)) continue;
      const weight = (ITERATION_HISTORY_LIMIT - age) / totalRecencyWeight;
      repetition[outcome] +=
        similarity(fingerprint) * weight * repetitionWeights[outcome];
    }
    const pairPenalty = paired ? 0.125 * similarity(paired) : 0;
    const score =
      Math.abs(sourceDistance - temperature) +
      repetition.selected +
      repetition.rejected +
      pairPenalty;
    if (
      best &&
      (score > best.score ||
        (score === best.score && proposal.id >= best.plan.proposalId))
    )
      continue;

    best = {
      score,
      plan: {
        temperature,
        proposalId: proposal.id,
        sourceDistance,
        mandatoryAnchors,
        optionalAnchors: retainedAnchors
          .filter(
            (anchor) =>
              !requiredLabels.has(labelKey(anchor)) &&
              isConstraintLabel(anchor),
          )
          .slice(0, optionalBudget),
        preservedAxes: sourceAxes.filter(
          (axis) => candidateAxes[axis] === source.axes[axis],
        ),
        changedAxes,
        tensionEngine: candidateAxes.tensionEngine ?? null,
        exclusions,
        contentLevel: input.contentLevel,
        candidateFingerprint,
        repetition,
      },
    };
  }

  return best
    ? { status: "planned", plan: best.plan }
    : {
        status: "blocked",
        reason: hasEligibleProposal
          ? "no-proposal-in-range"
          : "no-eligible-proposal",
      };
}

function projectAxes(
  source: Readonly<AxisLabels>,
  changes: Readonly<AxisLabels>,
  lockedAxes: ReadonlySet<IterationAxis>,
): { candidateAxes: AxisLabels; changedAxes: ChangedAxis[] } | undefined {
  if (Object.keys(changes).some((axis) => !Object.hasOwn(axisWeights, axis)))
    return;
  const candidateAxes = { ...source };
  const changedAxes: ChangedAxis[] = [];
  for (const axis of axes) {
    if (!Object.hasOwn(changes, axis)) continue;
    const from = source[axis];
    const to = featureLabel(changes[axis]);
    if (!from || !to) return;
    if (from === to) continue;
    if (lockedAxes.has(axis)) return;
    candidateAxes[axis] = to;
    changedAxes.push({ axis, from, to });
  }
  return { candidateAxes, changedAxes };
}

function observedFingerprint(
  input: ObservedIterationFingerprint | undefined,
): IterationFingerprint | undefined {
  if (
    input?.origin !== "visual-analysis" &&
    input?.origin !== "manual-observation"
  )
    return;
  const boundedAxes: AxisLabels = {};
  for (const axis of axes) {
    const label = featureLabel(input.axes[axis]);
    if (label) boundedAxes[axis] = label;
  }
  return {
    axes: boundedAxes,
    visualAnchors: visualAnchorLabels(input.visualAnchors),
  };
}

function visualAnchorLabels(labels: readonly string[] | undefined): string[] {
  return uniqueLabels(labels ?? [])
    .map(featureLabel)
    .filter((label): label is string => label !== undefined);
}

function optionalMotifs(
  labels: readonly string[] | undefined,
  mandatoryAnchors: ReadonlySet<string>,
): string[] {
  return (labels ?? []).filter((label) => !mandatoryAnchors.has(label));
}

function optionalAnchorBudget(temperature: number): number {
  if (temperature <= 0.2) return 8;
  if (temperature <= 0.4) return 5;
  return temperature < 0.5 ? 3 : 2;
}

function anchorSimilarity(
  left: readonly string[],
  right: readonly string[],
): number {
  const rightLabels = new Set(right);
  const overlap = left.filter((label) => rightLabels.has(label)).length;
  const unionSize = left.length + right.length - overlap;
  return unionSize ? overlap / unionSize : 0;
}

function constraintLabels(labels: readonly string[], kind: string): string[] {
  const unique = uniqueLabels(labels);
  if (labels.some((label) => !isConstraintLabel(label))) {
    throw new Error(
      `${kind} labels must contain 1 to ${constraintLabelLimit} characters.`,
    );
  }
  if (unique.length > constraintCountLimit) {
    throw new Error(`Use at most ${constraintCountLimit} ${kind} labels.`);
  }
  return unique;
}

function isConstraintLabel(label: string): boolean {
  const key = labelKey(label);
  return (
    key.length > 0 &&
    key.length <= constraintLabelLimit &&
    label.trim().length <= constraintLabelLimit
  );
}

function featureLabel(label: string | undefined): string | undefined {
  if (typeof label !== "string") return undefined;
  const key = labelKey(label);
  return key.length > 0 && key.length <= featureLabelLimit ? key : undefined;
}

function labelKey(label: string): string {
  return label.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function uniqueLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  return labels
    .map((label) => label.trim())
    .filter((label) => {
      const key = labelKey(label);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
