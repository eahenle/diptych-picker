import { isDeepStrictEqual } from "node:util";
import {
  drawFallbackBatch,
  popReady,
  type BufferedCandidate,
  type ChallengerState,
  type PendingComparisonReceipt,
  type PendingSelectionBaseline,
} from "@/domain/challenger-state";
import {
  candidateAt,
  completeBothLose,
  completeChampionRetirement,
  completeSelection,
  completeTie,
  oppositeSide,
  type Candidate,
  type GameRules,
  type GameState,
} from "@/domain/game";
import {
  deriveDequeueOperationId,
  type ImportSession,
  type ImportSupplySnapshot,
} from "@/domain/import-session";
import type { CandidateDequeueService } from "./candidate-dequeue-service";
import type { ChallengerRepository } from "./challenger-repository";
import { applyAdaptivePreferences } from "./game-adaptation";
import {
  comparisonReceipt,
  recordBothLose,
  recordComparison,
  recordTie,
} from "./game-comparison";
import type { GameRepository } from "./repository";
import type { ImportSessionRepository } from "./import-session-repository";
import type { LockedStateContext } from "./state-lock-coordinator";

interface PreparedSelectionReconcilerOptions {
  gameRepository: GameRepository;
  challengerRepository: ChallengerRepository;
  initialRating: number;
  eloKFactor: number;
  fallbackDelayMs: number;
  now: () => string;
  random: () => number;
  rulesFor: (game: GameState) => GameRules;
  importSessionRepository?: ImportSessionRepository;
  candidateDequeueService?: Pick<CandidateDequeueService, "dequeueLocked">;
}

export interface PreparedSelectionResult {
  game: GameState;
  challengers: ChallengerState;
  importSupply?: ImportSupplySnapshot;
}

export class PreparedSelectionReconciler {
  constructor(private readonly options: PreparedSelectionReconcilerOptions) {}

  async prepare(
    game: GameState,
    challengers: ChallengerState,
  ): Promise<ChallengerState> {
    const pending = game.pendingSelection;
    if (
      game.round.status !== "generating" ||
      !pending ||
      (pending.kind !== "buffer" &&
        pending.kind !== "retirement" &&
        pending.kind !== "tie" &&
        pending.kind !== "both-lose")
    ) {
      if (
        challengers.pendingComparison === null &&
        !challengers.pendingSelectionBaseline
      ) {
        return challengers;
      }
      const cleaned = {
        ...challengers,
        pendingComparison: null,
        pendingSelectionBaseline: null,
      };
      await this.options.challengerRepository.save(cleaned);
      return cleaned;
    }

    const receipt: PendingComparisonReceipt =
      pending.kind === "tie" || pending.kind === "both-lose"
        ? {
            kind: pending.kind,
            selectedAt: pending.selectedAt,
            roundNumber: game.round.roundNumber,
            leftId: game.round.leftCandidate.id,
            rightId: game.round.rightCandidate.id,
          }
        : comparisonReceipt(game, pending.winnerSide, pending.selectedAt);
    if (isDeepStrictEqual(challengers.pendingComparison, receipt)) {
      return challengers;
    }
    if (challengers.pendingComparison !== null) {
      throw new Error(
        "Persisted comparison receipt does not match the pending selection",
      );
    }

    const baseline = challengers.pendingSelectionBaseline
      ? challengers
      : {
          ...challengers,
          pendingSelectionBaseline: this.baseline(challengers),
        };
    const ratingConfig = {
      initialRating: this.options.initialRating,
      eloKFactor: this.options.eloKFactor,
      poolMaximum: this.options.rulesFor(game).poolMaximum,
    };
    const compared =
      pending.kind === "tie"
        ? recordTie(
            baseline,
            game.round.leftCandidate,
            game.round.rightCandidate,
            receipt,
            ratingConfig,
          )
        : pending.kind === "both-lose"
          ? recordBothLose(
              baseline,
              game.round.leftCandidate,
              game.round.rightCandidate,
              receipt,
              this.options.initialRating,
            )
          : recordComparison(
              baseline,
              candidateAt(game.round, pending.winnerSide),
              candidateAt(game.round, oppositeSide(pending.winnerSide)),
              receipt,
              ratingConfig,
            );
    await this.options.challengerRepository.save(compared);
    return compared;
  }

