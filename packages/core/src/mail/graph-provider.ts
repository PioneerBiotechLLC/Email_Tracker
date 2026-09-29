import type { Client } from "@microsoft/microsoft-graph-client";
import { getGraphClient, graphBatch, graphErrorCode, graphStatus, withGraphRetry } from "../graph/client.js";
import { createLogger } from "../log.js";
import type { RawHeader } from "./headers.js";
import type {
  DeltaPage,
  ListChangesOptions,
  ListChangesResult,
  MailProvider,
  MailUser,
  RawMessage,
  RawRecipient,
  SubscriptionInfo,
} from "./provider.js";

const log = createLogger("graph-provider");

/** Messages are requested with immutable ids so moves between folders don't change the id. */
const PREFER_HEADER = 'IdType="ImmutableId", outlook.body-content-type="text", odata.maxpagesize=50';

const SELECT_FIELDS = [
  "id",
  "changeKey",
  "conversationId",
  "internetMessageId",
  "subject",
  "from",
  "toRecipients",
  "ccRecipients",
  "receivedDateTime",
  "sentDateTime",
  "bodyPreview",
  "body",
  "hasAttachments",
  "importance",
  "isDraft",
  "parentFolderId",
  "internetMessageHeaders",
];

const EXT_PROPS_FILTER = "id eq 'Integer 0x1081' or id eq 'SystemTime 0x1082'";
const EXPAND_EXT = `singleValueExtendedProperties($filter=${EXT_PROPS_FILTER})`;

