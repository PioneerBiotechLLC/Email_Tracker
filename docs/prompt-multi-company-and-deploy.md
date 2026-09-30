Build "Phase 5: multi-company + go live". Commit anything uncommitted first; commit at the end. Stop when done so I can test.

Context: Phases 1–4 are done. Phase 5 (live sync) and Phase 6 (digest) from SPEC.md are NOT built yet, and there is no pg-boss worker running. We are deploying to VERCEL (serverless — no always-on worker) with NEON Postgres (free tier: 0.5 GB storage, scales to zero, via the Vercel Marketplace integration). Adapt the SPEC's worker design to serverless as described below. Mailboxes stay READ-ONLY (Mail.Read only).

PART 1 — Multiple companies + company picker

1. Companies are the existing Organization model. A company can be on a DIFFERENT Microsoft 365 tenant from the others (Pioneer Biotech is a separate tenant from API Pharma).
   - Keep Organization.azureTenantId per company; the Graph client must request tokens for that company's tenant (already per-tenant — verify).
   - Make the mail-reading Entra app MULTI-TENANT ("Accounts in any organizational directory"). Add a "Connect Microsoft 365" flow for a company: an admin-consent link (https://login.microsoftonline.com/{tenant}/adminconsent?client_id=…&redirect_uri=…) + callback route that records consent success and the tenant ID on that company. Document the same Application Access Policy (PowerShell) step for each company's tenant.
2. Users can belong to several companies:
   - Replace AppUser.orgId with a Membership table (userId, orgId, role admin|viewer). Migration must move existing users into memberships without losing anyone. Add a global "owner" flag for me (can see/manage all companies).
   - Update `pnpm user add <email> --org <domain> --role …` to add a membership.
3. Dashboard company picker:
   - Company switcher at the top of the sidebar (logo + name, dropdown list of the companies the user belongs to). Selected company goes in the URL (/c/<orgSlug>/…) so links are shareable; remember last choice in a cookie. Add Organization.slug (unique).
   - Every query stays scoped to the selected company AND checked against the user's membership (never trust the URL alone). Add tests: a user without membership for company B gets 404 on /c/b/*.
   - Apply each company's branding (logo, primary color, fonts) when it's selected.
4. Owner-only page "Companies": list companies, add a company (name, slug, email domain(s), tenant ID, timezone, work days/hours, SLA, summary language, logo URL, primary color, fonts), show connection status (consent granted? mailboxes? last sync?), and a button to add mailboxes from the UI (resolves the Graph user like `pnpm mailbox add`). Keep the CLI working too.
5. Dashboard sign-in must work for users from ANY company tenant: set the Entra login app to multi-tenant, use the "organizations" issuer, and only allow emails that have a Membership (existing allow-list rule).
6. Seed Pioneer Biotech as the second company (script `pnpm org:seed-pioneer`, idempotent):
   - name "Pioneer Biotech", slug "pioneer-biotech", domain: <@pbio.tech>, tenant ID: <FILL IN or leave empty until consent>
   - timezone Asia/Dubai, Sun–Thu 09:00–18:00, SLA 24h, summary language en
   - branding: primary #C2922F (Pioneer Gold), secondary #0B1F3A (deep navy)
   - AI prompt context per company: add Organization.aiContext (text) and include it in the summary system prompt. Pioneer Biotech: "Life sciences distribution: pharma & biopharma, medical devices, scientific/analytical instruments, bioprocessing equipment, lab equipment, APIs and raw materials. Offices in Masdar City (Abu Dhabi) and New Cairo (Egypt)." API Pharma: "Pharmaceutical trading: APIs & excipients distribution (MOH-approved storage in UAE), branches in UAE, KSA, Egypt, Algeria."
7. Keep the multi-mailbox rules (cross-mailbox reply matching, internal-email de-dup) working per company — never match replies across different companies.

PART 2 — Live sync on serverless (replaces the pg-boss worker for now)

8. Graph webhook: POST /api/graph/webhook
   - Handle validationToken handshake (return it as text/plain within 10s), verify clientState, respond 202 fast, and do the work after the response with Next.js `after()`: run the incremental delta sync for that mailbox, then reply recompute, then AI summarize for touched threads (respect debounce: if within debounce, leave it for the next cron run).
   - Also handle lifecycle notifications (reauthorizationRequired, subscriptionRemoved, missed) at /api/graph/lifecycle.
   - Implement GraphProvider.subscribe/renew (currently throw). Subscribe on mailbox add; store subscriptionId/expiry.
9. Protected cron endpoints (require header `Authorization: Bearer ${CRON_SECRET}`):
   - /api/cron/sync — delta sync all active mailboxes (safety net), one mailbox per invocation step if needed; make it resumable and stay under the function time limit (process in chunks, save progress, continue next run).
   - /api/cron/summarize — summarize threads past the debounce window, respecting AI_MAX_CALLS_PER_DAY.
   - /api/cron/renew-subscriptions — renew any expiring within 24h; recreate missing ones.
   - /api/cron/retention — purge DB rows older than the retention setting (DB only, never the mailbox).
   - Vercel Hobby only allows daily crons, so: put renew-subscriptions and retention in vercel.json as daily crons, AND add a GitHub Actions workflow (.github/workflows/cron.yml) that calls /api/cron/sync and /api/cron/summarize every 15 minutes with the CRON_SECRET (free). Document that on Vercel Pro these can move into vercel.json instead.
10. Heavy jobs stay on the CLI, NOT on Vercel: initial 90-day backfill (`pnpm sync:once`) and the AI batch backfill (`pnpm ai:backfill`) are run from my laptop against the production DATABASE_URL. Document this clearly.

PART 3 — Production readiness

11. Database (Neon):
   - Use Neon's pooled connection string for the app (DATABASE_URL) and the direct one for migrations (DIRECT_URL); configure Prisma for both. Make sure the Prisma client works in Vercel serverless (adapter-pg with a small pool, or Neon's serverless driver adapter — pick the reliable option and explain).
   - `pnpm db:deploy` runs migrations against production; do NOT run migrations inside the Vercel build.
   - Storage guard: Neon free is 0.5 GB. Add an owner-visible storage indicator (DB size via pg_database_size) on the Companies page, and an org setting "store email bodies: full | preview only" (default full). Warn at 80%.
