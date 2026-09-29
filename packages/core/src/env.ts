import { z } from "zod";
import { loadDotenv } from "./dotenv.js";

loadDotenv();

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AZURE_TENANT_ID: z.string().min(1, "AZURE_TENANT_ID is required"),
  AZURE_CLIENT_ID: z.string().min(1, "AZURE_CLIENT_ID is required"),
  AZURE_CLIENT_SECRET: z.string().min(1, "AZURE_CLIENT_SECRET is required"),
  GRAPH_WEBHOOK_URL: z.string().optional(),
  GRAPH_CLIENT_STATE: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Main summarization model */
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  /** Optional cheaper model for very short threads (1–2 short messages) */
  ANTHROPIC_MODEL_LIGHT: z.string().optional(),
  AI_MAX_CALLS_PER_DAY: z.coerce.number().int().positive().default(500),
  /** Wait this long after the last message before summarizing (bursts → one call) */
  AI_SUMMARY_DEBOUNCE_MINUTES: z.coerce.number().min(0).default(2),
  /** Reasoning effort for models that support it (low keeps summaries cheap) */
  AI_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  BACKFILL_DAYS: z.coerce.number().int().positive().default(90),
  REPLY_SLA_HOURS: z.coerce.number().positive().default(24),
  DIGEST_FROM_MAILBOX: z.string().optional(),
  DATA_ENCRYPTION_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Parsed, validated environment. Throws a readable error listing missing vars. */
export function getEnv(): Env {
  if (cached) return cached;
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}\n(see .env.example)`);
  }
  cached = result.data;
  return cached;
}