interface GraphRecipient {
  emailAddress?: { address?: string; name?: string };
}
interface GraphExtProp {
  id: string;
  value: string;
}
interface GraphMessage {
  id: string;
  "@removed"?: { reason: string };
  changeKey?: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  hasAttachments?: boolean;
  importance?: string;
  isDraft?: boolean;
  internetMessageHeaders?: RawHeader[];
  singleValueExtendedProperties?: GraphExtProp[];
}
interface DeltaResponse {
  value: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

function recipient(r: GraphRecipient | undefined): RawRecipient | null {
  const address = r?.emailAddress?.address?.trim().toLowerCase();
  if (!address) return null;
  return { address, name: r?.emailAddress?.name ?? null };
}

function recipients(list: GraphRecipient[] | undefined): RawRecipient[] {
  return (list ?? []).map(recipient).filter((r): r is RawRecipient => !!r);
}

function parseExtProps(props: GraphExtProp[] | undefined): { lastVerb: number | null; lastVerbAt: Date | null } {
  let lastVerb: number | null = null;
  let lastVerbAt: Date | null = null;
  for (const p of props ?? []) {
    const id = p.id.toLowerCase();
    if (id.includes("0x1081")) {
      const n = Number(p.value);
      lastVerb = Number.isFinite(n) ? n : null;
    } else if (id.includes("0x1082")) {
      const d = new Date(p.value);
      lastVerbAt = Number.isNaN(d.getTime()) ? null : d;
    }
  }
  return { lastVerb, lastVerbAt };
}

export function toRawMessage(m: GraphMessage): RawMessage {
  const ext = parseExtProps(m.singleValueExtendedProperties);
  const received = m.receivedDateTime ? new Date(m.receivedDateTime) : m.sentDateTime ? new Date(m.sentDateTime) : new Date();
  const bodyType = (m.body?.contentType ?? "text").toLowerCase() === "html" ? "html" : "text";
  return {
    id: m.id,
    changeKey: m.changeKey ?? null,
    conversationId: m.conversationId ?? null,
    internetMessageId: m.internetMessageId ?? null,
    subject: m.subject ?? "",
    from: recipient(m.from),
    to: recipients(m.toRecipients),
    cc: recipients(m.ccRecipients),
    receivedAt: received,
    sentAt: m.sentDateTime ? new Date(m.sentDateTime) : null,
    bodyPreview: m.bodyPreview ?? "",
    body: m.body?.content != null ? { contentType: bodyType, content: m.body.content } : null,
    hasAttachments: !!m.hasAttachments,
    importance: m.importance ?? "normal",
    isDraft: !!m.isDraft,
    headers: m.internetMessageHeaders ?? null,
    lastVerb: ext.lastVerb,
    lastVerbAt: ext.lastVerbAt,
  };
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export class GraphProvider implements MailProvider {
  private readonly client: Client;
  /** Whether the delta endpoint accepted $expand for extended properties; probed on first use. */
  private deltaSupportsExpand: boolean | null = null;

  constructor(readonly tenantId: string) {
    this.client = getGraphClient(tenantId);
  }

  async resolveUser(emailOrUpn: string): Promise<MailUser> {
    const u = (await withGraphRetry("resolveUser", () =>
      this.client
        .api(`/users/${encodeURIComponent(emailOrUpn)}`)
        .select("id,displayName,mail,userPrincipalName,proxyAddresses")
        .get(),
    )) as { id: string; displayName?: string; mail?: string; userPrincipalName: string; proxyAddresses?: string[] };
    return {
      id: u.id,
      displayName: u.displayName ?? null,
      mail: u.mail ?? null,
      userPrincipalName: u.userPrincipalName,
      proxyAddresses: (u.proxyAddresses ?? [])
        .filter((p) => p.toLowerCase().startsWith("smtp:"))
        .map((p) => p.slice(5).toLowerCase()),
    };
  }

  private initialDeltaUrl(userId: string, folder: string, sinceDays: number, withExpand: boolean): string {
    const filter = `receivedDateTime ge ${isoDaysAgo(sinceDays)}`;
    let url =
      `/users/${userId}/mailFolders/${folder}/messages/delta` +
      `?$select=${SELECT_FIELDS.join(",")}&$filter=${encodeURIComponent(filter)}`;
    if (withExpand) url += `&$expand=${encodeURIComponent(EXPAND_EXT)}`;
    return url;
  }

  private async fetchDeltaPage(url: string): Promise<DeltaResponse> {
    return (await withGraphRetry("delta", () =>
      this.client.api(url).header("Prefer", PREFER_HEADER).get(),
    )) as DeltaResponse;
  }

  async *listChanges(opts: ListChangesOptions): AsyncGenerator<DeltaPage, ListChangesResult, void> {
    const { userId, folder, sinceDays } = opts;
    let url: string;
    let expandInUrl: boolean;

    if (opts.deltaLink) {
      url = opts.deltaLink;
      expandInUrl = /%24expand=|\$expand=/i.test(url);
    } else {
      expandInUrl = this.deltaSupportsExpand !== false;
      url = this.initialDeltaUrl(userId, folder, sinceDays, expandInUrl);
    }

    let page: DeltaResponse;
    for (;;) {
      try {
        page = await this.fetchDeltaPage(url);
        if (expandInUrl && this.deltaSupportsExpand === null) this.deltaSupportsExpand = true;
      } catch (err) {
        const status = graphStatus(err);
        const code = graphErrorCode(err);
        // First attempt with $expand rejected → retry the initial request without it.
        if (expandInUrl && status === 400 && !opts.deltaLink && this.deltaSupportsExpand !== true) {
          log.warn("delta endpoint rejected $expand; falling back to $batch enrichment", { code });
          this.deltaSupportsExpand = false;
          expandInUrl = false;
          url = this.initialDeltaUrl(userId, folder, sinceDays, false);
          continue;
        }
        // Stale/invalid delta token → start over from an initial backfill.
        if (opts.deltaLink && (status === 410 || code === "SyncStateNotFound" || code === "ResyncRequired")) {
          log.warn("delta token expired; restarting full backfill", { folder, code });
          expandInUrl = this.deltaSupportsExpand !== false;
          url = this.initialDeltaUrl(userId, folder, sinceDays, expandInUrl);
          opts.deltaLink = null;
          continue;
        }
        throw err;
      }

      const removedIds: string[] = [];
      const live: GraphMessage[] = [];
      for (const m of page.value) {
        if (m["@removed"]) removedIds.push(m.id);
        else live.push(m);
      }
      let messages = live.map(toRawMessage);
      if (!expandInUrl && messages.length) messages = await this.enrich(userId, messages);

      yield { messages, removedIds };

      const next = page["@odata.nextLink"];
      if (next) {
        url = next;
        if (opts.onProgress) await opts.onProgress(next);
        continue;
      }
      const deltaLink = page["@odata.deltaLink"];
      if (!deltaLink) throw new Error("Delta response had neither nextLink nor deltaLink");
      return { deltaLink };
    }
  }

  /** Fills in lastVerb/lastVerbAt (and headers if missing) via $batch when delta can't $expand them. */
  private async enrich(userId: string, messages: RawMessage[]): Promise<RawMessage[]> {
    const requests = messages.map((m, i) => ({
      id: String(i),
      method: "GET" as const,
      url:
        `/users/${userId}/messages/${m.id}?$select=id,internetMessageHeaders` +
        `&$expand=${encodeURIComponent(EXPAND_EXT)}`,
      headers: { Prefer: 'IdType="ImmutableId"' },
    }));
    const responses = await graphBatch(this.client, requests);
    return messages.map((m, i) => {
      const r = responses.get(String(i));
      if (!r || r.status >= 300) {
        log.warn("enrichment failed for message", { status: r?.status });
        return m;
      }
      const body = r.body as GraphMessage;
      const ext = parseExtProps(body.singleValueExtendedProperties);
      return {
        ...m,
        headers: m.headers ?? body.internetMessageHeaders ?? null,
        lastVerb: ext.lastVerb,
        lastVerbAt: ext.lastVerbAt,
      };
    });
  }

  async getMessages(userId: string, ids: string[]): Promise<RawMessage[]> {
    if (!ids.length) return [];
    const requests = ids.map((id, i) => ({
      id: String(i),
      method: "GET" as const,
      url: `/users/${userId}/messages/${id}?$select=${SELECT_FIELDS.join(",")}&$expand=${encodeURIComponent(EXPAND_EXT)}`,
      headers: { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' },
    }));
    const responses = await graphBatch(this.client, requests);
    const out: RawMessage[] = [];
    for (let i = 0; i < ids.length; i++) {
      const r = responses.get(String(i));
      if (r && r.status < 300 && r.body) out.push(toRawMessage(r.body as GraphMessage));
      else if (r?.status !== 404) log.warn("getMessages item failed", { status: r?.status });
    }
    return out;
  }

  // Implemented in Phase 5 (live sync).
  async subscribe(_userId: string, _notificationUrl: string, _clientState: string): Promise<SubscriptionInfo> {
    throw new Error("GraphProvider.subscribe is implemented in Phase 5");
  }
  async renew(_subscriptionId: string): Promise<SubscriptionInfo> {
    throw new Error("GraphProvider.renew is implemented in Phase 5");
  }
}
