import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dataDirectory = join(process.cwd(), ".local-data", "test");
const challengerStatePath = join(dataDirectory, "challenger-state.json");

interface StoredChallengerState {
  ready: Array<{ candidate: { id: string } }>;
  refillJobs: Array<{ jobId: string }>;
  consecutiveFallbackDraws: number;
  nextFallbackAt: string | null;
}

async function challengerState(): Promise<StoredChallengerState> {
  return JSON.parse(
    await readFile(challengerStatePath, "utf8"),
  ) as StoredChallengerState;
}

async function updateChallengerState(
  update: (state: StoredChallengerState) => StoredChallengerState,
): Promise<void> {
  const next = update(await challengerState());
  await writeFile(
    challengerStatePath,
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
}

async function select(
  page: Page,
  side: "left" | "right",
  expectedRound: number,
  expectedStatus = 200,
) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game/select") &&
      response.request().method() === "POST",
  );
  await page.getByTestId(`candidate-card-${side}`).click();
  const response = await responsePromise;
  expect(response.status()).toBe(expectedStatus);
  await expect(
    page.getByText(`Round ${expectedRound}`, { exact: true }),
  ).toBeVisible();
  return response;
}

async function reconcileAllRefills(request: APIRequestContext): Promise<void> {
  await expect
    .poll(
      async () => {
        await request.get("/api/game");
        try {
          return (await challengerState()).refillJobs.length;
        } catch {
          return 0;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(0);
}

test.beforeEach(async ({ page, request }) => {
  await rm(dataDirectory, { recursive: true, force: true });
  await request.post("/api/game/start", { data: { reset: true } });
  await expect
    .poll(async () => {
      const response = await request.get("/api/game");
      return (await response.json()).status;
    })
    .toBe("ready");
  await page.goto("/");
  await expect(page).toHaveTitle("Dipycker");
  await expect(page.getByRole("heading", { name: "Dipycker" })).toBeVisible();
  await expect(page.getByTestId("candidate-image")).toHaveCount(2);
});

test.afterEach(async ({ request }) => {
  await reconcileAllRefills(request);
});

test("starts with five durable challengers and adapts two independent images to the viewport", async ({
  page,
}) => {
  const images = page.getByTestId("candidate-image");
  const displayedIds = await Promise.all([
    page.getByTestId("candidate-card-left").getAttribute("data-candidate-id"),
    page.getByTestId("candidate-card-right").getAttribute("data-candidate-id"),
  ]);
  const stored = await challengerState();

  expect(stored.ready).toHaveLength(5);
  await expect(
    page.getByLabel("Ready queue 5 of 5; 0 generating"),
  ).toBeVisible();
  await expect(
    page.getByLabel("View pool leaderboard; 7 of 50 reusable images"),
  ).toBeVisible();
  await expect(page.getByTestId("candidate-card-left")).toContainText(
    /Elo\s*1000/,
  );
  await expect(page.getByTestId("candidate-card-right")).toContainText(
    /Elo\s*1000/,
  );
  expect(stored.ready.map(({ candidate }) => candidate.id)).not.toContain(
    displayedIds[0],
  );
  expect(stored.ready.map(({ candidate }) => candidate.id)).not.toContain(
    displayedIds[1],
  );
  expect(
    await images.evaluateAll((items) =>
      items.every((item, index) =>
        items.every((other, otherIndex) =>
          index === otherIndex ? true : item !== other,
        ),
      ),
    ),
  ).toBe(true);

  const desktop = await Promise.all([
    images.nth(0).boundingBox(),
    images.nth(1).boundingBox(),
  ]);
  expect(Math.abs(desktop[0]!.y - desktop[1]!.y)).toBeLessThan(2);
  expect(desktop[0]!.x).toBeLessThan(desktop[1]!.x);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await Promise.all([
    images.nth(0).boundingBox(),
    images.nth(1).boundingBox(),
  ]);
  expect(mobile[1]!.y).toBeGreaterThan(mobile[0]!.y + mobile[0]!.height);
  expect(Math.abs(mobile[0]!.x - mobile[1]!.x)).toBeLessThan(2);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("opens a display-safe reusable-pool leaderboard", async ({
  page,
  request,
}) => {
  await page
    .getByRole("button", {
      name: "View pool leaderboard; 7 of 50 reusable images",
    })
    .click();

  const dialog = page.getByRole("dialog", { name: "Pool leaderboard" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("listitem")).toHaveCount(7);
  await expect(dialog.getByText(/1000/)).toHaveCount(7);

  const response = await request.get("/api/game/leaderboard");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.entries).toHaveLength(7);
  expect(JSON.stringify(body)).not.toContain('"prompt"');
});

test("exports the last stable comparison while a challenger is loading", async ({
  page,
  request,
}) => {
  await updateChallengerState((state) => ({
    ...state,
    ready: [],
    consecutiveFallbackDraws: 10,
    nextFallbackAt: null,
  }));
  const exportResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game/snapshot") &&
      response.request().method() === "GET",
  );

  await select(page, "left", 1, 202);
  await expect(page.getByRole("button", { name: "Export" })).toBeEnabled();
  const directResponse = await request.get("/api/game/snapshot");
  expect(directResponse.status()).toBe(200);
  const snapshot = await directResponse.json();
  await page.getByRole("button", { name: "Export" }).click();

  const response = await exportResponse;
  expect(response.status()).toBe(200);
  expect(snapshot.game.round).toMatchObject({
    status: "idle",
    replacingSide: null,
    roundNumber: 1,
  });
  expect(snapshot.game.pendingSelection).toBeUndefined();
  expect(snapshot.challengers).toMatchObject({
    refillJobs: [],
    pendingComparison: null,
    pendingSelectionBaseline: null,
  });
});

test("persists a fine-grained preference profile and composes generation context", async ({
  page,
  request,
}) => {
  await page.getByRole("button", { name: "Preferences" }).click();
  await page
    .getByLabel("Themes & subjects")
    .fill("mythic engineering and strange nocturnal ecosystems");
  await page
    .getByLabel("Preferred media")
    .fill("large-format photography, linocut");
  await page
    .getByLabel("Visual style & mood")
    .fill("cinematic, tactile, and austere");
  await page
    .getByLabel("Color palette")
    .fill("ultraviolet, copper, and oxblood");
  await page.getByRole("radio", { name: /adult themes/i }).check();
  await page
    .getByLabel("Avoid or de-emphasize")
    .fill("readable text and cute mascots");

  const saveResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game") &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save profile" }).click();
  expect((await saveResponse).status()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.reload();
  await page.getByRole("button", { name: "Preferences" }).click();
  await expect(page.getByLabel("Preferred media")).toHaveValue(
    "large-format photography, linocut",
  );
  await expect(
    page.getByRole("radio", { name: /adult themes/i }),
  ).toBeChecked();

  const state = await (await request.get("/api/game")).json();
  expect(state.game.preferenceProfile).toMatchObject({
    themes: "mythic engineering and strange nocturnal ecosystems",
    contentLevel: "adult-allowed",
    avoid: "readable text and cute mascots",
  });
  expect(state.game.preferenceSeed).toContain(
    "Preferred media: large-format photography, linocut",
  );
  expect(state.game.preferenceSeed).toContain(
    "Content range: Adult themes may be used when relevant",
  );
});

test("exports the current game and restores it after later play", async ({
  page,
}) => {
  const savePath = join(dataDirectory, "saved-round.json");
  const originalIds = await Promise.all([
    page.getByTestId("candidate-card-left").getAttribute("data-candidate-id"),
    page.getByTestId("candidate-card-right").getAttribute("data-candidate-id"),
  ]);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^[a-f0-9]{64}\.json$/);
  await download.saveAs(savePath);

  await select(page, "left", 2);
  await expect(page.getByTestId("candidate-card-right")).not.toHaveAttribute(
    "data-candidate-id",
    originalIds[1]!,
  );

  await page.getByRole("button", { name: "Load", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Load saved game" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export current game first" }),
  ).toBeVisible();
  await page.getByLabel("Choose saved game file").setInputFiles(savePath);

  await expect(page.getByText("Round 1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Load saved game" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("candidate-card-left")).toHaveAttribute(
    "data-candidate-id",
    originalIds[0]!,
  );
  await expect(page.getByTestId("candidate-card-right")).toHaveAttribute(
    "data-candidate-id",
    originalIds[1]!,
  );
});

test("serves five instant FIFO swaps while preserving the winner node and URL", async ({
  page,
}) => {
  const winner = page.getByTestId("candidate-image").nth(0);
  const winnerUrl = await winner.getAttribute("src");
  const losingUrls = new Set<string>();
  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & { winnerNode?: Element | null }
    ).winnerNode = document.querySelector('[data-testid="candidate-image"]');
  });

  for (let round = 2; round <= 6; round += 1) {
    const loser = page.getByTestId("candidate-image").nth(1);
    const previousLoserUrl = await loser.getAttribute("src");
    const response = await select(page, "left", round);
    expect((await response.json()).round.status).toBe("idle");
    await expect(winner).toHaveAttribute("src", winnerUrl!);
    await expect(loser).not.toHaveAttribute("src", previousLoserUrl!);
    losingUrls.add((await loser.getAttribute("src"))!);
  }

  expect(losingUrls.size).toBe(5);
  expect(
    await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { winnerNode?: Element })
          .winnerNode ===
        document.querySelector('[data-testid="candidate-image"]'),
    ),
  ).toBe(true);
  expect(await challengerState()).toMatchObject({ ready: [] });
});

