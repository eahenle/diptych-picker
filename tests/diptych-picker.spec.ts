import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dataDirectory = join(process.cwd(), ".local-data", "test");
const challengerStatePath = join(dataDirectory, "challenger-state.json");

interface StoredChallengerState {
  ready: Array<{
    candidate: { id: string; preferenceRevision?: Record<string, unknown> };
  }>;
  refillJobs: Array<{ jobId: string }>;
  ratings: Array<{
    candidate: { id: string };
    poolMember: boolean;
  }>;
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
  expectedStatus: number | readonly number[] = 200,
) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game/select") &&
      response.request().method() === "POST",
  );
  await page.getByTestId(`candidate-card-${side}`).click();
  const response = await responsePromise;
  expect(
    Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus],
  ).toContain(response.status());
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
    page.getByLabel("View queue details; 5 ready, 0 generating, 0 waiting"),
  ).toBeVisible();
  await expect(
    page.getByLabel("View pool leaderboard; 7 of 50 reusable images"),
  ).toBeVisible();
  await expect(page.getByTitle("First appearance")).toHaveCount(2);
  await expect(page.getByTestId("candidate-card-left")).not.toContainText(
    "Elo",
  );
  await expect(page.getByTestId("candidate-card-right")).not.toContainText(
    "Elo",
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

test("declares an equal-Elo tie and replaces both active candidates", async ({
  page,
  request,
}) => {
  const originalIds = await Promise.all([
    page.getByTestId("candidate-card-left").getAttribute("data-candidate-id"),
    page.getByTestId("candidate-card-right").getAttribute("data-candidate-id"),
  ]);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game/select") &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: /declare tie/i }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({
    outcome: "tie",
    roundNumber: 1,
  });
  await expect(page.getByText("Round 2", { exact: true })).toBeVisible();
  await expect(page.getByTestId("candidate-card-left")).not.toHaveAttribute(
    "data-candidate-id",
    originalIds[0]!,
  );
  await expect(page.getByTestId("candidate-card-right")).not.toHaveAttribute(
    "data-candidate-id",
    originalIds[1]!,
  );

  const historyResponse = await request.get("/api/game/history");
  expect(historyResponse.status()).toBe(200);
  expect((await historyResponse.json()).entries[0]).toMatchObject({
    outcome: "tie",
    left: { id: originalIds[0] },
    right: { id: originalIds[1] },
  });
});

test("rejects both active candidates and removes them from the pool", async ({
  page,
  request,
}) => {
  const originalIds = await Promise.all([
    page.getByTestId("candidate-card-left").getAttribute("data-candidate-id"),
    page.getByTestId("candidate-card-right").getAttribute("data-candidate-id"),
  ]);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game/select") &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: /both lose/i }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({
    outcome: "both-lose",
    roundNumber: 1,
  });
  await expect(page.getByText("Round 2", { exact: true })).toBeVisible();

  const historyResponse = await request.get("/api/game/history");
  expect(historyResponse.status()).toBe(200);
  expect((await historyResponse.json()).entries[0]).toMatchObject({
    outcome: "both-lose",
    left: { id: originalIds[0] },
    right: { id: originalIds[1] },
  });

  expect((await request.get("/api/game")).status()).toBe(200);
  const leaderboardResponse = await request.get("/api/game/leaderboard");
  const poolIds = (await leaderboardResponse.json()).entries.map(
    (entry: { candidate: { id: string } }) => entry.candidate.id,
  );
  expect(poolIds).not.toContain(originalIds[0]);
  expect(poolIds).not.toContain(originalIds[1]);
});

test("loads a distinct pair from the pool after tying with an empty queue", async ({
  page,
}) => {
  const originalIds = await Promise.all([
    page.getByTestId("candidate-card-left").getAttribute("data-candidate-id"),
    page.getByTestId("candidate-card-right").getAttribute("data-candidate-id"),
  ]);
  const before = await challengerState();
  const eligiblePoolIds = before.ratings
    .filter(
      ({ candidate, poolMember }) =>
        poolMember && !originalIds.includes(candidate.id),
    )
    .map(({ candidate }) => candidate.id);
  await updateChallengerState((state) => ({ ...state, ready: [] }));
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game/select") &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: /declare tie/i }).click();
  expect((await responsePromise).status()).toBe(202);
  await expect(page.getByTestId("loading-left")).toBeVisible();
  await expect(page.getByTestId("loading-right")).toBeVisible();
  await expect(page.getByRole("button", { name: /declare tie/i })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: /both lose/i })).toHaveCount(0);
  await expect(page.getByText("Round 2", { exact: true })).toBeVisible({
    timeout: 5_000,
  });

  const replacementIds = await Promise.all([
    page.getByTestId("candidate-card-left").getAttribute("data-candidate-id"),
    page.getByTestId("candidate-card-right").getAttribute("data-candidate-id"),
  ]);
  expect(new Set(replacementIds).size).toBe(2);
  expect(replacementIds.every((id) => eligiblePoolIds.includes(id!))).toBe(
    true,
  );
});

