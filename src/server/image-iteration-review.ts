import { z } from "zod";
import type { IterationPlan } from "../domain/image-iteration";

const anchorLabel = z.string().trim().min(1).max(200);
const anchorList = z.array(anchorLabel).max(16);

export const iterationAnchorReviewSchema = z
  .object({
    jobId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    imageSha256: z.string().regex(/^[a-f0-9]{64}$/),
    presentAnchors: anchorList,
    absentExclusions: anchorList,
  })
  .strict();

export function verifyIterationAnchorReview(
  plan: Pick<IterationPlan, "mandatoryAnchors" | "exclusions">,
  review: z.infer<typeof iterationAnchorReviewSchema> | undefined,
  jobId: string,
  imageSha256: string,
): void {
  if (!review) throw new Error("Iteration job requires an anchor review");
  if (review.jobId !== jobId || review.imageSha256 !== imageSha256) {
    throw new Error("Anchor review must match this job and its exact image");
  }
  const missing = plan.mandatoryAnchors.find(
    (anchor) => !review.presentAnchors.includes(anchor),
  );
  if (missing)
    throw new Error(`Anchor review did not confirm presence of ${missing}`);
  const unverified = plan.exclusions.find(
    (anchor) => !review.absentExclusions.includes(anchor),
  );
  if (unverified)
    throw new Error(`Anchor review did not confirm absence of ${unverified}`);
  if (
    review.presentAnchors.length !== plan.mandatoryAnchors.length ||
    review.absentExclusions.length !== plan.exclusions.length
  ) {
    throw new Error("Anchor review must contain only the planned constraints");
  }
}
