# Outlook AI Email Tracker

Connects to Microsoft 365 mailboxes (read-only), tracks which inbound emails were replied to and how fast, summarizes threads with Claude, and shows it all on a dashboard with a daily digest. Full brief: [SPEC.md](SPEC.md).

**Status: Phase 1 (Foundation) complete** — monorepo, Prisma schema, Graph app-only auth, and a backfill CLI. Phases 2–7 (reply tracking, AI summaries, dashboard, live sync, digest, deploy) follow.

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

Thread `status` in Phase 1 is a naive "who spoke last" value; Phase 2 replaces it with proper reply detection.

## Commands

| Command | What it does |
|---|---|
| `pnpm db:generate` / `db:migrate` / `db:deploy` / `db:push` / `db:studio` | Prisma |
| `pnpm mailbox add <email> [--org-name] [--org-domain] [--tenant] [--alias …]` | register a mailbox |
| `pnpm mailbox list` / `pause <email>` / `resume <email>` | manage mailboxes |
| `pnpm sync:once <email\|all> [--reset] [--days N]` | backfill / incremental sync |
| `pnpm test` | unit tests (vitest) |
| `pnpm --filter @email-tracker/core check:sync` | end-to-end sync check against your DB using a fake mail provider (no Graph needed) |
| `pnpm typecheck` | TypeScript across the workspace |

## Environment variables

See [.env.example](.env.example). Required in Phase 1: `DATABASE_URL`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`. Optional: `BACKFILL_DAYS` (90), `DATA_ENCRYPTION_KEY`, `LOG_LEVEL` (`debug|info|warn|error`).
