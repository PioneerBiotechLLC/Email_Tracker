# Outlook AI Email Tracker — Build Spec

> Hand this file to Claude Code as the project brief. Save it in the repo root as `SPEC.md` and tell Claude Code: *"Read SPEC.md and build this app phase by phase. Stop after each phase so I can test."*

---

## 1. What we're building

A web app that connects to one or more **Microsoft 365 (Outlook) mailboxes** and:

1. **Summarizes every email thread** (grouped by conversation/subject) using the Claude API — what it's about, who's asking what, current status, next action.
2. **Tracks replies** — for every incoming email: was it replied to, when, by whom, how long it took, and which emails are still waiting for a reply.
3. Shows everything on a **dashboard** and sends a **daily digest email** in plain, simple language.

First company: **API Pharma** (`api-pharma.net`), after its migration from Zoho to Microsoft 365. Build it so more mailboxes and more companies (Pioneer Biotech, Arab Lab, etc.) can be added later without code changes — this is intended to become a product.

### Hard rules
- **Read-only on mailboxes.** The app must NEVER delete, move, modify, flag, or mark-as-read any email. Only permission that touches mail content is `Mail.Read` (+ `Mail.Send` only from a single dedicated digest mailbox, see §8).
- Never store secrets in code. Everything via environment variables.
- Emails may be in **Arabic or English** (sometimes mixed). Summaries must handle both.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript everywhere |
| Web app | Next.js 15 (App Router) + Tailwind + shadcn/ui |
| DB | PostgreSQL (Supabase or Neon) via Prisma |
| Background jobs | `pg-boss` (Postgres-backed queue — no Redis needed) in a separate Node worker process |
| Mail source | Microsoft Graph API (`@microsoft/microsoft-graph-client` + `@azure/msal-node`) |
| AI | Anthropic Claude API (`@anthropic-ai/sdk`), model set by env var `ANTHROPIC_MODEL` |
| Dashboard login | Auth.js (NextAuth) with Microsoft Entra ID provider — only users from allowed tenants/emails can sign in |
| Hosting | Web on Vercel; worker on Railway/Render (or a single Docker Compose on a VPS) |

Repo layout (monorepo, pnpm workspaces):
```
/apps/web        Next.js dashboard + webhook endpoint
/apps/worker     sync + AI jobs (pg-boss)
/packages/core   shared: prisma schema, graph client, reply-detection, AI prompts
```

---

## 3. Microsoft Graph setup (document this in README)

1. Entra admin center → App registrations → New registration: `Email Tracker`.
2. API permissions → **Application** permissions: `Mail.Read`, `User.Read.All`. (Plus `Mail.Send` — see §8.) Grant admin consent.
3. Create a client secret (or certificate).
4. **Restrict the app to specific mailboxes** with an Exchange *Application Access Policy* (or RBAC for Applications) so it can only read the mailboxes we register — include the PowerShell commands in the README.
5. Env vars: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

Auth flow: client-credentials (app-only) token via MSAL, cached and refreshed automatically.

---

## 4. Data model (Prisma)

```
Organization   id, name, domain, azureTenantId, timezone (default "Asia/Dubai"), createdAt
Mailbox        id, orgId, emailAddress, displayName, graphUserId, isActive,
               inboxDeltaLink, sentDeltaLink, subscriptionId, subscriptionExpiresAt,
               lastSyncedAt
Thread         id, mailboxId, conversationId (unique per mailbox), normalizedSubject,
               firstMessageAt, lastMessageAt, messageCount,
               participants (json), status (enum, see §6),
               needsReply (bool), category (enum: customer|supplier|internal|
               regulatory|finance|newsletter|notification|other),
               priority (low|normal|high|urgent),
               summary (text), summaryLang, keyPoints (json), nextAction (text),
               summaryUpdatedAt, summaryMessageCount
Message        id, mailboxId, threadId, graphMessageId (unique), internetMessageId,
               inReplyTo, references (text[]), direction (inbound|outbound),
               folder (inbox|sent|other), fromAddress, fromName,
               toAddresses (json), ccAddresses (json), subject,
               receivedAt, sentAt, bodyPreview, bodyText (plain text, trimmed),
               hasAttachments, importance,
               lastVerb (int|null), lastVerbAt (datetime|null),
               repliedAt (datetime|null), repliedByMessageId (fk|null),
               replyMethod (enum: outlook_verb|header_match|conversation_match|null),
               responseMinutes (int|null)
DigestLog      id, orgId, sentAt, recipients, content
AppUser        id, orgId, email, role (admin|viewer)
```

