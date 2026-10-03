# Go-live checklist (Vercel + Neon)

Follow top to bottom. Nothing here needs code changes. Commands run on your laptop from the repo root unless stated otherwise. Values you generate once: `openssl rand -base64 32` (AUTH_SECRET), `openssl rand -hex 32` (CRON_SECRET, GRAPH_CLIENT_STATE).

**Architecture in one paragraph.** The dashboard and all live-sync endpoints run on Vercel (serverless). Microsoft Graph pushes change notifications to `/api/graph/webhook`; every 15 minutes a GitHub Actions job calls `/api/cron/sync` and `/api/cron/summarize` as a safety net; Vercel's daily crons renew Graph subscriptions and purge old rows. Heavy one-off jobs (the initial 90-day backfill and the AI batch backfill) run from your laptop against the production database. Mailboxes stay read-only (`Mail.Read`).

## a. Neon database

1. In Vercel → Storage → **Create Database → Neon** (Marketplace), or at neon.com. Region: closest to your users (e.g. Frankfurt).
2. Copy two connection strings from Neon → Connection details:
   - **Pooled** (host contains `-pooler`) → `DATABASE_URL`
   - **Direct** (no `-pooler`) → `DIRECT_URL`
   Both end with `?sslmode=require`. Keep `connection_limit=5` on the pooled one if you want a smaller pool per function.
3. Free tier: 0.5 GB storage, scales to zero. The Companies page shows usage and warns at 80%; switch companies to "preview only" body storage or shorten retention if it climbs.

## b. Vercel project

1. Push the repo to GitHub (main branch).
2. Vercel → **Add New → Project** → import the repo.
   - **Root Directory:** `apps/web`
   - Framework: Next.js (auto). Build/install commands come from `apps/web/vercel.json` (installs from the repo root with pnpm, generates the Prisma client, builds).
   - Node.js version: 20 or later.
3. **Environment variables** (Production). Paste these; values marked ⚙ are generated/copied as described:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | Neon pooled string ⚙ |
   | `AZURE_CLIENT_ID` | mail-reading app (client) id |
   | `AZURE_CLIENT_SECRET` | its client secret |
   | `AZURE_TENANT_ID` | your home tenant id (used only as the CLI default) |
   | `GRAPH_CLIENT_STATE` | `openssl rand -hex 32` ⚙ |
   | `APP_URL` | `https://<your-vercel-domain>` (no trailing slash) |
   | `CRON_SECRET` | `openssl rand -hex 32` ⚙ |
   | `AUTH_SECRET` | `openssl rand -base64 32` ⚙ |
   | `AUTH_URL` | same as APP_URL |
   | `AUTH_MICROSOFT_ENTRA_ID_ID` | login app client id (same app or a separate one, see c) |
   | `AUTH_MICROSOFT_ENTRA_ID_SECRET` | its client secret |
   | `AUTH_MICROSOFT_ENTRA_ID_ISSUER` | `https://login.microsoftonline.com/organizations/v2.0` |
   | `ANTHROPIC_API_KEY` | from console.anthropic.com |
   | `ANTHROPIC_MODEL` | `claude-sonnet-5-5` |
   | `ANTHROPIC_MODEL_LIGHT` | `claude-haiku-4-5` (optional) |
   | `AI_MAX_CALLS_PER_DAY` | `500` |
   | `AI_SUMMARY_DEBOUNCE_MINUTES` | `2` |
   | `AI_EFFORT` | `low` |
   | `DATA_ENCRYPTION_KEY` | `openssl rand -base64 32` ⚙ (keep it safe: bodies are unreadable without it) |
   | `REPLY_SLA_HOURS` | `24` |
   | `DB_STORAGE_LIMIT_MB` | `512` |
   | `LOG_LEVEL` | `info` |

   Do **not** set `DIRECT_URL`, `E2E_BYPASS_EMAIL` or `DEV_ALLOWED_ORIGINS` in Vercel (the build fails on purpose if the bypass flag is present).
4. Deploy. The first deploy works before the database has tables; pages will error until step d.
5. (Optional) add a custom domain, then update `APP_URL`, `AUTH_URL` and the redirect URIs below, and redeploy.

## c. Entra ID (Microsoft) apps

**Mail-reading app** (`Email Tracker`, application permissions `Mail.Read`, `User.Read.All`):

1. Entra admin center → App registrations → Email Tracker → **Authentication** → Supported account types: **Accounts in any organizational directory (multi-tenant)**.
2. Same page → Add a platform → Web → redirect URI: `https://<your-domain>/api/graph/consent/callback` (this is where the admin-consent flow returns).
3. API permissions: keep `Mail.Read` and `User.Read.All` (Application). Admin consent is granted **per company tenant** via the dashboard (step e), not here.

**Login app** (dashboard sign-in). Either reuse the same registration or create `Email Tracker Dashboard`:

