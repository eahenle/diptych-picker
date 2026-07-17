import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page, request }) => {
  await request.post("/api/game/start", { data: { reset: true } });
  await expect
    .poll(async () => {
      const response = await request.get("/api/game");
      return (await response.json()).status;
    })
    .toBe("ready");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Diptych Picker" }),
  ).toBeVisible();
  await expect(page.getByTestId("candidate-image")).toHaveCount(2);
});

test("renders exactly two independent side-by-side images on desktop and mobile", async ({
  page,
}) => {
  const images = page.getByTestId("candidate-image");
  await expect(images).toHaveCount(2);
  await expect(images.nth(0)).not.toHaveAttribute(
    "src",
    (await images.nth(1).getAttribute("src")) ?? "",
  );

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
  expect(Math.abs(mobile[0]!.y - mobile[1]!.y)).toBeLessThan(2);
  expect(mobile[0]!.x).toBeLessThan(mobile[1]!.x);
});

test("new game can bootstrap two generated initial candidates without broken images", async ({
  page,
}) => {
  await expect(page.getByTestId("candidate-image")).toHaveCount(2);
  page.once("dialog", (dialog) => dialog.accept());
  const startResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game/start") &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: "New game" }).click();
  const startResponse = await startResponsePromise;

  expect(await startResponse.json()).toMatchObject({ status: "initializing" });
  await expect(page.getByTestId("candidate-image")).toHaveCount(0);
  await expect(page.getByText("Creating your first comparison…")).toBeVisible();
  await expect(page.getByTestId("candidate-image")).toHaveCount(2);
});

test("selecting A keeps A's node and URL visible while only B loads and swaps", async ({
  page,
}) => {
  const left = page.getByTestId("candidate-image").nth(0);
  const right = page.getByTestId("candidate-image").nth(1);
  const leftUrl = await left.getAttribute("src");
  const rightUrl = await right.getAttribute("src");
  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & { winnerNode?: Element | null }
    ).winnerNode = document.querySelector('[data-testid="candidate-image"]');
  });

  const selectionResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game/select") &&
      response.request().method() === "POST",
  );
  await page.getByTestId("candidate-card-left").click();
  const selectionResponse = await selectionResponsePromise;
  expect(selectionResponse.status()).toBe(202);
  expect((await selectionResponse.json()).round.status).toBe("generating");
  await expect(page.getByTestId("loading-right")).toBeVisible();
  await expect(right).toHaveAttribute("src", rightUrl!);
  await expect(page.getByText("Round 1")).toBeVisible();
  await expect(page.getByRole("button", { name: "New game" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Preferences" }),
  ).toBeDisabled();
  await expect(left).toBeVisible();
  await expect(left).toHaveAttribute("src", leftUrl!);
  await expect(page.getByText("Round 2")).toBeVisible();

  expect(await left.getAttribute("src")).toBe(leftUrl);
  expect(await right.getAttribute("src")).not.toBe(rightUrl);
  expect(
    await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { winnerNode?: Element })
          .winnerNode ===
        document.querySelector('[data-testid="candidate-image"]'),
    ),
  ).toBe(true);
});

test("selecting B keeps B's URL and replaces only A", async ({ page }) => {
  const left = page.getByTestId("candidate-image").nth(0);
  const right = page.getByTestId("candidate-image").nth(1);
  const leftUrl = await left.getAttribute("src");
  const rightUrl = await right.getAttribute("src");

  await page.keyboard.press("b");
  await expect(page.getByTestId("loading-left")).toBeVisible();
  await expect(page.getByText("Round 2")).toBeVisible();

  expect(await right.getAttribute("src")).toBe(rightUrl);
  expect(await left.getAttribute("src")).not.toBe(leftUrl);
});

test("double clicking launches one round and refresh restores the correlated generating job", async ({
  page,
}) => {
  const originalUrls = await page
    .getByTestId("candidate-image")
    .evaluateAll((images) =>
      images.map((image) => (image as HTMLImageElement).src),
    );
  await page.getByTestId("candidate-card-left").dblclick();
  await expect(page.getByTestId("loading-right")).toBeVisible();

  await page.reload();

  await expect(page.getByTestId("loading-right")).toBeVisible();
  await expect(page.getByText("Round 2")).toBeVisible();
  await expect(page.getByText("Round 3")).toHaveCount(0);
  await expect(page.getByTestId("candidate-image")).toHaveCount(2);
  const completedUrls = await page
    .getByTestId("candidate-image")
    .evaluateAll((images) =>
      images.map((image) => (image as HTMLImageElement).src),
    );
  expect(completedUrls[0]).toBe(originalUrls[0]);
  expect(completedUrls[1]).not.toBe(originalUrls[1]);
});

