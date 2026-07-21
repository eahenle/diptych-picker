import type {
  Candidate,
  GameState,
  GenerationPromptCard,
  PromptCard,
  PromptCardVerdict,
  PromptDeck,
} from "./game";

export interface CreatePromptCardInput {
  title: string;
  prompt: string;
  negativePrompt: string;
  weight: number;
  tags: string[];
  parents?: string[];
}

export function emptyPromptDeck(): PromptDeck {
  return { enabled: false, cards: [], verdicts: [] };
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
    active: true,
    createdAt,
    stats: { wins: 0, rejects: 0 },
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
  return {
    id: selected.id,
    title: selected.title,
    prompt: selected.prompt,
    negativePrompt: selected.negativePrompt,
    tags: selected.tags,
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
