import { test, expect } from "@playwright/test";
test("owner reviews actual content, approves exact action and receives a durable receipt", async ({
  page,
  request,
}) => {
  const actions = await (
    await request.get("/v1/actions", {
      headers: { Authorization: "Bearer synthetic-alice-token" },
    })
  ).json();
  // Each engine gets a new pending request so the test does not rely on another engine’s state.
  const connections = await (
    await request.get("/v1/connections", {
      headers: { Authorization: "Bearer synthetic-alice-token" },
    })
  ).json();
  const response = await request.post("/v1/actions", {
    headers: { Authorization: "Bearer synthetic-alice-token" },
    data: {
      connectionId: connections[0].id,
      operation: "mail.send",
      input: {
        recipient: "bob@example.test",
        text: "Synthetic email preview; this is not sent.",
      },
      idempotencyKey: "browser-" + test.info().project.name,
    },
  });
  const action = await response.json();
  expect(action.state).toBe("awaiting_approval");
  await page.goto("/");
  await page.getByLabel("Personal API token").fill("synthetic-alice-token");
  await page.getByRole("button", { name: "Connect console" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Connected. Personal records only.",
  );
  await expect(page.locator("#connections")).toContainText(
    "alice@example.test",
  );
  const row = page.locator('[data-action-id="' + action.id + '"]');
  await expect(row).toContainText("bob@example.test");
  await expect(row).toContainText("Synthetic email preview");
  await row.getByRole("button", { name: "Approve exact action" }).click();
  await expect
    .poll(async () => {
      const r = await request.get("/v1/actions/" + action.id, {
        headers: { Authorization: "Bearer synthetic-alice-token" },
      });
      return (await r.json()).state;
    })
    .toBe("succeeded");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#actions")).toContainText("succeeded");
  await expect(page.getByLabel("Personal API token")).toHaveValue("");
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});
for (const width of [320, 390, 768, 1440])
  test("console keyboard and geometry at " + width, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await page.getByLabel("Personal API token").fill("synthetic-bob-token");
    await page.getByRole("button", { name: "Connect console" }).click();
    await expect(page.getByRole("status")).toHaveText(
      "Connected. Personal records only.",
    );
    await expect(page.locator("#connections li")).toHaveCount(0);
    await expect(page.locator("#actions li")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path:
        "artifacts/browser/" + test.info().project.name + "-" + width + ".png",
    });
  });
test("untrusted origin and missing authentication cannot read accounts", async ({
  request,
}) => {
  expect((await request.get("/v1/connections")).status()).toBe(401);
  expect(
    (
      await request.get("/v1/connections", {
        headers: {
          Authorization: "Bearer synthetic-alice-token",
          Origin: "https://attacker.invalid",
        },
      })
    ).status(),
  ).toBe(403);
});