test("a transient poll failure reconnects with both images locked", async ({
  page,
}) => {
  const images = page.getByTestId("candidate-image");
  const originalUrls = await images.evaluateAll((items) =>
    items.map((item) => (item as HTMLImageElement).getAttribute("src")),
  );
  let abortNextPoll = false;
  let abortedPolls = 0;
  await page.route("**/api/game", async (route) => {
    if (
      abortNextPoll &&
      abortedPolls === 0 &&
      route.request().method() === "GET"
    ) {
      abortedPolls += 1;
      await route.abort("connectionfailed");
      return;
    }
    await route.continue();
  });

  const selectionResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game/select") &&
      response.request().method() === "POST",
  );
  await page.getByTestId("candidate-card-left").click();
  await selectionResponsePromise;
  abortNextPoll = true;

  await expect(
    page.getByRole("status").filter({ hasText: "Reconnecting" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(page.getByTestId("candidate-card-left")).toBeDisabled();
  expect(
    await images.evaluateAll((items) =>
      items.map((item) => (item as HTMLImageElement).getAttribute("src")),
    ),
  ).toEqual(originalUrls);

  await expect(page.getByText("Round 2")).toBeVisible();
  expect(abortedPolls).toBe(1);
});

test("a stale tab adopts the authoritative completed round without posting a stale winner", async ({
  page,
  context,
}) => {
  const stalePage = await context.newPage();
  await stalePage.goto("/");
  await expect(stalePage.getByTestId("candidate-image")).toHaveCount(2);

  await page.getByTestId("candidate-card-right").click();
  await expect(page.getByText("Round 2")).toBeVisible();
  const authoritativeIds = await Promise.all([
    page.getByTestId("candidate-card-left").getAttribute("data-candidate-id"),
    page.getByTestId("candidate-card-right").getAttribute("data-candidate-id"),
  ]);

  const stalePost = stalePage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/game/select") &&
      response.request().method() === "POST",
  );
  await stalePage.getByTestId("candidate-card-left").click();
  expect((await stalePost).status()).toBe(409);

  await expect(stalePage.getByText("Round 2")).toBeVisible();
  await expect(stalePage.getByText("Round 3")).toHaveCount(0);
  await expect(stalePage.getByTestId("candidate-card-left")).toHaveAttribute(
    "data-candidate-id",
    authoritativeIds[0]!,
  );
  await expect(stalePage.getByTestId("candidate-card-right")).toHaveAttribute(
    "data-candidate-id",
    authoritativeIds[1]!,
  );
  await stalePage.close();
});

test("real mock mailbox failure preserves both images and retries once", async ({
  page,
}) => {
  const images = page.getByTestId("candidate-image");
  await expect(images).toHaveCount(2);
  const originalUrls = await images.evaluateAll((items) =>
    items.map((item) => (item as HTMLImageElement).getAttribute("src")),
  );
  await page.getByRole("button", { name: "Preferences" }).click();
  await page
    .getByRole("textbox")
    .fill("Prefer deterministic test scenes. [mock:fail-once]");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByTestId("candidate-card-left").click();
  await expect(
    page.getByRole("alert").filter({ hasText: "[mock:fail-once]" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(
    await images.evaluateAll((items) =>
      items.map((item) => (item as HTMLImageElement).getAttribute("src")),
    ),
  ).toEqual(originalUrls);

  await page.getByRole("button", { name: "Preferences" }).click();
  await page.getByRole("textbox").fill("Prefer deterministic test scenes.");
  await page.getByRole("button", { name: "Save profile" }).click();
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByText("Round 2")).toBeVisible();
  const completedUrls = await images.evaluateAll((items) =>
    items.map((item) => (item as HTMLImageElement).getAttribute("src")),
  );
  expect(completedUrls[0]).toBe(originalUrls[0]);
  expect(completedUrls[1]).not.toBe(originalUrls[1]);
});
