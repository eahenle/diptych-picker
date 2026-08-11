import type { ChallengerRepository } from "./challenger-repository";
import type { ImportActivationIntentRepository } from "./import-activation-intent-repository";
import type { ImportSessionRepository } from "./import-session-repository";
import type { InitialBootstrapRepository } from "./initial-bootstrap";
import type { GameRepository } from "./repository";

export type StateRepositoryName =
  | "activation-intent"
  | "import-session"
  | "game"
  | "challenger"
  | "initial-bootstrap";

const canonicalOrder: readonly StateRepositoryName[] = [
  "activation-intent",
  "import-session",
  "game",
  "challenger",
  "initial-bootstrap",
];

const lockedStateContextBrand: unique symbol = Symbol("LockedStateContext");

export interface LockedStateContext {
  readonly [lockedStateContextBrand]: true;
  readonly held: ReadonlySet<StateRepositoryName>;
}

interface LockableRepository {
  withLock<T>(operation: () => Promise<T>): Promise<T>;
}

export interface StateLockRepositories {
  activationIntent: Pick<ImportActivationIntentRepository, "withLock">;
  importSession: Pick<ImportSessionRepository, "withLock">;
  game: Pick<GameRepository, "withLock">;
  challenger: Pick<ChallengerRepository, "withLock">;
  initialBootstrap: Pick<InitialBootstrapRepository, "withLock">;
}

export class StateLockCoordinator {
  private readonly repositories: Record<
    StateRepositoryName,
    LockableRepository
  >;

  constructor(repositories: StateLockRepositories) {
    this.repositories = {
      "activation-intent": repositories.activationIntent,
      "import-session": repositories.importSession,
      game: repositories.game,
      challenger: repositories.challenger,
      "initial-bootstrap": repositories.initialBootstrap,
    };
  }

  async withStateLocks<T>(
    requested: readonly StateRepositoryName[],
    operation: (context: LockedStateContext) => Promise<T>,
  ): Promise<T> {
    const held = new Set(requested);
    const ordered = canonicalOrder.filter((name) => held.has(name));
    if (ordered.length !== held.size) {
      throw new Error("Unknown state repository lock requested");
    }
    const context: LockedStateContext = {
      [lockedStateContextBrand]: true,
      held,
    };
    const acquire = async (index: number): Promise<T> => {
      const name = ordered[index];
      if (!name) return operation(context);
      return this.repositories[name].withLock(() => acquire(index + 1));
    };
    return acquire(0);
  }
}

export function requireStateLocks(
  context: LockedStateContext,
  required: readonly StateRepositoryName[],
): void {
  for (const name of required) {
    if (!context.held.has(name)) {
      throw new Error(`State lock ${name} is required for this operation`);
    }
  }
}
