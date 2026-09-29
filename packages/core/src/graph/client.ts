import { Client, type AuthenticationProvider } from "@microsoft/microsoft-graph-client";
import { getGraphAccessToken } from "./auth.js";
import { createLogger } from "../log.js";

const log = createLogger("graph");

const clients = new Map<string, Client>();

/** Graph SDK client for a tenant. The SDK's default middleware already retries 429/503 with Retry-After. */
export function getGraphClient(tenantId: string): Client {
  let c = clients.get(tenantId);
  if (!c) {
    const authProvider: AuthenticationProvider = {
      getAccessToken: () => getGraphAccessToken(tenantId),
    };
    c = Client.initWithMiddleware({ authProvider, defaultVersion: "v1.0" });
    clients.set(tenantId, c);
  }
  return c;
}

export function graphStatus(err: unknown): number | undefined {
  const e = err as { statusCode?: number; status?: number } | undefined;
  return e?.statusCode ?? e?.status;
}

export function graphErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; body?: unknown } | undefined;
  if (e?.code) return e.code;
  try {
    const body = typeof e?.body === "string" ? JSON.parse(e.body) : e?.body;
    return (body as { error?: { code?: string } })?.error?.code;
  } catch {
    return undefined;
  }
}

function retryAfterMs(err: unknown): number | null {
  const headers = (err as { headers?: unknown })?.headers;
  let value: string | null | undefined;
  if (headers && typeof (headers as Headers).get === "function") value = (headers as Headers).get("retry-after");
  else if (headers && typeof headers === "object") value = (headers as Record<string, string>)["retry-after"];
  const secs = Number(value);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Extra retry layer on top of the SDK middleware: honours Retry-After on
 * 429/503/504 and falls back to exponential backoff with jitter.
 */
export async function withGraphRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 6): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const status = graphStatus(err);
      const retryable = status === 429 || status === 503 || status === 504 || status === 502;
      attempt += 1;
      if (!retryable || attempt >= maxAttempts) throw err;
      const delay = retryAfterMs(err) ?? Math.min(60_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
      log.warn(`throttled on ${label}; retrying`, { status, attempt, delayMs: delay });
      await sleep(delay);
    }
  }
}

/** Runs Graph $batch requests (max 20 per call), returning responses keyed by request id. */
export interface BatchRequest {
  id: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}
export interface BatchResponse {
  id: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export async function graphBatch(client: Client, requests: BatchRequest[]): Promise<Map<string, BatchResponse>> {
  const out = new Map<string, BatchResponse>();
  for (let i = 0; i < requests.length; i += 20) {
    const chunk = requests.slice(i, i + 20);
    const res = (await withGraphRetry("$batch", () => client.api("/$batch").post({ requests: chunk }))) as {
      responses: BatchResponse[];
    };
    for (const r of res.responses) out.set(r.id, r);
  }
  return out;
}