Indexes: `(mailboxId, conversationId)`, `(threadId, receivedAt)`, `internetMessageId`, `(mailboxId, direction, repliedAt)`.

---

## 5. Sync engine (worker)

### 5.1 Initial backfill
- On adding a mailbox: pull last **N days** (env `BACKFILL_DAYS`, default 90) from **Inbox** and **Sent Items** using Graph **delta queries**:
  - `GET /users/{id}/mailFolders/inbox/messages/delta`
  - `GET /users/{id}/mailFolders/sentitems/messages/delta`
- `$select`: `id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,body,hasAttachments,importance,internetMessageHeaders,parentFolderId`
- `$expand`: `singleValueExtendedProperties($filter=id eq 'Integer 0x1081' or id eq 'SystemTime 0x1082')`
  - `0x1081` = PidTagLastVerbExecuted → `102` Reply, `103` Reply All, `104` Forward
  - `0x1082` = PidTagLastVerbExecutionTime
  - Note: if `$expand` isn't supported on the delta endpoint, fetch these properties with a follow-up batched `GET /messages/{id}` (use Graph `$batch`, 20 per request).
- Headers: keep `In-Reply-To` and `References` from `internetMessageHeaders`.
- Convert HTML body → plain text; strip quoted history and signatures (keep only the new content of each message); cap at 8,000 chars.
- Save `@odata.deltaLink` per folder for incremental syncs.
- Respect Graph throttling: honour `Retry-After` on 429/503, exponential backoff.

### 5.2 Live updates
- Create Graph **change-notification subscriptions** on `users/{id}/messages` (`changeType: created,updated`) pointing to `POST /api/graph/webhook` on the web app.
  - Handle the `validationToken` handshake (echo it as text/plain within 10s).
  - Verify `clientState` against a secret env var.
  - Webhook only enqueues a job (`sync-mailbox`) and returns 202 fast.
- Subscriptions expire (max ~7 days for messages) → a cron job renews any expiring within 24h.
- **Safety net:** also run the delta sync every 15 min per mailbox via cron, in case notifications are missed.
- `updated` notifications matter: that's how we catch the Reply verb (0x1081) being stamped on an inbound message after the user replies.

### 5.3 Provider abstraction
Put all mail access behind a `MailProvider` interface (`listChanges`, `getMessage`, `subscribe`, `renew`). Implement `GraphProvider` now. Leave room for an `ImapProvider` later (e.g. for Zoho mailboxes) — don't build it now.

---

## 6. Reply detection (core logic — put in `packages/core/replies.ts` with unit tests)

For each **inbound** message `M` (direction = inbound, not sent by the mailbox owner), decide `repliedAt` using the first rule that matches:

