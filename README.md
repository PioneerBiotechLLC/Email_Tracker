# Outlook AI Email Tracker

Connects to Microsoft 365 mailboxes (read-only), tracks which inbound emails were replied to and how fast, summarizes threads with Claude, and shows it all on a dashboard with a daily digest. Full brief: [SPEC.md](SPEC.md).

**Status: Phase 5 (multi-company + go live) complete**, plus copy detection across mailboxes and on-demand period summaries (section 8) — multiple companies on different Microsoft 365 tenants with a company switcher, serverless live sync (Graph webhooks + cron endpoints) and a Vercel/Neon deployment path. See [docs/DEPLOY.md](docs/DEPLOY.md) for the go-live checklist. The emailed daily digest (Phase 6) is still to come.

## Hard rules

- The app is **read-only** on mailboxes. It only ever uses `Mail.Read` (plus `Mail.Send` from one dedicated digest mailbox, Phase 6). It never deletes, moves, flags, or marks anything.
- No secrets in code. Everything comes from environment variables (`.env`, see `.env.example`).
- Emails may be Arabic, English, or mixed.

## Repo layout

```
apps/worker      CLI scripts now; sync + AI jobs (pg-boss) from Phase 5
apps/web         Next.js 15 dashboard (App Router, Tailwind, shadcn/ui, Recharts, Auth.js) + Graph webhook (Phase 5)
packages/core    Prisma schema + client, Graph auth, MailProvider abstraction,
                 body cleaning, subject normalization, sync engine, (Phase 2) reply detection
```

## Prerequisites

- Node 20+ and pnpm 9+ (`corepack enable`)
- A Postgres database (Supabase, Neon, or local). Use a **direct** connection string (not the pooler) for migrations.
- An Entra ID app registration (below)

## 1. Microsoft Graph setup (one-time per tenant)

1. **Entra admin center → App registrations → New registration**: name `Email Tracker`, single tenant. Note the *Application (client) ID* and *Directory (tenant) ID*.
2. **API permissions → Add → Microsoft Graph → Application permissions**: `Mail.Read`, `User.Read.All`. (Phase 6 adds `Mail.Send`.) Click **Grant admin consent**.
3. **Certificates & secrets → New client secret**. Copy the *value* immediately.
4. **Restrict the app to specific mailboxes.** Application permissions are tenant-wide by default; lock them down with an Exchange Online *Application Access Policy* so the app can only read the mailboxes you register:

   ```powershell
   Install-Module ExchangeOnlineManagement -Scope CurrentUser
   Connect-ExchangeOnline -UserPrincipalName admin@api-pharma.net

   # A mail-enabled security group containing every mailbox the tracker may read
   New-DistributionGroup -Name "EmailTracker-Allowed" -Alias emailtracker-allowed -Type Security
   Add-DistributionGroupMember -Identity "EmailTracker-Allowed" -Member sales@api-pharma.net
   Add-DistributionGroupMember -Identity "EmailTracker-Allowed" -Member info@api-pharma.net

   # Only allow the app (by its client ID) to access members of that group
   New-ApplicationAccessPolicy -AppId <AZURE_CLIENT_ID> `
     -PolicyScopeGroupId emailtracker-allowed@api-pharma.net `
     -AccessRight RestrictAccess `
     -Description "Email Tracker: read-only access to tracked mailboxes"

   # Verify (Granted for members, Denied for everyone else). Policies take up to 30 min to apply.
   Test-ApplicationAccessPolicy -Identity sales@api-pharma.net -AppId <AZURE_CLIENT_ID>
   Test-ApplicationAccessPolicy -Identity ceo@api-pharma.net   -AppId <AZURE_CLIENT_ID>
   ```

   The policy applies to `Mail.Send` too, so later the digest mailbox (`tracker@…`) simply joins the same group.

5. Put the IDs and secret in `.env` (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`).

Auth is client-credentials (app-only) via MSAL; tokens are cached in memory and refreshed automatically. One app registration can serve several tenants (one `Organization` row per tenant) once each tenant's admin has consented.

## 2. Install & database

```bash
pnpm install
cp .env.example .env
pnpm db:generate
pnpm db:deploy
```

Fill in `DATABASE_URL` and the `AZURE_*` values in `.env` first. `pnpm db:generate` generates the Prisma client; `pnpm db:deploy` applies migrations (`pnpm db:migrate` during development).

**No Postgres yet?** `pnpm db:local` starts Prisma's built-in local Postgres (no Docker needed), writes its connection string into `.env` as `DATABASE_URL`, and keeps running until you press Ctrl+C. Data persists between runs. Use it for the demo data and local development; use Supabase/Neon for production.

Optional: set `DATA_ENCRYPTION_KEY` (`openssl rand -base64 32`) and email bodies are stored AES-256-GCM encrypted. Without it they are stored in plaintext (previews and metadata are never encrypted).

## 3. Register a mailbox and backfill

```bash
pnpm mailbox add sales@api-pharma.net --org-name "API Pharma"
pnpm sync:once sales@api-pharma.net          # last BACKFILL_DAYS (90) of Inbox + Sent Items
pnpm sync:once sales@api-pharma.net          # run again → incremental via saved delta links
pnpm sync:once sales@api-pharma.net --reset  # throw away delta links and backfill again
pnpm sync:once all                           # every active mailbox
pnpm mailbox list
pnpm db:studio                               # browse the data
```