  async complete(
    game: GameState,
    challengers: ChallengerState,
    lockContext?: LockedStateContext,
  ): Promise<PreparedSelectionResult> {
    if (game.round.status !== "generating" || !game.pendingSelection) {
      return { game, challengers };
    }

    if (game.pendingSelection.kind === "retirement") {
      if (lockContext && this.options.candidateDequeueService) {
        const replacements = await this.drawPairSourceAware(
          lockContext,
          game,
          challengers,
          "retirement",
        );
        if (!replacements.candidates) {
          return {
            game,
            challengers: replacements.challengers,
            importSupply: replacements.importSupply,
          };
        }
        const adapted = applyAdaptivePreferences(
          completeChampionRetirement(game, ...replacements.candidates),
          replacements.challengers,
        );
        await this.options.gameRepository.save(adapted.game);
        const finalized = this.finalize(adapted.challengers);
        await this.options.challengerRepository.save(finalized);
        return {
          game: adapted.game,
          challengers: finalized,
          importSupply: replacements.importSupply,
        };
      }
      if (challengers.ready.length < 2) return { game, challengers };
      const leftDraw = popReady(challengers);
      const rightDraw = popReady(leftDraw.state);
      const adapted = applyAdaptivePreferences(
        completeChampionRetirement(
          game,
          leftDraw.candidate!,
          rightDraw.candidate!,
        ),
        rightDraw.state,
      );
      await this.options.gameRepository.save(adapted.game);
      const finalized = this.finalize(adapted.challengers);
      await this.options.challengerRepository.save(finalized);
      return { game: adapted.game, challengers: finalized };
    }

    if (
      game.pendingSelection.kind === "tie" ||
      game.pendingSelection.kind === "both-lose"
    ) {
      const outcome = game.pendingSelection.kind;
      if (lockContext && this.options.candidateDequeueService) {
        const replacements = await this.drawPairSourceAware(
          lockContext,
          game,
          challengers,
          outcome,
        );
        if (!replacements.candidates) {
          return {
            game,
            challengers: replacements.challengers,
            importSupply: replacements.importSupply,
          };
        }
        const completed =
          outcome === "tie"
            ? completeTie(game, ...replacements.candidates)
            : completeBothLose(game, ...replacements.candidates);
        const adapted =
          outcome === "both-lose"
            ? applyAdaptivePreferences(completed, replacements.challengers)
            : { game: completed, challengers: replacements.challengers };
        await this.options.gameRepository.save(adapted.game);
        const finalized = this.finalize(adapted.challengers);
        await this.options.challengerRepository.save(finalized);
        return {
          game: adapted.game,
          challengers: finalized,
          importSupply: replacements.importSupply,
        };
      }
      const replacements = this.drawPairReplacements(challengers, game);
      if (!replacements.candidates) {
        if (replacements.state !== challengers) {
          await this.options.challengerRepository.save(replacements.state);
        }
        return { game, challengers: replacements.state };
      }
      const completed =
        outcome === "tie"
          ? completeTie(game, ...replacements.candidates)
          : completeBothLose(game, ...replacements.candidates);
      const adapted =
        outcome === "both-lose"
          ? applyAdaptivePreferences(completed, replacements.state)
          : { game: completed, challengers: replacements.state };
      await this.options.gameRepository.save(adapted.game);
      const finalized = this.finalize(adapted.challengers);
      await this.options.challengerRepository.save(finalized);
      return { game: adapted.game, challengers: finalized };
    }

    if (game.pendingSelection.kind !== "buffer") {
      return { game, challengers };
    }

    if (lockContext && this.options.candidateDequeueService) {
      const dequeued = await this.dequeueSourceAware(
        lockContext,
        game,
        challengers,
        "single",
        "selection",
        [],
      );
      if (!dequeued.candidate) {
        return {
          game,
          challengers: dequeued.challengers,
          importSupply: dequeued.importSupply,
        };
      }
      const adapted = applyAdaptivePreferences(
        completeSelection(game, dequeued.candidate),
        dequeued.challengers,
      );
      await this.options.gameRepository.save(adapted.game);
      const finalized = this.finalize(adapted.challengers);
      await this.options.challengerRepository.save(finalized);
      return {
        game: adapted.game,
        challengers: finalized,
        importSupply: dequeued.importSupply,
      };
    }

    let draw = popReady(challengers);
    if (!draw.candidate) {
      const currentIds = new Set([
        game.round.leftCandidate.id,
        game.round.rightCandidate.id,
      ]);
      const preparedFallback = challengers.ratings.find(
        ({ candidate, lastServedAt }) =>
          lastServedAt === game.pendingSelection?.selectedAt &&
          !currentIds.has(candidate.id),
      )?.candidate;
      if (preparedFallback) {
        draw = { candidate: preparedFallback, state: challengers };
      }
    }
    if (!draw.candidate) return { game, challengers };

    const adapted = applyAdaptivePreferences(
      completeSelection(game, draw.candidate),
      draw.state,
    );
    await this.options.gameRepository.save(adapted.game);
    const finalized = this.finalize(adapted.challengers);
    if (
      adapted.challengers !== challengers ||
      challengers.pendingComparison !== null
    ) {
      await this.options.challengerRepository.save(finalized);
    }
    return { game: adapted.game, challengers: finalized };
  }

  async removeDisplayedCandidatesFromReady(
    game: GameState,
    challengers: ChallengerState,
  ): Promise<ChallengerState> {
    if (game.round.status !== "idle") return challengers;
    const displayedIds = new Set([
      game.round.leftCandidate.id,
      game.round.rightCandidate.id,
    ]);
    const ready = challengers.ready.filter(
      ({ candidate }) => !displayedIds.has(candidate.id),
    );
    if (ready.length === challengers.ready.length) return challengers;
    const cleaned = { ...challengers, ready };
    await this.options.challengerRepository.save(cleaned);
    return cleaned;
  }

