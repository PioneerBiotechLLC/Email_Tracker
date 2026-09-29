import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "../env.js";

let client: Anthropic | null = null;

/**
 * Shared Anthropic client. The SDK already retries 408/409/429/5xx (incl. 529
 * overloaded) with exponential backoff and honours retry-after; we raise the
 * retry count so bursts during a backfill don't fail early.
 */
export function getAnthropic(): Anthropic {
  if (client) return client;
  const key = getEnv().ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set (see .env.example)");
  client = new Anthropic({ apiKey: key, maxRetries: 5, timeout: 120_000 });
  return client;
}

export function hasAnthropicKey(): boolean {
  return !!getEnv().ANTHROPIC_API_KEY;
}

/** Haiku 4.5 rejects `output_config.effort`; every other current model accepts it. */
export function supportsEffort(model: string): boolean {
  return !/haiku/i.test(model);
}

export type { Anthropic };
