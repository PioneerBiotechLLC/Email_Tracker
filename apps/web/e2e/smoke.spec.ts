import { expect, test } from "@playwright/test";

const C = "/c/demo-pharma";

test("overview loads with KPI tiles and charts", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`${C}(\\?|$)`)); // root redirects to the user's company
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Received", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Overdue", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Average response", { exact: true })).toBeVisible();
  await expect(page.getByText("Needs attention")).toBeVisible();
  await expect(page.getByTestId("ask-box")).toBeVisible(); // the Ask chat, inline (CHAT_ENABLED is on in the test server)
  await expect(page.getByText("Median response")).toHaveCount(0);
  await expect(page.getByText("Slowest-answered senders")).toHaveCount(0);
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
  await expect(page.getByRole("button", { name: /^(Re-summarize|Summarize)$/ })).toBeVisible(); // admin actions present
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

test("summary page shows period figures and the generate button; copies are hidden across mailboxes", async ({ page }) => {
  await page.goto(`${C}/summary?period=month`);
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Last 30 days" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Received", { exact: true })).toBeVisible();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible();
  await expect(page.getByTestId("generate-summary")).toBeVisible(); // disabled without ANTHROPIC_API_KEY, enabled otherwise
  await page.getByRole("link", { name: "Today" }).click();
  await expect(page).toHaveURL(/period=day/);
  // The Cc'd mailbox holds copies of "PO 4512"; across all mailboxes the thread is listed once.
  await page.goto(`${C}/threads?range=90d&q=PO+4512`);
  await expect(page.getByTestId("thread-list").getByRole("link", { name: /PO 4512 – Amoxicillin/ })).toHaveCount(1);
  await page.goto(`${C}/threads?range=90d&q=PO+4512&mailbox=all`);
  const regulatory = await page.locator("select[aria-label='Mailbox'] option", { hasText: "regulatory@" }).getAttribute("value");
  await page.goto(`${C}/threads?range=90d&q=PO+4512&mailbox=${regulatory}`);
  await page.getByTestId("thread-list").getByRole("link", { name: /PO 4512 – Amoxicillin/ }).click();
  await expect(page.getByTestId("duplicate-notice")).toContainText("sales@demo-pharma.example");
  await page.getByRole("link", { name: "Open the primary thread" }).click();
  await expect(page.getByText("also received by")).toBeVisible();
});

test("exclusion rules: ignored mail is hidden, excluded mail is badged, settings list the rules with a live preview", async ({ page }) => {
  // GoDaddy mail is ignored by a default rule: not listed unless "Show excluded" is on.
  await page.goto(`${C}/tracker?range=90d&q=GoDaddy`);
  await expect(page.locator("tbody tr")).toHaveCount(0);
  await page.getByLabel("Show excluded").click(); // the box follows the URL, so it flips after the navigation
  await expect(page).toHaveURL(/excluded=1/);
  await expect(page.getByLabel("Show excluded")).toBeChecked();
  const ignored = page.locator("tbody tr").filter({ hasText: "GoDaddy account activity" });
  await expect(ignored).toHaveAttribute("data-status", "no_reply_needed");
  await expect(ignored.getByTestId("excluded-badge")).toContainText("Ignored · rule: domain godaddy.com");
  // "no reply needed" mail stays visible, with the reason, and never waits for a reply.
  await page.goto(`${C}/tracker?range=90d&q=Microsoft+365`);
  const soft = page.locator("tbody tr").filter({ hasText: "Your Microsoft 365 invoice is ready" });
  await expect(soft).toHaveAttribute("data-status", "no_reply_needed");
  await expect(soft.getByTestId("excluded-badge")).toContainText('subject contains "Microsoft 365"');
  await page.goto(`${C}/threads?range=90d&q=Weekly+market+update`);
  await expect(page.getByTestId("excluded-badge")).toContainText("auto: mailing list");
  // Settings: the default rules are listed and a draft rule shows how many emails it would match.
  await page.goto(`${C}/settings`);
  const rules = page.getByTestId("exclusion-rules");
  await expect(rules.getByText("godaddy.com", { exact: true })).toBeVisible();
  await expect(rules.getByText("mailer-daemon@*")).toBeVisible();
  const add = page.locator("form").filter({ has: page.getByRole("button", { name: "Add rule" }) });
  await add.getByLabel("Value").fill("mohap.gov.ae");
  await expect(page.getByTestId("rule-preview")).toContainText(/This rule matches [1-9]\d* emails? in the last 90 days/);
});

