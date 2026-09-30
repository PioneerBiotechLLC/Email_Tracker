/**
 * Pure helpers for Microsoft Graph change notifications (SPEC §5.2). No I/O.
 */
export type LifecycleEvent = "reauthorizationRequired" | "subscriptionRemoved" | "missed";

export interface GraphNotification {
  subscriptionId: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  resourceData?: { id?: string; "@odata.type"?: string };
  lifecycleEvent?: LifecycleEvent;
  subscriptionExpirationDateTime?: string;
  tenantId?: string;
}

export interface ParsedNotifications {
  accepted: GraphNotification[];
  /** notifications dropped because clientState did not match (or was missing) */
  rejected: number;
}

/** The validation handshake: Graph POSTs ?validationToken=… and expects it echoed as text/plain. */
export function validationTokenFrom(url: URL | string): string | null {
  const u = typeof url === "string" ? new URL(url) : url;
  const t = u.searchParams.get("validationToken");
  return t && t.length <= 2048 ? t : null;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Validates the JSON body and keeps only notifications whose clientState matches ours. */
export function parseNotifications(body: unknown, expectedClientState: string): ParsedNotifications {
  const out: ParsedNotifications = { accepted: [], rejected: 0 };
  const list = (body as { value?: unknown })?.value;
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    const n = raw as GraphNotification;
    if (!n || typeof n.subscriptionId !== "string") { out.rejected += 1; continue; }
    if (!expectedClientState || typeof n.clientState !== "string" || !safeEqual(n.clientState, expectedClientState)) { out.rejected += 1; continue; }
    out.accepted.push(n);
  }
  return out;
}

/** Distinct subscription ids from accepted notifications (one sync per mailbox per delivery). */
export function subscriptionIds(notifications: GraphNotification[]): string[] {
  return Array.from(new Set(notifications.map((n) => n.subscriptionId)));
}
