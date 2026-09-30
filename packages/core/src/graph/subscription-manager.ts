import type { PrismaClient } from "../db.js";
import { getEnv } from "../env.js";
import { createLogger } from "../log.js";
import { GraphProvider } from "../mail/graph-provider.js";
import { subscriptionAction, webhookUrls, type SubscriptionAction } from "./subscriptions.js";

const log = createLogger("subscriptions");

export interface EnsureResult {
  mailboxId: string;
  action: SubscriptionAction | "skipped" | "error";
  detail?: string;
  expiresAt?: Date;
}

/** Creates or renews the Graph subscription for one mailbox and stores the result. */
export async function ensureSubscription(db: PrismaClient, mailboxId: string, opts: { force?: boolean; now?: Date } = {}): Promise<EnsureResult> {
  const env = getEnv();
  const urls = webhookUrls(env);
  if (!urls) return { mailboxId, action: "skipped", detail: "APP_URL/GRAPH_WEBHOOK_URL is not a public https URL; live notifications need a deployed app" };
  if (!env.GRAPH_CLIENT_STATE) return { mailboxId, action: "skipped", detail: "GRAPH_CLIENT_STATE is not set" };
  const mb = await db.mailbox.findUniqueOrThrow({ where: { id: mailboxId }, include: { org: true } });
  if (!mb.org.azureTenantId) return { mailboxId, action: "skipped", detail: "company has no Microsoft 365 tenant yet (admin consent pending)" };
  const now = opts.now ?? new Date();
  let action = subscriptionAction(mb, now);
  if (opts.force && action === "none") action = "renew";
  if (action === "none") return { mailboxId, action };

  const provider = new GraphProvider(mb.org.azureTenantId);
  try {
    let result: { id: string; expiresAt: Date };
    if (action === "renew" && mb.subscriptionId) {
      try {
        result = await provider.renew(mb.subscriptionId);
      } catch (err) {
        // Renewal of a vanished subscription → create a new one.
        log.warn("renew failed; creating a new subscription", { mailbox: mb.emailAddress, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
        action = "create";
        result = await provider.subscribe(mb.graphUserId, urls.notificationUrl, env.GRAPH_CLIENT_STATE, urls.lifecycleNotificationUrl);
      }
    } else {
      result = await provider.subscribe(mb.graphUserId, urls.notificationUrl, env.GRAPH_CLIENT_STATE, urls.lifecycleNotificationUrl);
    }
    await db.mailbox.update({ where: { id: mailboxId }, data: { subscriptionId: result.id, subscriptionExpiresAt: result.expiresAt } });
    log.info(`subscription ${action}`, { mailbox: mb.emailAddress, expiresAt: result.expiresAt.toISOString() });
    return { mailboxId, action, expiresAt: result.expiresAt };
  } catch (err) {
    const detail = err instanceof Error ? err.message.slice(0, 300) : String(err);
    log.error("subscription failed", { mailbox: mb.emailAddress, action, detail });
    return { mailboxId, action: "error", detail };
  }
}

/** Renews expiring subscriptions and creates missing ones for every active mailbox. */
export async function renewAllSubscriptions(db: PrismaClient, now = new Date()): Promise<EnsureResult[]> {
  const mailboxes = await db.mailbox.findMany({ where: { isActive: true }, select: { id: true } });
  const out: EnsureResult[] = [];
  for (const mb of mailboxes) out.push(await ensureSubscription(db, mb.id, { now }));
  return out;
}