`mailbox add` creates the organization (from the email's domain) if it doesn't exist, resolves the Graph user id, and records the user's proxy addresses as aliases so mail sent from an alias still counts as "us".

### What the sync does

- Graph **delta queries** on `mailFolders/inbox` and `mailFolders/sentitems`, filtered to the backfill window on the first run; the returned `deltaLink` is saved per folder so later runs only pull changes. Progress (`nextLink`) is saved after every page so an interrupted backfill resumes.
- Requests **immutable ids** (`Prefer: IdType="ImmutableId"`) so moving a message between folders doesn't create a duplicate, and asks Outlook for **text bodies**.
- Reads `PidTagLastVerbExecuted` (0x1081) / `PidTagLastVerbExecutionTime` (0x1082) via `$expand` on the delta call; if the tenant rejects that, falls back to `$batch` (20/request) lookups automatically.
- Keeps `In-Reply-To` / `References`, flags auto-replies (`Auto-Submitted`, `X-Auto-Response-Suppress`, "Automatic reply:" subjects).
- Applies the company's **exclusion rules** and built-in bulk-mail detection to every incoming message (§9).
- Writes each message's **search vector** (for Ask, §10) with one statement per page, and stores its Outlook `webLink`.
- Cleans bodies: HTML → text, strips quoted history (English/Arabic/Outlook header blocks) and signatures, caps at 8,000 chars.
- Groups messages into `Thread` rows by `conversationId` per mailbox, with a `normalizedSubject` (RE/FW/رد prefixes and ticket tags removed) for the "By subject" view.
- Honours `Retry-After` on 429/503 and backs off exponentially.
- Drafts are skipped. Deleted/moved-out messages are counted but never deleted from our DB (retention purge comes in Phase 6).

## 4. Reply tracking (Phase 2)

After every sync, each touched thread is re-evaluated by pure functions in [packages/core/src/sync/replies.ts](packages/core/src/sync/replies.ts) (no DB access, fully unit-tested; the DB wrapper is `recomputeThread` in `threads.ts`).

**Reply rules** for each real inbound message (not an auto-reply, not from our own address/aliases), first match wins:

1. `outlook_verb` — Outlook stamped the message with Reply (102) or Reply-All (103): `repliedAt` = the verb time. Forward (104) is stored but is not a reply.
2. `header_match` — a Sent Items message whose `In-Reply-To` or `References` contains the inbound message's `Message-ID`: `repliedAt` = its sent time.
3. `conversation_match` — the earliest Sent Items message in the same conversation, sent after the inbound one, with the sender in To/Cc.

Details: outbound times use `sentAt` (the sync also stores it in `receivedAt` for outbound rows, but `sentAt` is authoritative). One reply can answer several earlier unanswered emails from the same sender. When the verb time and the matched sent message disagree, the verb time is used but the sent message is still linked (`repliedByMessageId`). Our own out-of-office never counts as a reply, and a reply is never earlier than the received time. `responseMinutes` is wall-clock; `responseBusinessMinutes` counts only working minutes in the org's timezone (weekends, nights and out-of-hours replies count 0).

**Thread status** — `awaiting_us` (latest real message is an unanswered inbound), `awaiting_them` (we spoke last, or the latest inbound was answered), `no_reply_needed` and `closed` (sticky when set by a user or the AI, except that a new inbound after a manual close reopens the thread). `awaitingSince` and `overdueAt` are stored so overdue threads are a simple query: `status = awaiting_us AND overdueAt <= now()`.

**Org settings** (columns on `Organization`): `timezone` (Asia/Dubai), `workDays` (0 = Sun … 6 = Sat; default Sun–Thu), `workStart` 09:00, `workEnd` 18:00, `replySlaHours` (overrides `REPLY_SLA_HOURS`, default 24 business hours). Edit them in `pnpm db:studio` until the settings page ships in Phase 6.

```bash
pnpm db:deploy                                   # applies the Phase 2 migration
pnpm replies:recompute sales@api-pharma.net      # or `all` — re-evaluate every thread (after backfill / rule or settings changes)
pnpm replies:report sales@api-pharma.net --days 30
```

### Verifying against Outlook

1. Run `pnpm sync:once <mailbox>` then `pnpm replies:report <mailbox> --days 30`.
2. **Oldest unanswered list**: open each in Outlook. It should have no reply from you (the Reply/Reply-All icon absent, nothing in Sent Items for that sender after that date). If Outlook shows it as replied, check whether the reply was sent from another mailbox or alias; add aliases with `pnpm mailbox add <email> --alias other@…` and re-run `pnpm replies:recompute`.
3. **Replied %**: in Outlook, filter the Inbox on the same window and compare the count of messages with the replied icon. Differences usually come from replies sent from a different mailbox, or from messages that only got a forward (counted as not replied, by design).
4. **Response times**: pick ~20 emails, compare `repliedAt` (visible in `pnpm db:studio`, Message table) with the timestamp of your reply in Sent Items. Business-hours minutes should be 0 for anything answered on a Friday/Saturday or at night.
5. If the org's hours are wrong, edit the `Organization` row and run `pnpm replies:recompute all`.

## 5. AI summaries (Phase 3)

Every thread gets a Claude-written summary, key points, open asks, next action, `needsReply`, category, priority and language (SPEC §7). Code lives in [packages/core/src/ai/](packages/core/src/ai/).

**How it works**

- Input: the thread's messages oldest first, as `[inbound|outbound] <from> → <to> | <date in org timezone> | <cleaned text>`. Only cleaned body text is sent — no attachments, no raw headers. Bodies are decrypted just for the call. Threads over ~30k tokens drop the oldest middle messages first (first message and last 3 always kept, with an "[N earlier messages omitted]" marker).
- Output: Claude must call one strict tool, `record_thread_summary`, whose schema matches SPEC §7.3. Every result is validated with zod; invalid output is retried once, then the thread gets a `summaryError` and the run continues. The system prompt is cached (prompt caching) and treats email content as untrusted data (prompt-injection guard).
- When: **only on request**. Nothing is summarized automatically (not by live sync, the cron or `pnpm sync:once`), so loading a mailbox's history never spends money by itself. A company admin clicks **Summarize** / **Re-summarize** on a thread page; from the laptop, `pnpm ai:summarize`, `pnpm ai:backfill` (Batch API, half price, `--dry-run` shows the cost first) or `pnpm sync:once <mailbox> --ai`. The CLI paths skip threads whose last message is younger than `AI_SUMMARY_DEBOUNCE_MINUTES`.
- Decisions: the AI's `needs_reply` sets `needsReply` (recorded as decided by `ai`). A "no reply needed" set by a user stays until a new inbound message arrives; any new real inbound resets the decision to "needs reply" until the AI re-summarizes. `concluded = true` closes the thread (`closedBy = ai`) only when it is not awaiting our reply.
- Models: `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`) for everything; optional `ANTHROPIC_MODEL_LIGHT` (e.g. `claude-haiku-4-5`) for threads with 1–2 short messages. `AI_EFFORT=low` keeps reasoning short.
- Cost control: every call is logged in `AiUsage` (tokens, cache hits, USD from the price table in `ai/pricing.ts`, batch flag, error). `AI_MAX_CALLS_PER_DAY` is enforced per organization per local day; when reached, remaining threads wait for the next run.

