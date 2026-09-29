# Outlook AI Email Tracker

Connects to Microsoft 365 mailboxes (read-only), tracks which inbound emails were replied to and how fast, summarizes threads with Claude, and shows it all on a dashboard with a daily digest. Full brief: [SPEC.md](SPEC.md).

**Status: Phase 3 (AI summaries) complete** — on top of Phase 1 (monorepo, Prisma schema, Graph app-only auth, backfill CLI) and Phase 2 (reply tracking). Phases 4–7 (dashboard, live sync, digest, deploy) follow.

## Hard rules

- The app is **read-only** on mailboxes. It only ever uses `Mail.Read` (plus `Mail.Send` from one dedicated digest mailbox, Phase 6). It never deletes, moves, flags, or marks anything.
- No secrets in code. Everything comes from environment variables (`.env`, see `.env.example`).
- Emails may be Arabic, English, or mixed.

## Repo layout

```
apps/worker      CLI scripts now; sync + AI jobs (pg-boss) from Phase 5
apps/web         Next.js dashboard + Graph webhook (Phase 4)
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
cp .env.example .env          # fill in DATABASE_URL and the AZURE_* values
pnpm db:generate              # generate the Prisma client
pnpm db:deploy                # apply migrations (or `pnpm db:migrate` during development)
```

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
- When: a thread is summarized when it has new messages (`messageCount > summaryMessageCount`) and its last message is older than `AI_SUMMARY_DEBOUNCE_MINUTES` (a burst → one call). After `pnpm sync:once` the touched threads are summarized automatically (skip with `--no-ai`). Live sync (Phase 5) will do the same from the worker.
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

## Commands

| Command | What it does |
|---|---|
| `pnpm db:generate` / `db:migrate` / `db:deploy` / `db:push` / `db:studio` | Prisma |
| `pnpm mailbox add <email> [--org-name] [--org-domain] [--tenant] [--alias …]` | register a mailbox |
| `pnpm mailbox list` / `pause <email>` / `resume <email>` | manage mailboxes |
| `pnpm sync:once <email\|all> [--reset] [--days N] [--no-ai]` | backfill / incremental sync, then AI summaries for touched threads |
| `pnpm replies:recompute <email\|all>` | re-run reply detection + thread status for every thread |
| `pnpm replies:report <email> [--days 30]` | reply stats + oldest unanswered emails, for spot-checking against Outlook |
| `pnpm ai:backfill <email\|all> [--limit N] [--dry-run]` | summarize unsummarized threads via the Batch API; dry-run prints the cost estimate |
| `pnpm ai:summarize <email\|all> [--limit N]` | live summaries for threads with new messages |
| `pnpm ai:summarize-thread <threadId> [--force]` | summarize one thread, print JSON |
| `pnpm ai:usage [--days 30]` | Claude calls, tokens and cost |
| `pnpm test` | unit tests (vitest) |
| `pnpm --filter @email-tracker/core check:sync` | end-to-end sync check against your DB using a fake mail provider (no Graph needed) |
| `pnpm typecheck` | TypeScript across the workspace |

## Environment variables

See [.env.example](.env.example). Required: `DATABASE_URL`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`. Optional: `BACKFILL_DAYS` (90), `REPLY_SLA_HOURS` (24, business hours; per-org override via `Organization.replySlaHours`), `DATA_ENCRYPTION_KEY`, `LOG_LEVEL` (`debug|info|warn|error`).

AI: `ANTHROPIC_API_KEY` (required for summaries), `ANTHROPIC_MODEL` (`claude-sonnet-5-5`), `ANTHROPIC_MODEL_LIGHT` (optional, e.g. `claude-haiku-4-5`), `AI_MAX_CALLS_PER_DAY` (500, per org per day), `AI_SUMMARY_DEBOUNCE_MINUTES` (2), `AI_EFFORT` (`low`).
