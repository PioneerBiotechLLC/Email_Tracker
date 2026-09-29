import { expect, test } from "@playwright/test";

test("overview loads with KPI tiles and charts", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Received", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Overdue", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Needs attention")).toBeVisible();
  await expect(page.getByText("Demo data — this organization")).toBeVisible();
});

test("tracker filters by status and highlights overdue rows", async ({ page }) => {
  await page.goto("/tracker?range=90d");
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
  await page.goto("/threads?range=90d");
  const first = page.getByTestId("thread-list").getByRole("link").first();
  const subject = (await first.textContent())?.trim();
  await first.click();
  await expect(page).toHaveURL(/\/threads\/[a-z0-9]+/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(subject!.slice(0, 20));
  await expect(page.getByLabel("Messages").locator("article").first()).toBeVisible();
  await expect(page.getByText("AI summary")).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-summarize" })).toBeVisible(); // admin actions present
});

test("CSV export downloads a UTF-8 file with a BOM and header row", async ({ page }) => {
  await page.goto("/tracker?range=90d");
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
  await page.goto("/subjects?range=90d");
  await expect(page.getByRole("heading", { name: "By Subject" })).toBeVisible();
  await page.locator("details").first().locator("summary").click();
  await expect(page.locator("details[open] ul a").first()).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("Users", { exact: true })).toBeVisible();
});
