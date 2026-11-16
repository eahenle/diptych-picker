import type {
  GenerationIterationPlan,
  IterationAnchorReview,
  IterationDirection,
  IterationJobContext,
  IterationPlan,
} from "../domain/image-iteration";

export class InvalidIterationReviewError extends Error {}

export function verifyIterationAnchorReview(
  plan: Pick<IterationPlan, "mandatoryAnchors" | "exclusions">,
  review: IterationAnchorReview | undefined,
  jobId: string,
  imageSha256: string,
): void {
  if (!review)
    throw new InvalidIterationReviewError(
      "Iteration job requires an anchor review",
    );
  if (review.jobId !== jobId || review.imageSha256 !== imageSha256) {
    throw new InvalidIterationReviewError(
      "Anchor review must match this job and its exact image",
    );
  }
  const missing = plan.mandatoryAnchors.find(
    (anchor) => !review.presentAnchors.includes(anchor),
  );
  if (missing)
    throw new InvalidIterationReviewError(
      `Anchor review did not confirm presence of ${missing}`,
    );
  const unverified = plan.exclusions.find(
    (anchor) => !review.absentExclusions.includes(anchor),
  );
  if (unverified)
    throw new InvalidIterationReviewError(
      `Anchor review did not confirm absence of ${unverified}`,
    );
  if (
    review.presentAnchors.length !== plan.mandatoryAnchors.length ||
    review.absentExclusions.length !== plan.exclusions.length
  ) {
    throw new InvalidIterationReviewError(
      "Anchor review must contain only the planned constraints",
    );
  }
}

export function verifyIterationCompletion(
  requested: GenerationIterationPlan,
  review: IterationAnchorReview | undefined,
  jobId: string,
  imageSha256: string,
  context?: IterationJobContext,
  direction?: IterationDirection,
): void {
  if (!context) {
    verifyIterationAnchorReview(requested, review, jobId, imageSha256);
    return;
  }
  if (
    !direction ||
    direction.plan.temperature !== requested.temperature ||
    requested.mandatoryAnchors.some(
      (anchor) => !direction.plan.mandatoryAnchors.includes(anchor),
    ) ||
    requested.exclusions.some(
      (exclusion) => !direction.plan.exclusions.includes(exclusion),
    )
  ) {
    throw new InvalidIterationReviewError(
      "The planned direction must honor the requested temperature and constraints",
    );
  }
  if (
    imageSha256 === context.winnerImageSha256 ||
    imageSha256 === context.sourceImageSha256
  ) {
    throw new InvalidIterationReviewError(
      "The challenger must be a new independent image",
    );
  }
  verifyIterationAnchorReview(direction.plan, review, jobId, imageSha256);
  if (!review?.observedFingerprint) {
    throw new InvalidIterationReviewError(
      "The review needs a visual observation of the challenger",
    );
  }
}
