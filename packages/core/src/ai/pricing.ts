/**
 * Claude pricing, USD per 1M tokens. Cache write ≈ 1.25× input, cache read is
 * model-specific; Batch API = 50% off everything. Update when Anthropic changes prices.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

export const BATCH_DISCOUNT = 0.5;

/** Price for a model id; date-suffixed ids (claude-haiku-4-5-20251001) resolve to their base entry. */
export function priceFor(model: string): ModelPrice | null {
  if (PRICES[model]) return PRICES[model]!;
  const base = Object.keys(PRICES).find((k) => model.startsWith(k));
  return base ? PRICES[base]! : null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Cost in USD for one call. Unknown models are priced like Sonnet (flagged by priceFor returning null). */
export function estimateCostUsd(model: string, usage: TokenUsage, batch = false): number {
  const p = priceFor(model) ?? PRICES["claude-sonnet-5-5"]!;
  const perM =
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    usage.cacheReadTokens * p.cacheRead +
    usage.cacheWriteTokens * p.cacheWrite;
  const usd = perM / 1_000_000;
  return batch ? usd * BATCH_DISCOUNT : usd;
}

/** Rough token estimate for cost previews (≈3.5 chars per token for mixed English/Arabic). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
