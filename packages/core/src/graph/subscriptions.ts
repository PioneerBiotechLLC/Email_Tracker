/**
 * Subscription lifecycle rules (pure). Graph message subscriptions live at most
 * 10080 minutes (7 days); we ask for slightly less and renew when < 24h remain.
 */
export const MAX_SUBSCRIPTION_MINUTES = 10_070;
export const RENEW_WITHIN_MS = 24 * 60 * 60 * 1000;

export type SubscriptionAction = "create" | "renew" | "none";

export function subscriptionExpiry(now = new Date(), minutes = MAX_SUBSCRIPTION_MINUTES): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

/** What to do for a mailbox: create when missing/expired, renew when expiring within 24h, else nothing. */
export function subscriptionAction(
  mb: { isActive: boolean; subscriptionId: string | null; subscriptionExpiresAt: Date | null },
  now = new Date(),
  renewWithinMs = RENEW_WITHIN_MS,
): SubscriptionAction {
  if (!mb.isActive) return "none";
  if (!mb.subscriptionId || !mb.subscriptionExpiresAt) return "create";
  const remaining = mb.subscriptionExpiresAt.getTime() - now.getTime();
  if (remaining <= 0) return "create";
  if (remaining < renewWithinMs) return "renew";
  return "none";
}

export interface SubscriptionUrls {
  notificationUrl: string;
  lifecycleNotificationUrl?: string;
}

/** Request body for POST /subscriptions on a user's messages (created + updated, so reply verbs are caught). */
export function subscriptionPayload(graphUserId: string, urls: SubscriptionUrls, clientState: string, expiresAt: Date) {
  return {
    changeType: "created,updated",
    notificationUrl: urls.notificationUrl,
    ...(urls.lifecycleNotificationUrl ? { lifecycleNotificationUrl: urls.lifecycleNotificationUrl } : {}),
    resource: `/users/${graphUserId}/messages`,
    expirationDateTime: expiresAt.toISOString(),
    clientState,
  };
}

/** Webhook URLs derived from APP_URL unless GRAPH_WEBHOOK_URL overrides them. Returns null for local/unset. */
export function webhookUrls(env: { APP_URL?: string | undefined; GRAPH_WEBHOOK_URL?: string | undefined }): SubscriptionUrls | null {
  const notificationUrl = env.GRAPH_WEBHOOK_URL || (env.APP_URL ? `${env.APP_URL.replace(/\/$/, "")}/api/graph/webhook` : null);
  if (!notificationUrl) return null;
  let host = "";
  try { host = new URL(notificationUrl).hostname; } catch { return null; }
  if (!/^https:/.test(notificationUrl) || host === "localhost" || host === "127.0.0.1") return null;
  const lifecycleNotificationUrl = notificationUrl.replace(/\/api\/graph\/webhook$/, "/api/graph/lifecycle");
  return { notificationUrl, lifecycleNotificationUrl: lifecycleNotificationUrl !== notificationUrl ? lifecycleNotificationUrl : undefined };
}
