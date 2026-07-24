import type {
  Candidate,
  GameState,
  GenerationPromptCard,
  PromptCard,
  PromptCardBlendRequest,
  PromptCardEditorRequest,
  PromptCardWriterRequest,
  PromptCardWriterSource,
  PromptCardVerdict,
  PromptDeck,
} from "./game";

export const PROMPT_CARD_EDITOR_REJECTION_THRESHOLD = 4;
export const PROMPT_CARD_EDITOR_VERDICT_WINDOW = 12;

export interface CreatePromptCardInput {
  title: string;
  prompt: string;
  negativePrompt: string;
  weight: number;
  tags: string[];
  parents?: string[];
  sourceCandidateIds?: string[];
}

export function emptyPromptDeck(): PromptDeck {
  return {
    enabled: false,
    cards: [],
    verdicts: [],
    editorJob: null,
    blendJob: null,
    writerJob: null,
    suggestions: [],
  };
}

export function createPromptCard(
  input: CreatePromptCardInput,
  id: string,
  createdAt: string,
): PromptCard {
  return {
    id,
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    negativePrompt: input.negativePrompt.trim(),
    weight: input.weight,
    tags: input.tags.map((tag) => tag.trim()).filter(Boolean),
    parents: input.parents ?? [],
    ...(input.sourceCandidateIds
      ? { sourceCandidateIds: [...input.sourceCandidateIds] }
      : {}),
    active: true,
    createdAt,
    stats: { wins: 0, rejects: 0 },
  };
}

export function preparePromptCardEditorJob(
  deck: PromptDeck,
  createId: () => string,
  createdAt: string,
): { deck: PromptDeck; job: PromptCardEditorRequest } | null {
  if (deck.editorJob) return null;
  const recentVerdicts = deck.verdicts.slice(
    -PROMPT_CARD_EDITOR_VERDICT_WINDOW,
  );
  const card = deck.cards.find((candidate) => {
    if (!candidate.active) return false;
    const checkpoint = candidate.editorRejectCheckpoint ?? 0;
    if (
      candidate.stats.rejects - checkpoint <
      PROMPT_CARD_EDITOR_REJECTION_THRESHOLD
    ) {
      return false;
    }
    return (
      recentVerdicts.filter(
        (verdict) =>
          verdict.cardId === candidate.id && verdict.verdict === "reject",
      ).length >= PROMPT_CARD_EDITOR_REJECTION_THRESHOLD
    );
  });
  if (!card) return null;
  const id = createId();
  const recentRejections = recentVerdicts
    .filter(
      (verdict) => verdict.cardId === card.id && verdict.verdict === "reject",
    )
    .map(({ resultId, reason, recordedAt }) => ({
      resultId,
      reason,
      recordedAt,
    }));
  const job: PromptCardEditorRequest = {
    id,
    kind: "prompt-card-editor",
    createdAt,
    card: {
      id: card.id,
      title: card.title,
      prompt: card.prompt,
      negativePrompt: card.negativePrompt,
      tags: card.tags,
    },
    recentRejections,
  };
  return {
    job,
    deck: {
      ...deck,
      cards: deck.cards.map((candidate) =>
        candidate.id === card.id
          ? { ...candidate, editorRejectCheckpoint: candidate.stats.rejects }
          : candidate,
      ),
      editorJob: {
        jobId: id,
        cardId: card.id,
        enqueuedAt: createdAt,
        previousRejectCheckpoint: card.editorRejectCheckpoint ?? 0,
        expectedJob: job,
      },
    },
  };
}

export function drawPromptCard(
  deck: PromptDeck | undefined,
  random: () => number,
): GenerationPromptCard | null {
  if (!deck?.enabled) return null;
  const active = deck.cards.filter((card) => card.active && card.weight > 0);
  const total = active.reduce((sum, card) => sum + card.weight, 0);
  if (total <= 0) return null;
  const threshold = Math.min(Math.max(random(), 0), 0.999999999999) * total;
  let cumulative = 0;
  const selected =
    active.find((card) => {
      cumulative += card.weight;
      return threshold < cumulative;
    }) ?? active.at(-1)!;
  return generationPromptCard(selected);
}

export function createPromptCardBlendRequest(
  cards: [PromptCard, PromptCard],
  ratio: number,
  id: string,
  createdAt: string,
): PromptCardBlendRequest {
  return {
    id,
    kind: "prompt-card-blender",
    createdAt,
    cards: cards.map(generationPromptCard) as [
      GenerationPromptCard,
      GenerationPromptCard,
    ],
    ratio,
  };
}

export function createPromptCardWriterRequest(
  sources: PromptCardWriterSource[],
  id: string,
  createdAt: string,
): PromptCardWriterRequest {
  return {
    id,
    kind: "prompt-card-writer",
    createdAt,
    sources,
  };
}

export function recordPromptCardDecision(
  game: GameState,
  winners: readonly Candidate[],
  rejected: readonly Candidate[],
  recordedAt: string,
  reason: string,
): GameState {
  if (!game.promptDeck) return game;
  const knownCardIds = new Set(game.promptDeck.cards.map((card) => card.id));
  const wins = countCardIds(winners, knownCardIds);
  const rejects = countCardIds(rejected, knownCardIds);
  if (wins.size === 0 && rejects.size === 0) return game;

  const verdicts: PromptCardVerdict[] = [
    ...winners.flatMap((candidate) =>
      candidate.promptCardId && knownCardIds.has(candidate.promptCardId)
        ? [
            {
              cardId: candidate.promptCardId,
              resultId: candidate.id,
              verdict: "win" as const,
              reason,
              recordedAt,
            },
          ]
        : [],
    ),
    ...rejected.flatMap((candidate) =>
      candidate.promptCardId && knownCardIds.has(candidate.promptCardId)
        ? [
            {
              cardId: candidate.promptCardId,
              resultId: candidate.id,
              verdict: "reject" as const,
              reason,
              recordedAt,
            },
          ]
        : [],
    ),
  ];
  return {
    ...game,
    promptDeck: {
      ...game.promptDeck,
      cards: game.promptDeck.cards.map((card) => {
        const winCount = wins.get(card.id) ?? 0;
        const rejectCount = rejects.get(card.id) ?? 0;
        return winCount === 0 && rejectCount === 0
          ? card
          : {
              ...card,
              weight: Math.min(100, card.weight * 1.1 ** winCount),
              stats: {
                wins: card.stats.wins + winCount,
                rejects: card.stats.rejects + rejectCount,
              },
            };
      }),
      verdicts: [...game.promptDeck.verdicts, ...verdicts].slice(-200),
    },
  };
}

function countCardIds(
  candidates: readonly Candidate[],
  knownCardIds: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { promptCardId } of candidates) {
    if (promptCardId && knownCardIds.has(promptCardId))
      counts.set(promptCardId, (counts.get(promptCardId) ?? 0) + 1);
  }
  return counts;
}

function generationPromptCard(card: PromptCard): GenerationPromptCard {
  return {
    id: card.id,
    title: card.title,
    prompt: card.prompt,
    negativePrompt: card.negativePrompt,
    tags: card.tags,
  };
}