test("opens either active image in a larger inspection view", async ({
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
  const leftSource = await page
    .getByTestId("candidate-image")
    .nth(0)
    .getAttribute("src");
  const leftConcept = await page
    .getByTestId("candidate-image")
    .nth(0)
    .getAttribute("alt");
  const rightConcept = await page
    .getByTestId("candidate-image")
    .nth(1)
    .getAttribute("alt");

  const leftInspectButton = page.getByRole("button", {
    name: "View image A larger",
  });
  await leftInspectButton.click();
  const leftDialog = page.getByRole("dialog", {
    name: /Expanded image:/,
  });
  await expect(leftDialog).toBeVisible();
  await expect(leftDialog.getByRole("img")).toHaveAttribute("src", leftSource!);
  const closeInspector = leftDialog.getByRole("button", {
    name: "Close expanded image",
  });
  await expect(closeInspector).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    leftDialog.getByRole("button", { name: "Previous expanded image" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    leftDialog.getByRole("button", { name: "Next expanded image" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    leftDialog.getByRole("button", { name: "Explore variations" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeInspector).toBeFocused();
  await page.keyboard.press("a");
  await expect(page.getByText("Round 1", { exact: true })).toBeVisible();
  expect(selectionPosts).toBe(0);
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("dialog", { name: `Expanded image: ${rightConcept}` }),
  ).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("dialog", { name: `Expanded image: ${leftConcept}` }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(leftDialog).toHaveCount(0);
  await expect(leftInspectButton).toBeFocused();

  await page.getByRole("button", { name: "View image B larger" }).click();
  await expect(
    page.getByRole("dialog", { name: /Expanded image:/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close expanded image" }).click();
  await expect(
    page.getByRole("dialog", { name: /Expanded image:/ }),
  ).toHaveCount(0);
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

  const firstCard = dialog
    .getByRole("button", { name: /View .* larger/ })
    .first();
  const thumbnailSource = await firstCard.locator("img").getAttribute("src");
  await firstCard.click();

  await expect(dialog).toHaveCount(0);
  const imageDialog = page.getByRole("dialog", {
    name: /Expanded image:/,
  });
  await expect(imageDialog).toBeVisible();
  await expect(imageDialog.getByRole("img")).toHaveAttribute(
    "src",
    thumbnailSource!,
  );
  await page.keyboard.press("Escape");
  await expect(imageDialog).toHaveCount(0);
});

test("opens a display-safe newest-first comparison history", async ({
  page,
  request,
}) => {
  await select(page, "left", 2);
  await page
    .getByRole("button", { name: "View comparison history; 1 decisions" })
    .click();

  const dialog = page.getByRole("dialog", { name: "Comparison history" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("listitem")).toHaveCount(1);
  await expect(dialog.getByText("Winner", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Rejected", { exact: true })).toBeVisible();

  const response = await request.get("/api/game/history");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.total).toBe(1);
  expect(body.entries).toHaveLength(1);
  expect(JSON.stringify(body)).not.toContain('"prompt"');

  const winner = body.entries[0].winner as {
    concept: string;
    imageUrl: string;
  };
  await dialog
    .getByRole("button", { name: `View ${winner.concept} larger` })
    .click();
  await expect(dialog).toHaveCount(0);
  const imageDialog = page.getByRole("dialog", {
    name: `Expanded image: ${winner.concept}`,
  });
  await expect(imageDialog.getByRole("img")).toHaveAttribute(
    "src",
    winner.imageUrl,
  );
  await page.keyboard.press("Escape");
  await expect(imageDialog).toHaveCount(0);
});

test("favorites a candidate across history, pool, refresh, and export", async ({
  page,
  request,
}) => {
  await select(page, "left", 2);
  await page
    .getByRole("button", { name: "View comparison history; 1 decisions" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Comparison history" });
  const historyResponse = await request.get("/api/game/history");
  const history = await historyResponse.json();
  const winner = history.entries[0].winner as {
    id: string;
    concept: string;
  };

  const favoriteResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game/favorites") &&
      response.request().method() === "PUT",
  );
  await dialog
    .getByRole("button", {
      name: `Add ${winner.concept} to favorites`,
    })
    .click();
  expect((await favoriteResponse).status()).toBe(200);
  await expect(
    dialog.getByRole("button", {
      name: `Remove ${winner.concept} from favorites`,
    }),
  ).toBeVisible();

  const persistedHistory = await (
    await request.get("/api/game/history")
  ).json();
  expect(persistedHistory.entries[0].winner).toMatchObject({
    id: winner.id,
    favorite: true,
  });
  const snapshot = await (await request.get("/api/game/snapshot")).json();
  expect(
    snapshot.challengers.ratings.find(
      (rating: { candidate: { id: string } }) =>
        rating.candidate.id === winner.id,
    ),
  ).toMatchObject({ favorite: true });

  await page.reload();
  await page
    .getByRole("button", { name: "View comparison history; 1 decisions" })
    .click();
  await expect(
    page.getByRole("button", {
      name: `Remove ${winner.concept} from favorites`,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close history" }).click();
  await page
    .getByRole("button", {
      name: "View pool leaderboard; 7 of 50 reusable images",
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: `Remove ${winner.concept} from favorites`,
    }),
  ).toBeVisible();

  expect(
    (
      await request.put("/api/game/favorites", {
        data: { candidateId: "missing", favorite: true },
      })
    ).status(),
  ).toBe(404);
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
  const freedom = page.getByRole("slider", { name: "Model rewrite freedom" });
  await expect(freedom).toHaveValue("0");
  await expect(freedom).toHaveAttribute("aria-valuetext", "Frozen");
  await expect(page.getByText(/Frozen preserves every field/)).toBeVisible();
  const themes = page.getByLabel("Themes & subjects");
  const baselineThemes = await themes.inputValue();
  await themes.fill("mythic engineering and strange nocturnal ecosystems");
  await page
    .getByLabel("Inspiration")
    .fill("  severe off-axis framing and quiet tension  ");
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
  await expect(page.getByLabel("Inspiration")).toHaveValue(
    "  severe off-axis framing and quiet tension  ",
  );
  await expect(
    page.getByRole("slider", { name: "Model rewrite freedom" }),
  ).toHaveValue("0");
  await expect(
    page.getByRole("radio", { name: /adult themes/i }),
  ).toBeChecked();
  await page.getByText("Revision history").click();
  await expect(page.getByText("Manual save")).toBeVisible();
  await expect(page.getByText("Baseline")).toBeVisible();
  await expect(page.getByText(/Themes.*Inspiration.*Media/)).toBeVisible();
  await page.getByRole("button", { name: "Restore as draft" }).nth(1).click();
  await expect(page.getByLabel("Themes & subjects")).toHaveValue(
    baselineThemes,
  );
  await expect(page.getByText(/restored as an editable draft/i)).toBeVisible();

  const state = await (await request.get("/api/game")).json();
  expect(state.game.preferenceProfile).toMatchObject({
    themes: "mythic engineering and strange nocturnal ecosystems",
    inspiration: "  severe off-axis framing and quiet tension  ",
    adaptationMode: "static",
    adaptationSourceWinnerIds: [],
    adaptationSourceRejectedIds: [],
    contentLevel: "adult-allowed",
    avoid: "readable text and cute mascots",
  });
  expect(state.game.preferenceSeed).toContain(
    "Preferred media: large-format photography, linocut",
  );
  expect(state.game.preferenceSeed).toContain(
    "Content range: Adult themes may be used when relevant",
  );
  expect(state.game.preferenceRevisions).toHaveLength(2);
});

test("saves and applies named preference presets as drafts", async ({
  page,
  request,
}) => {
  await page.getByRole("button", { name: "Preferences" }).click();
  const inspiration = page.getByLabel("Inspiration");
  const activeProfile = (await (await request.get("/api/game")).json()).game
    .preferenceProfile;
  await inspiration.fill("violet rim light and copper reflections");
  await page.getByText("Saved presets").click();
  await page.getByLabel("Preset name").fill("Copper nocturne");

  const savePresetResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game/preferences/presets") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save current draft" }).click();
  expect((await savePresetResponse).status()).toBe(200);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Copper nocturne")).toBeVisible();

  await inspiration.fill("temporary unsaved edit");
  await page.getByRole("button", { name: "Apply to draft" }).click();
  await expect(inspiration).toHaveValue(
    "violet rim light and copper reflections",
  );
  await expect(page.getByText(/applied to the draft/i)).toBeVisible();

  let state = await (await request.get("/api/game")).json();
  expect(state.game.preferenceProfile).toEqual(activeProfile);
  expect(state.game.preferencePresets).toHaveLength(1);

  const deletePresetResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game/preferences/presets") &&
      response.request().method() === "DELETE",
  );
  await page.getByRole("button", { name: "Delete" }).click();
  expect((await deletePresetResponse).status()).toBe(200);
  await expect(
    page.getByRole("button", { name: "Apply to draft" }),
  ).toHaveCount(0);
  state = await (await request.get("/api/game")).json();
  expect(state.game.preferencePresets).toEqual([]);
  expect(state.game.preferenceProfile).toEqual(activeProfile);
});

test("derives an editable preference profile from a private source image", async ({
  page,
  request,
}) => {
  await page.getByRole("button", { name: "Preferences" }).click();
  await page
    .getByLabel("Choose source image")
    .setInputFiles(
      join(process.cwd(), "public/seed-assets/coastal-observatory.png"),
    );

  await expect(page.getByText("Analyzing source image")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save profile" }),
  ).toBeDisabled();
  await expect(page.getByText(/Profile populated for review/)).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByLabel("Themes & subjects")).toHaveValue(
    "Variations on the uploaded source image's subjects, setting, and visual relationships",
  );
  await expect(page.getByLabel("Preferred media")).toHaveValue(
    "digital illustration and photography",
  );
  await expect(
    page.getByRole("slider", { name: "Model rewrite freedom" }),
  ).toHaveValue("0");

  const saveResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game") &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save profile" }).click();
  expect((await saveResponse).status()).toBe(200);

  const state = await (await request.get("/api/game")).json();
  expect(state.game.preferenceProfile).toMatchObject({
    themes:
      "Variations on the uploaded source image's subjects, setting, and visual relationships",
    adaptationMode: "static",
    adaptationSourceWinnerIds: [],
    adaptationSourceRejectedIds: [],
    avoid: expect.stringContaining("exact identity"),
  });
  expect(await readdir(join(dataDirectory, "profile-sources"))).toEqual([
    expect.stringMatching(/^[a-f0-9]{64}\.png$/),
  ]);
});

test("adopts a complete model-authored profile at the unfettered cadence", async ({
  page,
  request,
}) => {
  await page.getByRole("button", { name: "Preferences" }).click();
  await page
    .getByLabel("Themes & subjects")
    .fill("mythic engineering and strange nocturnal ecosystems");
  await page.getByLabel("Inspiration").fill("start with stark lighting");
  await page.getByRole("slider", { name: "Model rewrite freedom" }).fill("2");
  await expect(
    page.getByText(/Unfettered lets the model rewrite every preference field/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save profile" }).click();

  await select(page, "left", 2, [200, 202]);
  await reconcileAllRefills(request);
  expect(
    (await challengerState()).ready[0]?.candidate.preferenceRevision,
  ).toBeTruthy();
  await select(page, "left", 3);
  const adaptiveCandidateId = await page
    .getByTestId("candidate-card-right")
    .getAttribute("data-candidate-id");
  expect(adaptiveCandidateId).toBeTruthy();
  await select(page, "right", 4);
  await select(page, "right", 5);
  await select(page, "right", 6);

  const state = await (await request.get("/api/game")).json();
  expect(state.game.preferenceProfile).toMatchObject({
    themes: "mythic engineering and strange nocturnal ecosystems",
    adaptationMode: "adaptive",
    adaptationStrength: "unfettered",
    adaptationLastDecision: 5,
    adaptationSourceWinnerIds: [adaptiveCandidateId],
  });
  expect(state.game.preferenceProfile.inspiration).toContain("Favor");
  expect(state.game.preferenceProfile.visualStyle).not.toBe("");

  await page.getByRole("button", { name: "Preferences" }).click();
  await expect(
    page.getByRole("slider", { name: "Model rewrite freedom" }),
  ).toHaveValue("2");
  await expect(
    page.getByText(/Evidence — winners: 1; rejected: \d+/),
  ).toBeVisible();
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

test("delays pool fallback, blocks an eleventh, and completes a queued Preferences save", async ({
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
  ).toBeEnabled();
  await expect(
    page.getByText(
      "Save now to apply these changes when the challenger arrives.",
    ),
  ).toBeVisible();
  const preferenceResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game") &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile queued")).toBeVisible();
  await expect(page.getByTestId("preference-save-spinner")).toBeVisible();
  await expect(page.getByText("Round 2", { exact: true })).toBeVisible();
  expect((await preferenceResponse).status()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);

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