12. Vercel config:
   - Monorepo build for apps/web (Root Directory apps/web, pnpm, install from repo root, `prisma generate` in postinstall/build). vercel.json with the daily crons and function maxDuration where needed.
   - All env vars listed in .env.example with which are needed in Production vs local only. Add CRON_SECRET, DIRECT_URL, APP_URL. GRAPH_WEBHOOK_URL derived from APP_URL.
   - Security headers (CSP, HSTS, X-Frame-Options DENY, Referrer-Policy), disable the demo org and the test auth bypass in production (fail the build if NODE_ENV=production and the bypass flag is set).
   - Health endpoint /api/health (DB reachable, Graph token for each company obtainable, last sync age) — no secrets in output.
   - Error logging: structured logs, no email bodies.
13. Write docs/DEPLOY.md — a step-by-step go-live checklist I can follow without coding:
   a. Create Neon via Vercel Marketplace (or neon.com), copy pooled + direct URLs.
   b. Import the GitHub repo into Vercel, set Root Directory, env vars.
   c. Entra: make the mail app multi-tenant; add redirect URIs for production (login + admin-consent callback).
   d. Run `pnpm db:deploy`, `pnpm user add <my email> --owner`.
   e. For EACH company (API Pharma, Pioneer Biotech): open Companies → Connect Microsoft 365 → tenant admin approves consent → run the Application Access Policy PowerShell in THAT tenant → add mailboxes → run backfill from laptop → run AI dry-run then backfill.
   f. Add GitHub Actions secrets (APP_URL, CRON_SECRET).
   g. Verify: /api/health green, send a test email to a tracked mailbox → appears in ≤1 min, reply → status updates.
   h. Rollback: how to redeploy the previous version in Vercel.
14. Tests: membership scoping, company switcher, webhook validation + clientState rejection, cron auth rejection, subscription renew logic (mock Graph), migration of AppUser → Membership. Keep `pnpm test`, `pnpm typecheck`, and `pnpm build` passing.

At the end give me: what changed, the exact list of env vars to paste into Vercel, what I must do by hand (in order), and anything you weren't sure about.