**Run the cost estimate before spending anything**

```bash
pnpm ai:backfill sales@api-pharma.net --dry-run      # thread count, estimated tokens and cost — no API call
pnpm ai:backfill sales@api-pharma.net --limit 200    # submit via the Batch API (50% cheaper), wait, save
pnpm ai:summarize sales@api-pharma.net               # live summaries for threads with new messages
pnpm ai:summarize-thread <threadId> --force          # one thread, prints the result as JSON
pnpm ai:usage --days 30                              # calls, tokens and cost per day / per model
```

The backfill uses Anthropic's Message Batches API: it submits all pending threads (up to the daily cap / `--limit`), polls until the batch ends (usually minutes, up to 24h) and saves results. Threads that fail in the batch keep a `summaryError` and are retried live by `pnpm ai:summarize`.

**Cost note.** With Sonnet, a typical 5-message thread (~1,500 input tokens + ~900 cached system-prompt tokens + ~450 output tokens) costs about $0.008 live or $0.004 via batch, so roughly **$4 per 1,000 threads batched** (about $8 live). Haiku for short threads halves that; Opus (`claude-opus-5-5`) doubles it. The dry-run prints the actual estimate for your data. Prices are in `packages/core/src/ai/pricing.ts` — update it when Anthropic changes pricing.

## 6. Dashboard (Phase 4)

A Next.js 15 app in [apps/web](apps/web/): Overview (KPIs, charts, needs-attention list), Inbox Tracker (one row per inbound email, sortable/searchable, CSV export), Threads (AI summary cards), Thread detail (chat-style timeline with reply info, AI panel, admin actions), By Subject (grouped view) and Settings (admin only). All reads go through `@email-tracker/core`; the reply/status/business-hours/summarize logic is reused, not duplicated.

### Sign-in with Microsoft (Entra ID)

The dashboard uses Auth.js with the Microsoft Entra ID provider (delegated login). Only emails in the `AppUser` table can sign in; everyone else gets a "No access" page. Roles: **admin** (everything) and **viewer** (read-only, no actions, no settings). Every query is scoped to the user's organization.

You need an app registration with a **web redirect URI**. Two options:

1. **Same app as the mail reader** (`Email Tracker`): Authentication → Add a platform → Web → redirect URIs below. Keep the existing application permissions; add the delegated `openid`, `profile`, `email`, `User.Read` (added automatically on first sign-in consent). Reuse the client id/secret.
2. **Separate app** (cleaner separation between the read-only mail app and user login): register `Email Tracker Dashboard`, single tenant, Web platform, same redirect URIs, and a client secret. No application permissions at all.

Redirect URIs (add both when you use one app for local and production):

```
http://localhost:3000/api/auth/callback/microsoft-entra-id
https://<your-dashboard-domain>/api/auth/callback/microsoft-entra-id
```

Env vars (`.env`): `AUTH_SECRET` (`openssl rand -base64 32`), `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`, and in production `AUTH_URL=https://<your-dashboard-domain>`. The web app only needs `DATABASE_URL` and the `AUTH_*` values (plus `ANTHROPIC_API_KEY` for the Re-summarize button); the `AZURE_*` Graph credentials are only used by the worker/CLI.

