import type { CandidateRating } from "@/domain/challenger-state";

export function candidateSourceLabel(
  source: CandidateRating["source"],
): string {
  switch (source) {
    case "curated":
      return "Curated";
    case "generated":
      return "Generated";
    case "imported":
      return "Imported";
  }
}