1. Authentication → Web → redirect URIs: `https://<your-domain>/api/auth/callback/microsoft-entra-id` (and `http://localhost:3000/api/auth/callback/microsoft-entra-id` for local use).
2. Supported account types: **multi-tenant** (so users from Pioneer Biotech's tenant can sign in).
3. Delegated permissions: `openid`, `profile`, `email`, `User.Read`. Create a client secret → `AUTH_MICROSOFT_ENTRA_ID_*`.

## d. Database schema and your owner account

On your laptop, with a `.env` that has `DATABASE_URL` = Neon **pooled** and `DIRECT_URL` = Neon **direct** (plus `AZURE_*`, `ANTHROPIC_API_KEY`, `DATA_ENCRYPTION_KEY` identical to Vercel):

```bash
pnpm install
pnpm db:generate
pnpm db:deploy                                   # applies all migrations via DIRECT_URL
pnpm user add <your email> --owner               # owners see and manage every company
pnpm org:seed                                    # creates API Pharma and Pioneer Biotech company records
```

Migrations are never run by the Vercel build. Run `pnpm db:deploy` yourself after pulling a change that adds a migration.

## e. For EACH company (API Pharma, Pioneer Biotech)

1. Open `https://<your-domain>/companies` (owner only). Check the company's domain, timezone, branding and AI context; edit if needed.
2. Click **Connect Microsoft 365**. Sign in as a **Global Administrator of that company's tenant** and accept. You are redirected back and the tenant id is recorded ("Microsoft 365 connected").
3. In **that tenant**, restrict the app to the tracked mailboxes (PowerShell, run by that tenant's Exchange admin):

   ```powershell
   Install-Module ExchangeOnlineManagement -Scope CurrentUser
   Connect-ExchangeOnline -UserPrincipalName admin@<company-domain>

   New-DistributionGroup -Name "EmailTracker-Allowed" -Alias emailtracker-allowed -Type Security
   Add-DistributionGroupMember -Identity "EmailTracker-Allowed" -Member sales@<company-domain>
   # …one Add-DistributionGroupMember per mailbox to track

   New-ApplicationAccessPolicy -AppId <AZURE_CLIENT_ID> `
     -PolicyScopeGroupId emailtracker-allowed@<company-domain> `
     -AccessRight RestrictAccess -Description "Email Tracker: read-only access to tracked mailboxes"

   Test-ApplicationAccessPolicy -Identity sales@<company-domain> -AppId <AZURE_CLIENT_ID>   # expect Granted
   Test-ApplicationAccessPolicy -Identity ceo@<company-domain>   -AppId <AZURE_CLIENT_ID>   # expect Denied
   ```
   Policies can take up to 30 minutes to apply.
4. Back on the Companies page: **Add mailbox** for each address. This resolves the user in Graph and subscribes to live notifications. (The CLI `pnpm mailbox add sales@<domain> --tenant <id>` does the same.)
5. Add the company's dashboard users: `pnpm user add <email> --org <company-domain> --role admin|viewer`, or Settings → Users inside the company.
6. **Backfill from your laptop** (uses the production `DATABASE_URL` in your `.env`):
   ```bash
   pnpm sync:once sales@<company-domain> --no-ai          # last 90 days of Inbox + Sent
   pnpm folders:list sales@<company-domain>                # migrated mailbox? old sent mail in a plain "Sent" folder
   pnpm folders:import all --org <company>                # …then load it as sent mail (README §8)
   pnpm replies:report sales@<company-domain> --days 30   # sanity check against Outlook
   pnpm ai:backfill sales@<company-domain> --dry-run      # shows thread count + estimated cost, no spend
   pnpm ai:backfill sales@<company-domain>                # Batch API (50% cheaper); waits and saves results
   ```
   These are deliberately not run on Vercel (function time limits).

## f. GitHub Actions secrets (15-minute cron)

Repo → Settings → Secrets and variables → Actions → **New repository secret**:

- `APP_URL` = `https://<your-domain>`
- `CRON_SECRET` = the same value as in Vercel

The workflow `.github/workflows/cron.yml` then calls `/api/cron/sync` and `/api/cron/summarize` every 15 minutes. Check Actions → cron for green runs. (On Vercel Pro you can instead add both paths to `apps/web/vercel.json` with schedule `*/15 * * * *` and delete the workflow.)

## g. Verify

1. `https://<your-domain>/api/health` → `"ok": true`, every company `"graphToken": "ok"`, `oldestSyncAgeMinutes` small.
2. Send a test email to a tracked mailbox → it appears in Inbox Tracker within about a minute (webhook), and in any case within 15 minutes (cron).
3. Reply to it from Outlook → the row turns "Replied ✓" within a minute; the thread summary refreshes a couple of minutes later.
4. Companies page: every mailbox shows "notifications until <date ~7 days ahead>". If it says "none", check `APP_URL`, `GRAPH_CLIENT_STATE`, and that the mailbox is in the access policy group; then run the daily cron by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/cron/renew-subscriptions`.

## h. Rollback

Vercel → Project → **Deployments** → open the previous good deployment → **⋯ → Promote to Production** (or "Instant Rollback" on the current one). Database migrations are forward-only; if a migration must be undone, restore from Neon's point-in-time history (Neon → Branches → Restore) before promoting the old build.
