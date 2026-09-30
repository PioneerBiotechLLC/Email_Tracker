Add "Exclusion rules" — emails that should NOT be counted (e.g. GoDaddy account-activity notifications, newsletters, system alerts). Commit first if anything is uncommitted; commit at the end as "Exclusion rules". Stop when done so I can test.

1. Rules model (per company/Organization) — new table ExclusionRule:
   id, orgId, type (sender_email | sender_domain | subject_contains | subject_regex), value, action, note, createdBy, createdAt, isActive.
   Actions:
   - "ignore": store the message but hide it everywhere by default (tracker, threads, KPIs, digest) and never send it to the AI.
   - "no_reply_needed": show it, but never count it as awaiting reply/overdue and don't send it to the AI.
   Matching is case-insensitive; sender_domain matches subdomains too (godaddy.com matches email.godaddy.com). A mailbox can also have its own rules (optional mailboxId on the rule).

2. Built-in automatic detection (on by default, can be turned off per company in Settings):
   - Header signals: List-Unsubscribe, List-Id, Precedence: bulk/list/junk, Auto-Submitted (already handled), X-Auto-Response-Suppress.
   - Sender signals: noreply / no-reply / donotreply / notifications / mailer-daemon / postmaster addresses.
   - Outlook's own Focused Inbox signal: add Graph field `inferenceClassification` (focused | other) to the sync $select, store it on Message. Setting "Treat Outlook 'Other' as no_reply_needed" (default ON).
   Auto-detected messages get action no_reply_needed (not ignore), so nothing is hidden silently. Store WHY on the message: excludedBy (rule id or "auto:list-unsubscribe", "auto:noreply", "auto:focused-other", …) and exclusionAction.

3. Apply rules:
   - During sync, before reply detection and before AI summarization (saves AI cost).
   - A thread whose inbound messages are ALL excluded gets status no_reply_needed (or hidden if all "ignore"), category "notification", and is skipped by the AI.
   - A real person replying later inside an excluded thread still counts (rules apply per message, not forever per thread).
   - Adding/editing/removing a rule re-applies it to existing messages of that company (background-safe, chunked), then recomputes affected threads.
   - KPIs (replied %, response times, awaiting, overdue) exclude both actions by default.

4. Dashboard:
   - Settings → "Exclusion rules" (admin): list, add, edit, deactivate (don't hard-delete; keep audit), with a live preview "this rule matches N emails in the last 90 days" before saving.
   - On thread detail and tracker rows: "Ignore this sender" and "Ignore this domain" quick actions (admin) → creates a rule, shows count affected, undo button.
   - Filter toggle "Show excluded" on Tracker/Threads so excluded mail can still be reviewed; excluded rows show a small badge with the reason.
   - All rule changes go into AuditLog.

5. Default rules seeded for every company (idempotent script `pnpm rules:seed-defaults`, and applied to new companies automatically):
   - sender_domain godaddy.com → ignore (note: "GoDaddy account/billing notifications")
   - sender_domain secureserver.net → ignore
   - sender_domain microsoft.com + subject_contains "Microsoft 365" → no_reply_needed  (implement as two conditions ANDed if easy; otherwise sender_domain only with action no_reply_needed)
   - sender_email mailer-daemon@*, postmaster@* → ignore
   Show them in Settings so I can edit/remove them.

6. Tests: each rule type, subdomain matching, AND-conditions (if built), auto-detection signals, "Other" folder signal, re-apply on rule change, thread with mixed excluded + real messages, KPIs exclude them, AI is not called for excluded threads, company isolation (rules of company A never affect company B).

7. README: section "Excluding emails" with examples.

Rules: mailboxes stay read-only (we never move/delete/mark anything in Outlook — exclusion only affects our app). Keep `pnpm test`, `pnpm typecheck`, `pnpm build` passing. At the end: what changed, test results, anything unsure.