  private async drawPairSourceAware(
    context: LockedStateContext,
    game: GameState,
    challengers: ChallengerState,
    reason: "retirement" | "tie" | "both-lose",
  ): Promise<{
    candidates: [Candidate, Candidate] | null;
    challengers: ChallengerState;
    importSupply: ImportSupplySnapshot;
  }> {
    const left = await this.dequeueSourceAware(
      context,
      game,
      challengers,
      "pair-left",
      reason,
      [],
    );
    if (!left.candidate) {
      return {
        candidates: null,
        challengers: left.challengers,
        importSupply: left.importSupply,
      };
    }
    const right = await this.dequeueSourceAware(
      context,
      game,
      left.challengers,
      "pair-right",
      reason,
      [left.candidate.id],
    );
    return {
      candidates: right.candidate ? [left.candidate, right.candidate] : null,
      challengers: right.challengers,
      importSupply: right.importSupply,
    };
  }

  private async dequeueSourceAware(
    context: LockedStateContext,
    game: GameState,
    challengers: ChallengerState,
    replacementSlot: "single" | "pair-left" | "pair-right",
    reason: "selection" | "retirement" | "tie" | "both-lose",
    extraExcludedCandidateIds: string[],
  ) {
    const originalReceipt = challengers.pendingComparison;
    if (!originalReceipt) {
      throw new Error("Prepared selection is missing its comparison receipt");
    }
    const importSession = await this.options.importSessionRepository?.load();
    const importSessionId = activatedImportSessionId(importSession ?? null);
    const request = {
      importSessionId,
      challengerSessionId: challengers.sessionId,
      originalReceipt,
      replacementSlot,
      reason,
      invocation: "prepared-recovery" as const,
      roundNumber: game.round.roundNumber + 1,
      excludedCandidateIds: [
        game.round.leftCandidate.id,
        game.round.rightCandidate.id,
        ...extraExcludedCandidateIds,
      ],
    };
    return this.options.candidateDequeueService!.dequeueLocked(context, {
      ...request,
      dequeueOperationId: deriveDequeueOperationId(
        request.importSessionId,
        request.challengerSessionId,
        request.originalReceipt,
        request.replacementSlot,
      ),
    });
  }

  drawPairReplacements(
    state: ChallengerState,
    game: GameState,
  ): {
    candidates: [Candidate, Candidate] | null;
    readyHeads: BufferedCandidate[];
    state: ChallengerState;
  } {
    const readyHeads = state.ready.slice(0, 2);
    const fallbackCount = 2 - readyHeads.length;
    if (fallbackCount === 0) {
      const leftDraw = popReady(state);
      const rightDraw = popReady(leftDraw.state);
      return {
        candidates: [leftDraw.candidate!, rightDraw.candidate!],
        readyHeads,
        state: rightDraw.state,
      };
    }

    const recentCandidateIds = game.history
      .slice(-10)
      .flatMap((decision) =>
        decision.outcome === "tie" || decision.outcome === "both-lose"
          ? [decision.leftId, decision.rightId]
          : [decision.winnerId, decision.loserId],
      );
    const rules = this.options.rulesFor(game);
    const fallback = drawFallbackBatch(
      state,
      {
        now: this.options.now(),
        currentCandidateIds: [
          game.round.leftCandidate.id,
          game.round.rightCandidate.id,
          ...readyHeads.map(({ candidate }) => candidate.id),
        ],
        recentCandidateIds,
        random: this.options.random,
        delayMs: this.options.fallbackDelayMs,
        maximumConsecutiveDraws: rules.fallbackMaximumConsecutive,
      },
      fallbackCount,
    );
    if (fallback.candidates.length < fallbackCount) {
      return { candidates: null, readyHeads: [], state: fallback.state };
    }

    return {
      candidates: [
        ...readyHeads.map(({ candidate }) => candidate),
        ...fallback.candidates,
      ] as [Candidate, Candidate],
      readyHeads,
      state: {
        ...fallback.state,
        ready: fallback.state.ready.slice(readyHeads.length),
      },
    };
  }

  baseline(state: ChallengerState): PendingSelectionBaseline {
    return {
      ready: state.ready,
      importQueue: state.importQueue,
      ratings: state.ratings,
      generationTurnaroundEmaMs: state.generationTurnaroundEmaMs,
      consecutiveFallbackDraws: state.consecutiveFallbackDraws,
      nextFallbackAt: state.nextFallbackAt,
    };
  }

  private finalize(state: ChallengerState): ChallengerState {
    return {
      ...state,
      pendingComparison: null,
      preparedDequeues: [],
      pendingSelectionBaseline: null,
    };
  }
}

function activatedImportSessionId(
  session: ImportSession | null,
): string | null {
  return session?.activatedAt &&
    (session.status === "active" || session.status === "completed")
    ? session.id
    : null;
}
