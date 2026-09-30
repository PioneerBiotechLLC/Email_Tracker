import { expect, test } from "@playwright/test";

const C = "/c/demo-pharma";

test("overview loads with KPI tiles and charts", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`${C}(\\?|$)`)); // root redirects to the user's company
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Received", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Overdue", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Needs attention")).toBeVisible();
  await expect(page.getByText("Demo data — this organization")).toBeVisible();
});

test("tracker filters by status and highlights overdue rows", async ({ page }) => {
  await page.goto(`${C}/tracker?range=90d`);
  await expect(page.getByRole("heading", { name: "Inbox Tracker" })).toBeVisible();
  await page.getByLabel("Status").selectOption("overdue");
  await expect(page).toHaveURL(/status=overdue/);
  const rows = page.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  for (let i = 0; i < count; i++) await expect(rows.nth(i)).toHaveAttribute("data-status", "overdue");
  await page.getByLabel("Status").selectOption("replied");
  await expect(page.locator("tbody tr").first()).toHaveAttribute("data-status", "replied");
});

test("thread detail opens from the threads list", async ({ page }) => {
  await page.goto(`${C}/threads?range=90d`);
  const first = page.getByTestId("thread-list").getByRole("link").first();
  const subject = (await first.textContent())?.trim();
  await first.click();
  await expect(page).toHaveURL(/\/c\/demo-pharma\/threads\/[a-z0-9]+/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(subject!.slice(0, 20));
  await expect(page.getByLabel("Messages").locator("article").first()).toBeVisible();
  await expect(page.getByText("AI summary")).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-summarize" })).toBeVisible(); // admin actions present
});

test("CSV export downloads a UTF-8 file with a BOM and header row", async ({ page }) => {
  await page.goto(`${C}/tracker?range=90d`);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-csv").click()]);
  expect(download.suggestedFilename()).toMatch(/^inbox-tracker-.*\.csv$/);
  const path = await download.path();
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(path!, "utf8");
  expect(text.charCodeAt(0)).toBe(0xfeff);
  expect(text.split("\r\n")[0]).toContain("Received,From,From name,Subject");
  expect(text.split("\r\n").length).toBeGreaterThan(2);
});

test("by-subject groups expand and settings are reachable for admins", async ({ page }) => {
  await page.goto(`${C}/subjects?range=90d`);
  await expect(page.getByRole("heading", { name: "By Subject" })).toBeVisible();
  await page.locator("details").first().locator("summary").click();
  await expect(page.locator("details[open] ul a").first()).toBeVisible();
  await page.goto(`${C}/settings`);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("Users", { exact: true })).toBeVisible();
});

test("company switcher lists the user's companies and Companies is owner-only", async ({ page }) => {
  await page.goto(C);
  await page.getByRole("button", { name: "Switch company" }).click();
  await expect(page.getByRole("menuitem", { name: /Demo Pharma/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Pioneer Biotech/ })).toHaveCount(0); // demo admin is not a member
  await page.keyboard.press("Escape");
  const res = await page.goto("/companies");
  expect(res?.status()).toBe(404); // not an owner
});

test("a company the user does not belong to is a 404, as is an unknown slug", async ({ page }) => {
  const other = await page.goto("/c/pioneer-biotech");
  expect(other?.status()).toBe(404);
  const unknown = await page.goto("/c/does-not-exist/tracker");
  expect(unknown?.status()).toBe(404);
});

test("machine endpoints reject bad callers", async ({ request }) => {
  const cron = await request.get("/api/cron/sync");
  expect(cron.status()).toBe(401);
  const wrongSecret = await request.get("/api/cron/summarize", { headers: { Authorization: "Bearer nope-nope-nope-nope-nope" } });
  expect(wrongSecret.status()).toBe(401);
  const badState = await request.post("/api/graph/webhook", { data: { value: [{ subscriptionId: "s1", clientState: "wrong", changeType: "created" }] } });
  expect(badState.status()).toBe(401);
  const handshake = await request.post("/api/graph/webhook?validationToken=hello%20graph");
  expect(handshake.status()).toBe(200);
  expect(await handshake.text()).toBe("hello graph");
  expect(handshake.headers()["content-type"]).toContain("text/plain");
  const health = await request.get("/api/health?graph=0");
  expect([200, 503]).toContain(health.status());
  const body = await health.json();
  expect(body).toHaveProperty("db");
  expect(JSON.stringify(body)).not.toMatch(/secret|password/i);
});
