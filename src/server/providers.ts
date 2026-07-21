import type {
  Candidate,
  PreferenceProfile,
  PreferenceRevision,
  SelectionHistory,
} from "@/domain/game";
import type { LeaderboardPreferenceEvidence } from "@/domain/challenger-state";

export interface ChallengerPromptInput {
  retainedWinner: Candidate;
  rejectedCandidate: Candidate;
  selectionHistory: SelectionHistory[];
  recentConcepts: string[];
  leaderboardEvidence?: LeaderboardPreferenceEvidence;
  preferenceSeed: string;
  preferenceProfile: PreferenceProfile;
}

export interface ProposedChallenger {
  concept: string;
  visualPrompt: string;
  styleTags: string[];
  reasoningSummary: string;
  preferenceRevision?: PreferenceRevision;
}

export interface ChallengerPromptProvider {
  propose(input: ChallengerPromptInput): Promise<ProposedChallenger>;
}

export interface GeneratedImage {
  bytes: Buffer;
  extension: "png" | "webp" | "svg";
  contentType: "image/png" | "image/webp" | "image/svg+xml";
  width: number;
  height: number;
}

export interface ImageProvider {
  generate(prompt: string): Promise<GeneratedImage>;
}

export interface StoredAsset {
  filename: string;
  url: string;
  byteLength: number;
}

export interface CompletedAssetMetadata {
  candidateId: string;
  filename: string;
  imageUrl: string;
  contentType: "image/png";
  width: number;
  height: number;
  byteLength: number;
}

export interface AssetStore {
  save(image: GeneratedImage & { id: string }): Promise<StoredAsset>;
  verify(asset: CompletedAssetMetadata): Promise<void>;
}

export interface ProviderBundle {
  promptProvider: ChallengerPromptProvider;
  imageProvider: ImageProvider;
  assetStore: AssetStore;
}
