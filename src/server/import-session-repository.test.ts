import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { session } from "@/domain/import-session.test";
import { JsonImportSessionRepository } from "./import-session-repository";

describe("JsonImportSessionRepository", () => {
  it("atomically saves and reloads a complete import session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-import-session-"));
    const repository = new JsonImportSessionRepository(
      join(directory, "import-session.json"),
    );
    const value = session();

    await repository.save(value);

    await expect(repository.load()).resolves.toEqual(value);
  });

  it("clears a saved import session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-import-session-"));
    const repository = new JsonImportSessionRepository(
      join(directory, "import-session.json"),
    );
    await repository.save(session());

    await repository.clear();

    await expect(repository.load()).resolves.toBeNull();
  });

  it("serializes operations across repository instances for one session file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-import-session-"));
    const file = join(directory, "import-session.json");
    const first = new JsonImportSessionRepository(file);
    const second = new JsonImportSessionRepository(file);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    const order: string[] = [];

    const firstOperation = first.withLock(async () => {
      order.push("first-entered");
      signalFirstEntered();
      await held;
      order.push("first-left");
    });
    await firstEntered;
    const secondOperation = second.withLock(async () => {
      order.push("second-entered");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(order).toEqual(["first-entered"]);
    release();
    await Promise.all([firstOperation, secondOperation]);
    expect(order).toEqual(["first-entered", "first-left", "second-entered"]);
  });
});