### First admin user and running locally

```bash
pnpm user add you@api-pharma.net --org api-pharma.net --role admin
pnpm user list
pnpm user remove someone@api-pharma.net
pnpm dev
pnpm build
```

The organization must exist (it is created by `pnpm mailbox add` or `pnpm db:seed-demo`). `user remove` deactivates the user and keeps the row for audit history. `pnpm dev` serves http://localhost:3000; if that port is taken, run `PORT=3001 pnpm dev`. `pnpm build` is the production build of `apps/web`. Users can also be added, promoted and deactivated in Settings → Users once you are in.

### Demo data (no mailbox needed)

Quickest way to see the dashboard, from a fresh clone (two terminals):

```bash
# terminal 1 — local database (keeps running)
pnpm install
cp .env.example .env
pnpm db:local
```

```bash
# terminal 2
pnpm db:generate
pnpm db:deploy
pnpm db:seed-demo
NODE_ENV=test E2E_BYPASS_EMAIL=demo-admin@demo-pharma.example pnpm dev
```

Then open http://localhost:3000 (or `PORT=3001 pnpm dev` if 3000 is busy).

**From another PC on the office network:** run `pnpm dev:lan` instead of `pnpm dev` (it binds to all interfaces), put your machine's IP or `.local` name in `DEV_ALLOWED_ORIGINS` in `.env` (find the IP with `ipconfig getifaddr en0` on macOS), allow the connection if macOS asks about the firewall, and open `http://<your-ip>:3000` on the other PC. The demo bypass works there too. Real Microsoft sign-in over a plain-http LAN address is not possible (Entra only allows http redirect URIs for localhost); that arrives with the hosted deployment in Phase 7. `pnpm db:seed-demo` creates "Demo Pharma (DEMO DATA)" with 40 realistic threads (English + Arabic) in every status; `pnpm db:seed-demo --remove` deletes the demo org and everything under it. The demo org is flagged `isDemo` and shows a banner. Its users (`demo-admin@demo-pharma.example`, admin; `demo-viewer@demo-pharma.example`, viewer) are not real Microsoft accounts, which is why the `NODE_ENV=test` bypass is used above; that bypass is compiled out of production builds (see `apps/web/src/lib/e2e.ts`).

**What to expect:** Overview shows six KPI tiles (received, replied %, median and average business-hours response with wall-clock in the tooltip, awaiting, overdue), a received-vs-replied bar chart, a median-response-time line, awaiting-by-category bars, a slowest-senders table and the ten most overdue threads. Inbox Tracker highlights overdue rows in red and shows the reply method in small text under the response time. Thread detail shows inbound messages on the left, ours on the right, auto-replies greyed out, and the AI panel plus admin actions (Mark closed / Reopen, No reply needed / Needs reply, Re-summarize, manual category/priority). Settings has mailboxes (pause/resume, last sync, sync errors), business hours, SLA and summary language, branding (logo + primary color), digest recipients/time, AI usage this month and users.

### Notes

- Filters (mailbox, range, category, priority, status, search, sort, page) live in the URL, so views are shareable.
- All times are shown in the organization timezone as "Tue 29 Sep, 14:05".
- Every admin action is written to `AuditLog` (who, what, when, before/after). Manual category/priority choices set `categoryManual`/`priorityManual`, which the AI never overwrites.
- Decrypted email bodies are only sent to the browser on the thread detail page; nothing logs bodies.
- Branding defaults: primary `#BE272C`, secondary `#BE6B27`, accent `#21A396`; Merriweather headings, Source Sans 3 body. Status colors (green/amber/red) are independent of the brand color, and status is always shown as text too.

### Tests

```bash
pnpm test                       # vitest: core logic incl. KPI aggregations and permission checks
pnpm --filter @email-tracker/web test:e2e   # Playwright smoke tests (seeds the demo org, needs DATABASE_URL; run `pnpm exec playwright install chromium` once)
```

## 7. Multiple companies and live sync (Phase 5)

- **Companies** are `Organization` rows, each with its own Microsoft 365 tenant, branding (colors, fonts, logo), business hours, AI context and storage settings. Dashboard URLs are `/c/<slug>/…`; the sidebar has a company switcher, and the last company is remembered in a cookie.
- **Users** belong to companies through `Membership` (admin or viewer per company). Owners (`pnpm user add <email> --owner`) see and manage every company and the `/companies` page. A user without a membership gets a 404 for that company — the URL is never trusted alone.
- **Connect Microsoft 365**: the mail-reading Entra app is multi-tenant; each company's tenant admin grants consent through the Companies page (`/api/graph/consent/callback` records the tenant id). The Application Access Policy must then be created in that tenant (docs/DEPLOY.md, step e).
- **Live sync without a worker**: Graph change notifications hit `/api/graph/webhook` (validation handshake, `clientState` check, 202, then the work runs after the response); lifecycle events hit `/api/graph/lifecycle`. Cron endpoints (bearer `CRON_SECRET`): `/api/cron/sync` (resumable delta sync, time-boxed), `/api/cron/renew-subscriptions`, `/api/cron/retention`. GitHub Actions calls the first every 15 minutes; Vercel runs the other two daily. No endpoint calls the AI on its own: summaries are made on request.
- **Heavy jobs stay on the laptop**: `pnpm sync:once` (90-day backfill) and `pnpm ai:backfill` run locally against the production `DATABASE_URL`.
- **Storage**: per-company "store email bodies: full | preview only" and retention days; the Companies page shows database size against the plan limit (`DB_STORAGE_LIMIT_MB`, warns at 80%).
- **Health**: `/api/health` reports DB reachability, a Graph token check per company and sync freshness, without secrets.

