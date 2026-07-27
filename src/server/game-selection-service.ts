import {
  popReady,
  type BufferedCandidate,
  type CandidateDraw,
  type ChallengerState,
  type PendingComparisonReceipt,
} from "@/domain/challenger-state";
import {
  beginChampionRetirement,
  beginBothLose,
  beginBufferedSelection,
  beginTie,
  candidateAt,
  completeBothLose,
  completeChampionRetirement,
  completeSelection,
  completeTie,
  oppositeSide,
  willRetireChampion,
  type GameRules,
  type GameState,
  type Side,
} from "@/domain/game";
import { recordPromptCardDecision } from "@/domain/prompt-deck";
import type { ChallengerRepository } from "./challenger-repository";
import { applyAdaptivePreferences } from "./game-adaptation";
import {
  MissingGameError,
  SelectionConflictError,
} from "./game-service-errors";
import {
  comparisonReceipt,
  recordBothLose,
  recordComparison,
  recordTie,
  tieReferenceSide,
} from "./game-comparison";
import type { GenerationJobPublisher } from "./generation-job-publisher";
import type { PreparedSelectionReconciler } from "./prepared-selection-reconciler";
import type { PromptCardReconciler } from "./prompt-card-reconciler";
import type { RefillCapacityService } from "./refill-capacity-service";
import type { GameRepository } from "./repository";

interface GameSelectionServiceOptions {
  gameRepository: GameRepository;
  challengerRepository: ChallengerRepository;
  promptCardReconciler: Pick<PromptCardReconciler, "reconcileEditor">;
  preparedSelectionReconciler: Pick<
    PreparedSelectionReconciler,
    "baseline" | "drawPairReplacements"
  >;
  refillCapacityService: Pick<RefillCapacityService, "plan">;
  generationJobPublisher: Pick<GenerationJobPublisher, "ensureAll">;
  config: {
    initialRating: number;
    eloKFactor: number;
  };
  rulesFor: (game: GameState) => GameRules;
  drawFallback: (state: ChallengerState, game: GameState) => CandidateDraw;
  now: () => string;
}

export class GameSelectionService {
  constructor(private readonly options: GameSelectionServiceOptions) {}

  async select(
    winnerSide: Side,
    expectedRoundNumber: number,
  ): Promise<GameState> {
    return this.withStateLocks(async () => {
      const current = await this.options.gameRepository.load();
      if (!current) {
        throw new MissingGameError("Start a game before choosing an image");
      }
      if (current.round.roundNumber !== expectedRoundNumber) {
        throw new SelectionConflictError(
          "The round changed before this selection arrived",
        );
      }

      const challengerState = await this.options.challengerRepository.load();
      if (!challengerState) {
        throw new MissingGameError(
          "Start a game before choosing a buffered challenger",
        );
      }

      const selectedAt = this.options.now();
      const rules = this.options.rulesFor(current);
      const retirement = willRetireChampion(
        current,
        winnerSide,
        rules.championRetirementStreak,
      );
      const inFlight = retirement
        ? beginChampionRetirement(
            current,
            winnerSide,
            selectedAt,
            rules.championRetirementStreak,
          )
        : beginBufferedSelection(current, winnerSide, selectedAt);
      if (!inFlight) {
        throw new SelectionConflictError(
          "A challenger is already being generated",
        );
      }

      const retainedWinner = candidateAt(current.round, winnerSide);
      const rejectedCandidate = candidateAt(
        current.round,
        oppositeSide(winnerSide),
      );
      let nextChallengers = recordComparison(
        {
          ...challengerState,
          pendingSelectionBaseline:
            this.options.preparedSelectionReconciler.baseline(challengerState),
        },
        retainedWinner,
        rejectedCandidate,
        comparisonReceipt(current, winnerSide, selectedAt),
        { ...this.options.config, poolMaximum: rules.poolMaximum },
      );
      let preparedReadyHeads: BufferedCandidate[] = [];
      let nextGame = inFlight;
      if (retirement) {
        if (nextChallengers.ready.length >= 2) {
          preparedReadyHeads = nextChallengers.ready.slice(0, 2);
          const leftDraw = popReady(nextChallengers);
          const rightDraw = popReady(leftDraw.state);
          nextChallengers = rightDraw.state;
          nextGame = completeChampionRetirement(
            inFlight,
            leftDraw.candidate!,
            rightDraw.candidate!,
          );
        }
      } else {
        let draw = popReady(nextChallengers);
        if (draw.candidate) {
          preparedReadyHeads = nextChallengers.ready.slice(0, 1);
          nextChallengers = draw.state;
          nextGame = completeSelection(inFlight, draw.candidate);
        } else {
          draw = this.options.drawFallback(nextChallengers, current);
          nextChallengers = draw.state;
          if (draw.candidate) {
            nextGame = completeSelection(inFlight, draw.candidate);
          }
        }
      }

      nextGame = recordPromptCardDecision(
        nextGame,
        [retainedWinner],
        [rejectedCandidate],
        selectedAt,
        "Selected comparison winner",
      );
      const adapted = applyAdaptivePreferences(nextGame, nextChallengers);
      nextGame = adapted.game;
      nextChallengers = adapted.challengers;
      const capacity = this.options.refillCapacityService.plan(
        nextChallengers,
        {
          game: nextGame,
          winnerSide,
          retainedWinner,
          rejectedCandidate,
        },
      );
      const durableChallengers =
        preparedReadyHeads.length > 0
          ? {
              ...capacity.state,
              ready: [...preparedReadyHeads, ...capacity.state.ready],
            }
          : capacity.state;
      // Persist a replayable selection before committing either side of the
      // cross-repository transition. A prepared FIFO head remains durable
      // until the completed game round is safely stored.
      await this.options.gameRepository.save(
        recordPromptCardDecision(
          inFlight,
          [retainedWinner],
          [rejectedCandidate],
          selectedAt,
          "Selected comparison winner",
        ),
      );
      await this.options.challengerRepository.save(durableChallengers);
      await this.options.gameRepository.save(nextGame);
      nextGame =
        await this.options.promptCardReconciler.reconcileEditor(nextGame);
      if (nextGame.round.status === "idle") {
        await this.options.challengerRepository.save({
          ...capacity.state,
          pendingComparison: null,
          pendingSelectionBaseline: null,
        });
      }
      await this.options.generationJobPublisher.ensureAll(capacity.jobs);
      return nextGame;
    });
  }