test("keeps stale FIFO work after a challenger becomes the next winner", async ({
  page,
}) => {
  await select(page, "left", 2);
  const challenger = page.getByTestId("candidate-image").nth(1);
  const challengerUrl = await challenger.getAttribute("src");
  const previousLeftUrl = await page
    .getByTestId("candidate-image")
    .nth(0)
    .getAttribute("src");
  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & { challengerNode?: Element | null }
    ).challengerNode = document.querySelectorAll(
      '[data-testid="candidate-image"]',
    )[1];
  });

  await select(page, "right", 3);

  await expect(challenger).toHaveAttribute("src", challengerUrl!);
  await expect(page.getByTestId("candidate-image").nth(0)).not.toHaveAttribute(
    "src",
    previousLeftUrl!,
  );
  expect(
    await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { challengerNode?: Element })
          .challengerNode ===
        document.querySelectorAll('[data-testid="candidate-image"]')[1],
    ),
  ).toBe(true);
  expect((await challengerState()).ready).toHaveLength(3);
});

test("refresh restores the current round and remaining FIFO exactly", async ({
  page,
}) => {
  await select(page, "left", 2);
  const beforeIds = await Promise.all([
    page.getByTestId("candidate-card-left").getAttribute("data-candidate-id"),
    page.getByTestId("candidate-card-right").getAttribute("data-candidate-id"),
  ]);
  const before = await challengerState();

  await page.reload();
  await expect(page.getByText("Round 2", { exact: true })).toBeVisible();

  await expect(page.getByTestId("candidate-card-left")).toHaveAttribute(
    "data-candidate-id",
    beforeIds[0]!,
  );
  await expect(page.getByTestId("candidate-card-right")).toHaveAttribute(
    "data-candidate-id",
    beforeIds[1]!,
  );
  const after = await challengerState();
  expect(after.ready).toEqual(before.ready);
  expect(after.refillJobs).toEqual(before.refillJobs);
});