1. **Outlook verb** — `M.lastVerb ∈ {102, 103}` → `repliedAt = M.lastVerbAt`, `replyMethod = outlook_verb`. (104 = forwarded; store it but don't count it as a reply.)
2. **Header match** — an outbound message `S` in the same mailbox where `S.inReplyTo == M.internetMessageId` or `M.internetMessageId ∈ S.references` → `repliedAt = S.sentAt`, `replyMethod = header_match`, `repliedByMessageId = S.id`.
3. **Conversation match** — the earliest outbound `S` with the same `conversationId` and `S.sentAt > M.receivedAt` (and `M.fromAddress` is in S's to/cc) → `replyMethod = conversation_match`.

Then: `responseMinutes = repliedAt − M.receivedAt`, in **business-hours-aware** minutes (configurable per org; default Sun–Thu 09:00–18:00 Asia/Dubai). Store raw minutes too.

Re-run detection for a thread whenever any message in it is inserted or updated.

**Thread status** (recomputed after each change):
- `awaiting_us` — the latest message is inbound, `needsReply = true`, and there's no reply yet
- `awaiting_them` — the latest message is outbound
- `no_reply_needed` — AI marked `needsReply = false` (newsletters, notifications, FYI, "thanks")
- `closed` — manually closed by a user in the dashboard, or AI judged the conversation concluded

**Overdue:** `awaiting_us` for longer than the SLA (env `REPLY_SLA_HOURS`, default 24 business hours).

Unit tests must cover: reply via Outlook verb, reply from a phone (no verb, header match), reply-all, forward-only (not a reply), multiple inbound messages answered by one reply, a thread whose subject changed mid-way, and an auto-reply/out-of-office (not a real reply — detect via the `Auto-Submitted` / `X-Auto-Response-Suppress` headers or an "Automatic reply:" subject).

---

## 7. AI summarization (Claude API)

### 7.1 When
- Summarize a thread when it gets new messages — **debounce**: wait 2 minutes after the last message before summarizing, so a burst of messages causes only one call.
- Only re-summarize if `messageCount > summaryMessageCount`.
- Cap cost: env `AI_MAX_CALLS_PER_DAY`; log token usage per call.

### 7.2 Input
Thread messages in chronological order, each as:
`[inbound|outbound] <from> → <to> | <date> | <cleaned new-content text>`
Truncate the oldest messages first if the total goes over ~30k tokens; always keep the first and last 3 messages.

### 7.3 Output — force structured JSON via tool use
```json
{
  "summary": "2–4 sentences, plain language",
  "key_points": ["..."],
  "asks": [{"from": "name/email", "ask": "what they want", "due": "date or null"}],
  "next_action": "what our side should do next, or null",
  "needs_reply": true,
  "category": "customer|supplier|internal|regulatory|finance|newsletter|notification|other",
  "priority": "low|normal|high|urgent",
  "concluded": false,
  "language": "en|ar|mixed"
}
```
System prompt guidance: the company is a pharma trading business in the MENA region; write for a busy manager; no fluff; mention product names, quantities, prices, PO/invoice numbers and deadlines when present; summaries in **English** by default, with an org-level setting to switch to Arabic.

### 7.4 Subject grouping view
Besides conversation threads, provide a **"By subject"** view: group threads by `normalizedSubject` (lowercase, strip `RE:/FW:/FWD:/رد:/إعادة توجيه:` prefixes, ticket numbers in brackets, extra whitespace). This catches the same topic appearing in separate threads.

---

## 8. Daily digest email

- Sent every day at **08:00 org local time** (Asia/Dubai default) to configured recipients.
- Sent via Graph `POST /users/{digestMailbox}/sendMail` from ONE dedicated mailbox (e.g. `tracker@api-pharma.net`). Restrict `Mail.Send` to that mailbox only, using the Application Access Policy.
- Content, in simple, friendly language (Claude writes it from the day's structured data):
  1. **Needs your reply** — overdue first, with how long each has been waiting
  2. **Replied yesterday** — count + average response time
  3. **Important new threads** — high/urgent priority summaries
  4. **Waiting on others** — threads where we replied and they haven't answered in 3+ days
- Plain HTML email, mobile-friendly, links to the dashboard for each thread.
- Log each digest in `DigestLog`.

---

## 9. Dashboard (web)

All pages filterable by mailbox, date range, category, and priority.

1. **Overview**
   - KPI tiles: emails received (today/7d), replied %, avg + median response time, awaiting reply, overdue
   - Chart: response time trend (daily); received vs replied per day
   - Chart: awaiting-reply count by category
2. **Inbox Tracker** (main table) — one row per inbound email:
   `Received | From | Subject | Category | Priority | Status (Replied ✓ / Waiting / Overdue) | Replied at | Replied by | Response time`
   Sortable, searchable, CSV export. Overdue rows highlighted.
3. **Threads** — list of threads with their AI summary, status badge, and next action. Click → thread detail.
4. **Thread detail** — timeline of messages (inbound left, outbound right), full AI summary, key points, asks, reply-tracking info per message, and buttons: "Mark closed", "Mark no reply needed", "Re-summarize".
5. **By subject** — grouped subject view (§7.4).
6. **Settings** (admin only) — mailboxes (add/pause), business hours, SLA, digest recipients + time, summary language, AI usage/cost this month.

UI: clean, light/dark, responsive. RTL-safe rendering for Arabic text (`dir="auto"` on email content).

---

## 10. Security & privacy
- Encrypt `bodyText` at rest (pgcrypto or app-level AES-GCM with the key in an env var) — or add a setting to store only `bodyPreview` + the AI summary.
- Data retention setting (default 365 days) with a nightly purge job — this deletes records **from our database only**, never from the mailbox.
- Dashboard access only via Microsoft login plus an allow-list of users.
- Webhook endpoint: validate `clientState`, rate-limit, and never log email bodies.
- Send to Claude only what's needed for the summary (cleaned text, no attachments).

---

## 11. Environment variables
```
DATABASE_URL=
AZURE_TENANT_ID=
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
GRAPH_WEBHOOK_URL=https://<web-domain>/api/graph/webhook
GRAPH_CLIENT_STATE=<random secret>
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=
AI_MAX_CALLS_PER_DAY=500
BACKFILL_DAYS=90
REPLY_SLA_HOURS=24
DIGEST_FROM_MAILBOX=tracker@api-pharma.net
DATA_ENCRYPTION_KEY=
AUTH_SECRET=
AUTH_MICROSOFT_ENTRA_ID_ID=
AUTH_MICROSOFT_ENTRA_ID_SECRET=
AUTH_MICROSOFT_ENTRA_ID_ISSUER=
```
Provide `.env.example`.

---

## 12. Build phases (stop and let me test after each)

| Phase | Deliverable | Done when |
|---|---|---|
| **1. Foundation** | Monorepo, Prisma schema, Graph auth, CLI script `pnpm sync:once <mailbox>` doing the backfill into the DB | Last 90 days of Inbox + Sent are in Postgres with correct thread grouping |
| **2. Reply tracking** | `replies.ts` + unit tests + status computation | Tests pass; spot-check 20 real emails — replied/not replied and times match Outlook |
| **3. AI summaries** | Summarization job, structured output, debounce, cost cap | Every thread has a summary, category, needs_reply flag |
| **4. Dashboard** | Overview, Inbox Tracker, Threads, Thread detail, By subject | Usable end-to-end in the browser with Microsoft login |
| **5. Live sync** | Webhooks + subscription renewal + 15-min delta fallback | A new email appears on the dashboard within 1 min; a reply updates status within 1 min |
| **6. Digest + settings** | Daily digest email, settings page, retention job | Digest arrives at 08:00 Dubai time with correct content |
| **7. Deploy** | Dockerfiles / Vercel + Railway config, README with full setup (Entra app, access policy PowerShell, env vars) | Running in production on the API Pharma mailboxes |

---

## 13. Out of scope for v1 (plan for later)
- AI-drafted replies (the AI Mail Assistant — will reuse this Graph connection and data)
- Auto-filing emails into supplier/customer folders (would need `Mail.ReadWrite` — deliberately excluded for now)
- Zoho/IMAP provider
- Attachment content analysis
- Mobile app