```bash
pnpm org:seed                      # API Pharma + Pioneer Biotech company records (idempotent)
pnpm org:seed-pioneer              # Pioneer Biotech only
pnpm user add me@x.com --owner     # global owner
pnpm user add a@pbio.tech --org pbio.tech --role admin
pnpm mailbox add sales@pbio.tech --tenant <tenant-id>
pnpm --filter @email-tracker/core check:migration   # replays the AppUser → Membership migration in a scratch schema
```

## 8. Copies across mailboxes and period summaries

### One email, several mailboxes (Cc'd colleagues)

When two tracked mailboxes both receive an email (sales@ in To, regulatory@ in Cc), Microsoft 365 gives each mailbox its own copy and its own Graph id. Without help the tracker would count the email twice, show the thread twice and pay for two AI summaries. The sync now:

- Records on every message which **other addresses inside the company's domains** (`Organization.domain` + `domains`) were in To/Cc: `Message.internalRecipients`. The thread page shows it as "Also to (in-company): …".
- Links copies by their **RFC Message-ID**: one copy is the *primary* (the mailbox that was addressed directly wins over a Cc'd one; the sender's Sent Items copy wins for outgoing mail; ties go to the mailbox registered first) and the others get `duplicateOfId`. A colleague's reply-all that lands in a mailbox that was only Cc'd is a copy of the colleague's Sent Items row; an internal email addressed *To* a mailbox needs no reply when "Internal emails need no reply" is on (the default, see §9), and is a real inbound request when it is off.
- Marks a thread whose messages are **all** copies of one thread in another mailbox as a copy of that thread (`Thread.duplicateOfId`). Copy threads inherit the primary thread's AI summary instead of being summarized again.
- Treats **sent mail from any tracked mailbox of the company** as a reply candidate (headers or conversation match): an email a colleague answered is not "waiting for us". The tracker shows the answering mailbox.
- Hides copies from the **All mailboxes** views and statistics (`mailboxScope` adds `duplicateOfId = null`). A single-mailbox view still shows everything that landed in that mailbox, with a "copy" notice linking to the primary thread.