test("double click consumes one challenger and advances one round", async ({
  page,
}) => {
  let selectionPosts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/game/select")
    ) {
      selectionPosts += 1;
    }
  });

  await page.getByTestId("candidate-card-left").dblclick();
  await expect(page.getByText("Round 2", { exact: true })).toBeVisible();
  await page.waitForTimeout(100);

  expect(selectionPosts).toBe(1);
  await expect(page.getByText("Round 3", { exact: true })).toHaveCount(0);
  expect((await challengerState()).ready).toHaveLength(4);
});

test("delays pool fallback, blocks an eleventh, and explains deferred Preferences save", async ({
  page,
}) => {
  await updateChallengerState((state) => ({ ...state, ready: [] }));

  const firstResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game/select") &&
      response.request().method() === "POST",
  );
  await page.getByTestId("candidate-card-left").click();
  expect((await firstResponse).status()).toBe(202);
  await expect(page.getByTestId("loading-right")).toBeVisible();
  await expect(page.getByText("Loading")).toBeVisible();
  const winner = page.getByTestId("candidate-image").nth(0);
  const winnerUrl = await winner.getAttribute("src");
  await expect(page.getByRole("button", { name: "Preferences" })).toBeEnabled();
  await page.getByRole("button", { name: "Preferences" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save profile" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Changes can be saved after this challenger arrives."),
  ).toBeVisible();
  await expect(page.getByText("Round 2", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save profile" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Cancel" }).click();

  await updateChallengerState((state) => ({
    ...state,
    ready: [],
    consecutiveFallbackDraws: 10,
  }));

  const eleventhResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game/select") &&
      response.request().method() === "POST",
  );
  await page.getByTestId("candidate-card-left").click();
  expect((await eleventhResponse).status()).toBe(202);
  await expect(page.getByTestId("loading-right")).toBeVisible();
  await expect(page.getByTestId("loading-left")).toHaveCount(0);
  await expect(winner).toHaveAttribute("src", winnerUrl!);
  await page.waitForTimeout(300);
  await expect(page.getByTestId("loading-right")).toBeVisible();
  expect((await challengerState()).consecutiveFallbackDraws).toBe(10);
  await expect(page.getByText("Round 3", { exact: true })).toBeVisible();
});