test("quick action: ignore a sender from the tracker, then undo", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await page.goto(`${C}/tracker?range=90d&q=INV-2188`);
  const row = page.locator("tbody tr").filter({ hasText: "Payment reminder" });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: /Ignore options for accounts@sunpharma-intl.com/ }).click();
  await page.getByRole("menuitem", { name: /Ignore this sender/ }).click();
  await expect(page.getByTestId("rule-banner")).toContainText("1 email affected");
  await expect(page.locator("tbody tr")).toHaveCount(0); // hidden now
  await page.getByTestId("rule-banner").getByRole("button", { name: "Undo" }).click();
  await expect(page.locator("tbody tr").filter({ hasText: "Payment reminder" })).toHaveCount(1);
  await expect(page.getByTestId("rule-banner")).toHaveCount(0);
});

test("Ask: the page loads and an answer renders with numbered sources linking to the thread and to Outlook", async ({ page }) => {
  // The model is not called in smoke tests: the stream the page reads is served from here.
  const turn = {
    id: "turn1", question: "What happened to PO 4512?", answerMarkdown: "MedCare sent **PO 4512** for 5,000 bottles [1].\n- Dispatch is expected 12 Oct [2]", found: true, unverified: false, limitHit: null, error: null,
    model: "claude-sonnet-5-5", costUsd: 0.0147, emailsRead: 8, helpful: null,
    citations: [
      { marker: "1", messageId: "msgA", threadId: "threadA", subject: "PO 4512 – Amoxicillin 250mg suspension", from: "MedCare Pharmacies", to: "sales@demo-pharma.example", date: "2026-09-30 10:00", mailbox: "sales@demo-pharma.example", webLink: "https://outlook.office365.com/owa/?ItemID=abc" },
      { marker: "2", messageId: "msgB", threadId: "threadA", subject: "RE: PO 4512 – Amoxicillin 250mg suspension", from: "Sales", to: "purchasing@medcare-pharmacies.sa", date: "2026-10-01 09:00", mailbox: "sales@demo-pharma.example", webLink: null },
    ],
  };
  await page.route("**/ask/stream", (route) => route.fulfill({ contentType: "application/x-ndjson", body: [{ type: "status", text: "Searching emails…" }, { type: "answer", sessionId: "sessionA", turn }].map((e) => JSON.stringify(e)).join("\n") + "\n" }));
  await page.goto(`${C}/ask`);
  await expect(page.getByRole("heading", { name: "Ask" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ask", exact: true })).toHaveAttribute("aria-current", "page"); // sidebar entry
  await expect(page.getByLabel("Deep answer")).not.toBeChecked();
  await page.getByLabel("Your question").fill("What happened to PO 4512?");
  await page.getByLabel("Your question").press("Enter");
  const answer = page.getByTestId("ask-turn");
  await expect(answer).toContainText("MedCare sent PO 4512 for 5,000 bottles");
  await expect(answer.getByRole("link", { name: "Source 1" })).toHaveAttribute("href", "#src-turn1-1");
  const sources = answer.getByTestId("ask-source");
  await expect(sources).toHaveCount(2);
  await expect(sources.first()).toContainText("MedCare Pharmacies → sales@demo-pharma.example · PO 4512");
  await expect(sources.first().getByRole("link", { name: "Open thread" })).toHaveAttribute("href", `${C}/threads/threadA#msg-msgA`);
  await expect(sources.first().getByRole("link", { name: /Open in Outlook/ })).toHaveAttribute("href", "https://outlook.office365.com/owa/?ItemID=abc");
  await expect(sources.nth(1).getByRole("link", { name: /Open in Outlook/ })).toHaveCount(0); // no link stored for that email
  await expect(answer).toContainText("claude-sonnet-5-5");
  await expect(answer).toContainText("$0.015");
  await expect(answer).toContainText("8 emails read");
  await expect(answer.getByRole("button", { name: "Copy answer" })).toBeVisible();
  // "Ask about this thread" on a thread page prefills the question and limits it to that thread.
  await page.goto(`${C}/threads?range=90d&q=PO+4512`);
  await page.getByTestId("thread-list").getByRole("link", { name: /PO 4512 – Amoxicillin/ }).click();
  await page.getByRole("link", { name: "Ask about this thread" }).click();
  await expect(page.getByLabel("Your question")).toHaveValue(/current status of this thread/);
  await expect(page.getByText("Limited to the thread:")).toContainText("PO 4512 – Amoxicillin");
});

test("Ask box on the overview answers inline and links to the chat it started", async ({ page }) => {
  const turn = { id: "turn2", question: "Who asked about PO 4512?", answerMarkdown: "MedCare asked about **PO 4512** [1].", found: true, unverified: false, limitHit: null, error: null, model: "claude-sonnet-5-5", costUsd: 0.01, emailsRead: 3, helpful: null,
    citations: [{ marker: "1", messageId: "msgA", threadId: "threadA", subject: "PO 4512 – Amoxicillin 250mg suspension", from: "MedCare Pharmacies", to: "sales@demo-pharma.example", date: "2026-09-30 10:00", mailbox: "sales@demo-pharma.example", webLink: null }] };
  await page.route("**/ask/stream", (route) => route.fulfill({ contentType: "application/x-ndjson", body: [{ type: "status", text: "Searching emails…" }, { type: "answer", sessionId: "sessionB", turn }].map((e) => JSON.stringify(e)).join("\n") + "\n" }));
  await page.goto(C);
  const box = page.getByTestId("ask-box");
  await expect(box.getByTestId("ask-box-open")).toHaveAttribute("href", `${C}/ask`);
  await box.getByLabel("Your question").fill("Who asked about PO 4512?");
  await box.getByLabel("Your question").press("Enter");
  const answer = box.getByTestId("ask-turn");
  await expect(answer).toContainText("MedCare asked about PO 4512");
  await expect(answer.getByTestId("ask-source").first().getByRole("link", { name: "Open thread" })).toHaveAttribute("href", `${C}/threads/threadA#msg-msgA`);
  await expect(box.getByTestId("ask-box-open")).toHaveAttribute("href", `${C}/ask?s=sessionB`); // follow-ups continue this chat
});

test("Ask is off without CHAT_ENABLED: no menu entry, and the page and its stream return 404", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "e2e-chat", value: "off", url: baseURL! }]); // test-only switch, see lib/chat-flag.ts
  const res = await page.goto(`${C}/ask`);
  expect(res?.status()).toBe(404);
  const stream = await context.request.post(`${C}/ask/stream`, { data: { question: "anything" } });
  expect(stream.status()).toBe(404);
  await page.goto(C);
  await expect(page.getByRole("link", { name: "Overview" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Ask", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("ask-box")).toHaveCount(0);
});

test("company switcher lists the user's companies and Companies is owner-only", async ({ page }) => {
  await page.goto(C);
  await page.getByRole("button", { name: "Switch company" }).click();
  await expect(page.getByRole("menuitem", { name: /Demo Pharma/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /API Pharma/ })).toHaveCount(0); // demo admin is not a member
  await page.keyboard.press("Escape");
  const res = await page.goto("/companies");
  expect(res?.status()).toBe(404); // not an owner
});

test("a company the user does not belong to is a 404, as is an unknown slug", async ({ page }) => {
  const other = await page.goto("/c/api-pharma");
  expect(other?.status()).toBe(404);
  const unknown = await page.goto("/c/does-not-exist/tracker");
  expect(unknown?.status()).toBe(404);
});

test("machine endpoints reject bad callers", async ({ request }) => {
  const cron = await request.get("/api/cron/sync");
  expect(cron.status()).toBe(401);
  const wrongSecret = await request.get("/api/cron/sync", { headers: { Authorization: "Bearer nope-nope-nope-nope-nope" } });
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