After deploying this version (or after adding a mailbox / changing the company's domains) run once:

```bash
pnpm db:deploy
pnpm replies:recompute all      # re-links copies, fills internalRecipients, recomputes every thread
```

### Track replies from a start date

Settings → Business hours → **Track replies from** (per company, stored in `Organization.settings.trackRepliesFrom`, a day in the company timezone). Emails received before that day never count as waiting for a reply (their threads become "no reply needed" unless newer mail arrives), and Overview and Inbox Tracker (and its CSV) never reach back before it. Older mail stays stored, searchable in Ask and listed on the Threads page. Saving recomputes every thread within 40 seconds; for a large company finish with `pnpm replies:recompute all`. Clearing the date restores the full history.

### Mailboxes migrated from another provider (sent mail in a plain folder)

The sync reads Inbox and Sent Items only. After a migration (e.g. Zoho → Microsoft 365 over IMAP) the old sent mail often sits in a plain folder called "Sent", "Sent Emails" or "Emails Sent", so replies in it would not count and those customers would look unanswered. Import those folders once:

```bash
pnpm folders:list sales@<company-domain>                 # all folders + item counts; "<- will import" marks detected sent folders
pnpm folders:import all --org <company> --dry-run        # what would be imported
pnpm folders:import all --org <company>                  # last BACKFILL_DAYS days (by sent date) stored as sent mail
pnpm folders:import sales@<company-domain> --folder "Inbox/Old sent"   # a folder the name detection misses
```

Detected by name (case and punctuation ignored): sent, sent items, sent mail(s), sent email(s), sent messages, email(s) sent, mail sent, and the Arabic equivalents. The real Sent Items folder is recognized by id and never imported twice. Read-only (Mail.Read), safe to re-run, no delta link kept: new sent mail goes to Sent Items as usual.

### Daily / weekly / monthly summary

The **Summary** page (`/c/<slug>/summary`) shows, for the mailbox chosen in the top bar or for all mailboxes, the figures of a rolling window — **Today**, **Last 7 days**, **Last 30 days** — and a "Generate summary" button. One Claude call (counted against `AI_MAX_CALLS_PER_DAY`) returns a very short digest: a one-line overview and up to five bullets each for *received*, *sent* and *needs attention*. Counts come from the database, only the words come from the model; existing thread summaries feed the prompt so it stays small (least urgent threads are dropped past ~40k tokens). Results are stored in `PeriodSummary`, so the page shows the last digest until someone regenerates it. Any member can generate; the action is audited.

```bash
pnpm ai:period sales@api-pharma.net --period week            # one mailbox
pnpm ai:period all --org api-pharma.net --period month       # all mailboxes of a company
```

## 9. Excluding emails

Some mail should never be counted: GoDaddy account-activity notices, newsletters, system alerts, bounces. Exclusion only affects this app — **nothing is ever moved, deleted or marked in Outlook**.

**Two actions**

| Action | Tracker / Threads | KPIs, awaiting, overdue, digests | Sent to the AI |
|---|---|---|---|
| `ignore` | hidden (listed with the **Show excluded** toggle) | not counted | never |
| `no_reply_needed` | shown, with an "Excluded" badge and the reason | not counted | never |

**Rules** (Settings → *Exclusion rules*, admins only; per company, optionally for one mailbox). Matching is case-insensitive.

| Type | Example value | Matches |
|---|---|---|
| Sender domain | `godaddy.com` | `x@godaddy.com` and subdomains such as `x@email.godaddy.com` |
| Sender address | `billing@godaddy.com`, or `postmaster@*` | that address; with `@*`, that mailbox name at any domain |
| Subject contains | `account activity` | any subject containing the text |
| Subject matches (regex) | `^\[alert\]\s+\d+` | a JavaScript regular expression, case-insensitive (first 500 characters of the subject) |

Every rule can carry a second condition, "…and subject contains", ANDed with the first (e.g. domain `microsoft.com` **and** subject contains `Microsoft 365`). While you type, the form shows *"This rule matches N emails in the last 90 days"*. Rules are deactivated, never deleted, and every change is written to the audit log. A company's own domains cannot be excluded.

**Built-in detection** (on by default, three switches in the same Settings card) marks internal, bulk and automatic mail `no_reply_needed` — never `ignore`, so nothing is hidden silently:

- internal mail: the sender is in the company's own domains (`Organization.domain` + `domains`, exact match), i.e. a colleague, its own switch (`auto:internal`). Unlike other excluded mail it stays readable by Ask, thread summaries and period summaries (`READABLE`), and a colleague's email that also goes to someone outside the company counts as the company's reply;

- headers: `List-Unsubscribe`, `List-Id`, `Precedence: bulk | list | junk`, `X-Auto-Response-Suppress` (`Auto-Submitted` mail was already treated as an auto-reply);
- senders: `noreply@`, `no-reply@`, `donotreply@`, `notifications@`, `mailer-daemon@`, `postmaster@`;
- Outlook's Focused Inbox: mail Outlook filed under **Other** (Graph `inferenceClassification`), its own switch.

Each excluded email stores why (`Message.excludedBy`: a rule id, or `auto:internal`, `auto:list-unsubscribe`, `auto:noreply`, `auto:focused-other`, …) and the badge shows it. When several rules match, a mailbox's own rule wins, then `ignore` over `no_reply_needed`, then the oldest rule; rules win over built-in detection.

**How it is applied**

- During sync, before reply detection and before AI summarization — excluded mail costs no AI calls.
- Per message, not per thread: a thread whose incoming emails are **all** excluded becomes `no_reply_needed` (hidden when all are `ignore`), gets the category *Notification* and is skipped by the AI. If a real person later replies inside such a thread, that email counts as usual.
- Adding, editing, deactivating a rule or flipping a switch re-applies the rules to the company's stored emails (in chunks) and recomputes the affected threads. If a very large mailbox does not finish inside one request, the Settings message says so; finish with `pnpm rules:reapply`.
- Quick actions for admins on tracker rows and on each email of a thread page: **Ignore this sender** / **Ignore this domain** create the rule, show how many emails were affected, and offer **Undo**.

**Default rules** (seeded for new companies automatically; shown in Settings where you can edit or deactivate them):

| Rule | Action |
|---|---|
| domain `godaddy.com` | ignore |
| domain `secureserver.net` | ignore |
| domain `microsoft.com` + subject contains `Microsoft 365` | no reply needed |
| sender `mailer-daemon@*`, sender `postmaster@*` | ignore |

After deploying this version run once:

```bash
pnpm db:deploy
pnpm rules:seed-defaults            # adds the defaults to existing companies and re-applies all rules (idempotent)
pnpm sync:once all --reset          # optional: re-reads the backfill window so OLD mail gets header signals and Outlook's Focused/Other flag
```

Header signals and the Focused/Other flag are recorded when a message is synced. Mail stored before this version has neither until a `--reset` sync re-reads it; sender- and subject-based rules and the `noreply@` detection work on old mail immediately. (Graph delta links remember the fields they were created with, so `--reset` is also what makes *new* mail carry the Focused/Other flag.)

## 10. Ask (chat)

**Ask** (`/c/<slug>/ask`) answers questions such as *"What happened to shipment 4512?"* or *"Latest update from supplier X about excipient Y?"* with a short answer taken only from the stored emails, and numbered citations that open the exact emails (in the dashboard thread view, and in Outlook when a link is stored). It is off by default (`CHAT_ENABLED`): no menu entry, and the page and its route return 404.

**How it works**

1. **Search index.** Every message has a `searchVector` (Postgres `tsvector`, GIN index) built from subject, sender, recipients and the cleaned body; every thread has one built from subject + AI summary + key points + next action. The vectors are computed in app code from the plaintext at write time (bodies may be encrypted at rest) and written with one statement per sync page. Postgres' `'simple'` configuration is used: no stemming, no stop words. The app normalizes text the same way when indexing and when searching ([packages/core/src/ask/text.ts](packages/core/src/ask/text.ts)): letters and digits become separate tokens and every other character separates, so `4512`, `PO 4512`, `PO-4512`, `PO#4512` and `INV/2026/4512` all find each other; Arabic-Indic digits, diacritics, alef/ya/ta-marbuta variants and a leading "ال" are folded so `الإنسولين` matches `انسولين`.
2. **Tools.** Claude gets four read-only tools ([packages/core/src/ask/tools.ts](packages/core/src/ask/tools.ts)): `search_emails`, `search_threads`, `get_thread`, `get_messages`. The company and the mailboxes they may read come from the signed-in user's session, never from model input; a mailbox argument can only narrow the search; every row is re-checked before it is returned; excluded mail (§9), auto-replies and Cc copies of the same email are left out. No tool can write anything or reach Microsoft Graph.
3. **Answer loop** ([packages/core/src/ask/answer.ts](packages/core/src/ask/answer.ts)). At most 6 tool calls and about 40k input tokens per question; when a limit is hit the model answers with what it has and says so. The final answer comes through a `final_answer` tool (`answer_markdown`, `citations`, `found`). The server then checks every citation: an email id that no tool returned for this question is dropped and its marker removed from the text. An answer that claims facts but has no valid citation left is shown as **Unverified** (no automatic retry: a retry costs another full call and can fail the same way).
4. **Follow-ups.** A chat keeps its earlier questions and answers as context, with each answer's citations (id, subject, sender, date) but not the emails that were read, so follow-ups stay cheap. A chat holds up to 10 questions.
5. **Privacy and limits.** Chats are private to the user who asked (admins see usage totals only, in Settings → AI usage). Each question is audited as `chat.ask` (question text only). The retention purge also removes chats older than the company's retention window. Every Claude call is logged in `AiUsage` with `purpose = chat` and the user; questions count toward `AI_MAX_CALLS_PER_DAY`, and each user may ask `AI_CHAT_MAX_QUESTIONS_PER_USER_PER_DAY` questions per day.

**Privacy note on the search index.** The index stores the *words* of each email (lower-cased, without order beyond positions) as plain text in the database, even when `DATA_ENCRYPTION_KEY` encrypts the bodies. That is the price of searching inside Postgres. A company that does not want this can untick *Settings → Storage & retention → "Index email bodies for search"* (`searchIndexBodies`, default on): then only subjects and participants are indexed, and questions about body content will find less. After changing it run `pnpm search:reindex --org <slug> --all`.

**Environment**

| Variable | Default | Meaning |
|---|---|---|
| `CHAT_ENABLED` | `false` | switches the Ask page on (`true` / `1`) |
| `ANTHROPIC_CHAT_MODEL` | `claude-sonnet-5-5` | model that answers questions |
| `ANTHROPIC_CHAT_DEEP_MODEL` | `claude-opus-5-5` | model used when the user ticks "Deep answer" |
| `AI_CHAT_MAX_QUESTIONS_PER_USER_PER_DAY` | `50` | per-user daily limit (calls also count toward `AI_MAX_CALLS_PER_DAY`) |

`AI_EFFORT` (default `low`) also applies to chat.

**Commands**

```bash
pnpm search:reindex [--org <slug>] [--all]     # build the search index for stored mail (500 rows per statement; re-run to resume; --all rebuilds everything)
pnpm search:backfill-links [--org <slug>]      # fetch "Open in Outlook" links for mail synced before links were stored (read-only $batch GETs, resumable)
pnpm ask:eval [--deep]                         # 12 fixed questions against the demo company with the real API; prints pass/fail and cost
```

**Cost per question** (measured with `pnpm ask:eval` on the demo data, 2 Oct 2026, `AI_EFFORT=low`; 12 questions including one Arabic, one follow-up and one with no answer in the mail):

| Model | Passed | Average per question | Range |
|---|---|---|---|
| `claude-sonnet-5-5` (default) | 12 / 12 | $0.0085 | $0.0055 – $0.0150 |
| `claude-opus-5-5` (Deep answer) | 12 / 12 | $0.0157 | $0.0094 – $0.0298 |

Demo emails are short, so these are the low end. Real threads with long bodies cost more per question. As an upper estimate (computed from the prices, not measured): a question that fills the whole 40k-token budget is on the order of $0.10 on Sonnet and $0.25 on Opus. Most of the input is served from the prompt cache (system prompt and tools are cached, and so is the conversation between the rounds of one question).

**Storage.** Measured on 10,000 synthetic emails with ~900-character bodies: about 14.6 MB of vectors + 7.7 MB of GIN index, so **about 22 MB per 10,000 emails** (the stored bodies of the same emails take 17 MB). On Neon's free 0.5 GB this is the largest new consumer; the Companies page shows the search index size next to the database size. With `searchIndexBodies` off the index is a small fraction of that.

**Turning it on in production**

```bash
# 1. laptop, production .env (cp .env.production .env)
pnpm db:deploy                    # additive migration: new columns, tables and indexes only
# 2. deploy the app (git push); CHAT_ENABLED still unset, so nothing is visible yet. New mail is indexed from now on.
pnpm search:reindex               # index the mail that is already stored
pnpm search:backfill-links        # Outlook links for that mail
# 3. Vercel → Environment Variables: CHAT_ENABLED=true (and optionally the model variables), then redeploy
```

Outlook links for *new* mail: Graph delta links remember the fields they were created with, so mailboxes synced before this version keep delivering new mail without `webLink` until a `pnpm sync:once <mailbox> --reset` (the same reset §9 recommends). Until then, re-running `pnpm search:backfill-links` fills the gaps; answers work either way, only the "Open in Outlook" link is missing.

To switch it off again, unset `CHAT_ENABLED` and redeploy; stored chats and the index stay.

**Tests.** `pnpm test` runs the pure logic (text normalization, query plans, the loop with a mocked Claude client, citation validation, prompt-injection cases). The Postgres-backed tests (real full-text search, tool scope across companies, usage rows and cost, limits, retention, the migration) run only when `TEST_DATABASE_URL` names a disposable database with the migrations applied — never `DATABASE_URL`, because `.env` may point at production:

```bash
TEST_DATABASE_URL="postgres://…@localhost:…/…" pnpm test
```

## Commands

| Command | What it does |
|---|---|
| `pnpm db:generate` / `db:migrate` / `db:deploy` / `db:push` / `db:studio` | Prisma |
| `pnpm db:local` | local Postgres (Prisma dev server), writes `DATABASE_URL` into `.env` |
| `pnpm mailbox add <email> [--org-name] [--org-domain] [--tenant] [--alias …]` | register a mailbox |
| `pnpm mailbox list` / `pause <email>` / `resume <email>` | manage mailboxes |
| `pnpm sync:once <email\|all> [--reset] [--days N] [--no-ai]` | backfill / incremental sync, then AI summaries for touched threads |
| `pnpm folders:list <email\|all> [--org <slug>]` | every mail folder with item counts; marks extra sent folders (read-only) |
| `pnpm folders:import <email\|all> [--org <slug>] [--folder <name...>] [--days N] [--dry-run]` | load extra sent folders (e.g. "Sent" left by a Zoho migration) as sent mail so replies in them count |
| `pnpm replies:recompute <email\|all> [--no-dedupe]` | re-link copies across mailboxes + internal recipients, then re-run reply detection + thread status for every thread |
| `pnpm replies:report <email> [--days 30]` | reply stats + oldest unanswered emails, for spot-checking against Outlook |
| `pnpm rules:seed-defaults [--org <slug>] [--no-apply]` | add the default exclusion rules to companies that lack them, then re-apply all rules |
| `pnpm rules:reapply [--org <slug>]` | re-evaluate stored emails against the current exclusion rules and recompute the affected threads |
| `pnpm search:reindex [--org <slug>] [--all]` | build / rebuild the Ask search index for stored emails and threads (resumable) |
| `pnpm search:backfill-links [--org <slug>]` | fetch Outlook links for emails synced before links were stored (read-only, resumable) |
| `pnpm ask:eval [--deep]` | Ask evaluation against the demo company with the real Claude API (costs a few cents) |
| `pnpm ai:backfill <email\|all> [--limit N] [--dry-run]` | summarize unsummarized threads via the Batch API; dry-run prints the cost estimate |
| `pnpm ai:summarize <email\|all> [--limit N]` | live summaries for threads with new messages |
| `pnpm ai:summarize-thread <threadId> [--force]` | summarize one thread, print JSON |
| `pnpm ai:period <email\|all> [--period day\|week\|month] [--org <domain>]` | very short digest of everything sent and received, stored for the Summary page |
| `pnpm ai:usage [--days 30]` | Claude calls, tokens and cost |
| `pnpm user add <email> [--org <domain> --role admin\|viewer] [--owner]` / `user list` / `user remove <email> [--org <domain>]` | dashboard users and memberships |
| `pnpm org:seed` / `org:seed-pioneer` / `org:seed-api-pharma` | known company records |
| `pnpm dev` / `pnpm build` / `pnpm start` | web dashboard |
| `pnpm db:seed-demo [--remove]` | demo organization with 40 fake threads |
| `pnpm --filter @email-tracker/web test:e2e` | Playwright smoke tests |
| `pnpm test` | unit tests (vitest) |
| `pnpm --filter @email-tracker/core check:sync` | end-to-end sync check against your DB using a fake mail provider (no Graph needed) |
| `pnpm typecheck` | TypeScript across the workspace |

## Environment variables

See [.env.example](.env.example). Required: `DATABASE_URL`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`. Optional: `BACKFILL_DAYS` (90), `REPLY_SLA_HOURS` (24, business hours; per-org override via `Organization.replySlaHours`), `DATA_ENCRYPTION_KEY`, `LOG_LEVEL` (`debug|info|warn|error`).

Dashboard: `AUTH_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ISSUER`, `AUTH_URL` (production).

Ask (chat): `CHAT_ENABLED` (`false`), `ANTHROPIC_CHAT_MODEL` (`claude-sonnet-5-5`), `ANTHROPIC_CHAT_DEEP_MODEL` (`claude-opus-5-5`), `AI_CHAT_MAX_QUESTIONS_PER_USER_PER_DAY` (50) — see §10.

AI: `ANTHROPIC_API_KEY` (required for summaries), `ANTHROPIC_MODEL` (`claude-sonnet-5-5`), `ANTHROPIC_MODEL_LIGHT` (optional, e.g. `claude-haiku-4-5`), `AI_MAX_CALLS_PER_DAY` (500, per org per day), `AI_SUMMARY_DEBOUNCE_MINUTES` (2), `AI_EFFORT` (`low`).