  async tie(expectedRoundNumber: number): Promise<GameState> {
    return this.replacePair(expectedRoundNumber, "tie");
  }

  async bothLose(expectedRoundNumber: number): Promise<GameState> {
    return this.replacePair(expectedRoundNumber, "both-lose");
  }

  private async replacePair(
    expectedRoundNumber: number,
    outcome: "tie" | "both-lose",
  ): Promise<GameState> {
    return this.withStateLocks(async () => {
      const current = await this.options.gameRepository.load();
      if (!current) {
        throw new MissingGameError(
          outcome === "tie"
            ? "Start a game before declaring a tie"
            : "Start a game before rejecting both candidates",
        );
      }
      if (current.round.roundNumber !== expectedRoundNumber) {
        throw new SelectionConflictError(
          outcome === "tie"
            ? "The round changed before this tie arrived"
            : "The round changed before this dual rejection arrived",
        );
      }

      const challengerState = await this.options.challengerRepository.load();
      if (!challengerState) {
        throw new MissingGameError(
          "Start a game before replacing tied candidates",
        );
      }

      const selectedAt = this.options.now();
      const referenceSide = tieReferenceSide(
        current,
        challengerState,
        this.options.config.initialRating,
      );
      const inFlight =
        outcome === "tie"
          ? beginTie(current, referenceSide, selectedAt)
          : beginBothLose(current, referenceSide, selectedAt);
      if (!inFlight) {
        throw new SelectionConflictError(
          "A challenger is already being generated",
        );
      }

      const left = current.round.leftCandidate;
      const right = current.round.rightCandidate;
      const receipt: PendingComparisonReceipt = {
        kind: outcome,
        selectedAt,
        roundNumber: current.round.roundNumber,
        leftId: left.id,
        rightId: right.id,
      };
      const baseline = {
        ...challengerState,
        pendingSelectionBaseline:
          this.options.preparedSelectionReconciler.baseline(challengerState),
      };
      let nextChallengers =
        outcome === "tie"
          ? recordTie(baseline, left, right, receipt, {
              ...this.options.config,
              poolMaximum: this.options.rulesFor(current).poolMaximum,
            })
          : recordBothLose(
              baseline,
              left,
              right,
              receipt,
              this.options.config.initialRating,
            );
      let preparedReadyHeads: BufferedCandidate[] = [];
      let nextGame = inFlight;
      const replacements =
        this.options.preparedSelectionReconciler.drawPairReplacements(
          nextChallengers,
          current,
        );
      nextChallengers = replacements.state;
      if (replacements.candidates) {
        preparedReadyHeads = replacements.readyHeads;
        nextGame =
          outcome === "tie"
            ? completeTie(inFlight, ...replacements.candidates)
            : completeBothLose(inFlight, ...replacements.candidates);
      }

      if (outcome === "both-lose") {
        nextGame = recordPromptCardDecision(
          nextGame,
          [],
          [left, right],
          selectedAt,
          "Both images rejected",
        );
      }

      if (outcome === "both-lose" && nextGame.round.status === "idle") {
        const adapted = applyAdaptivePreferences(nextGame, nextChallengers);
        nextGame = adapted.game;
        nextChallengers = adapted.challengers;
      }

      const reference = candidateAt(current.round, referenceSide);
      const contrasted = candidateAt(
        current.round,
        oppositeSide(referenceSide),
      );
      const capacity = this.options.refillCapacityService.plan(
        nextChallengers,
        {
          game: nextGame,
          winnerSide: referenceSide,
          retainedWinner: reference,
          rejectedCandidate: contrasted,
          comparisonOutcome: outcome,
        },
      );
      const durableChallengers =
        preparedReadyHeads.length > 0
          ? {
              ...capacity.state,
              ready: [...preparedReadyHeads, ...capacity.state.ready],
            }
          : capacity.state;
      await this.options.gameRepository.save(
        outcome === "both-lose"
          ? recordPromptCardDecision(
              inFlight,
              [],
              [left, right],
              selectedAt,
              "Both images rejected",
            )
          : inFlight,
      );
      await this.options.challengerRepository.save(durableChallengers);
      await this.options.gameRepository.save(nextGame);
      nextGame =
        await this.options.promptCardReconciler.reconcileEditor(nextGame);
      if (nextGame.round.status === "idle") {
        await this.options.challengerRepository.save({
          ...capacity.state,
          pendingComparison: null,
          pendingSelectionBaseline: null,
        });
      }
      await this.options.generationJobPublisher.ensureAll(capacity.jobs);
      return nextGame;
    });
  }

  private withStateLocks<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.gameRepository.withLock(() =>
      this.options.challengerRepository.withLock(operation),
    );
  }
}
