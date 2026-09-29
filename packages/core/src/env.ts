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
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  AI_MAX_CALLS_PER_DAY: z.coerce.number().int().positive().default(500),
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
