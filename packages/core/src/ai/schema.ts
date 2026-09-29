import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const CATEGORIES = ["customer", "supplier", "internal", "regulatory", "finance", "newsletter", "notification", "other"] as const;
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const LANGUAGES = ["en", "ar", "mixed"] as const;

/** Zod schema matching SPEC §7.3 exactly. Used to validate every tool call. */
export const ThreadSummarySchema = z.object({
  summary: z.string().min(1).max(4000),
  key_points: z.array(z.string().min(1).max(1000)).max(20),
  asks: z
    .array(
      z.object({
        from: z.string().max(300),
        ask: z.string().min(1).max(1000),
        due: z.string().max(100).nullable(),
      }),
    )
    .max(20),
  next_action: z.string().max(1000).nullable(),
  needs_reply: z.boolean(),
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES),
  concluded: z.boolean(),
  language: z.enum(LANGUAGES),
});

export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

export const SUMMARY_TOOL_NAME = "record_thread_summary";

/** The single tool Claude must call. `strict` guarantees schema-valid arguments. */
export const SUMMARY_TOOL: Anthropic.Tool = {
  name: SUMMARY_TOOL_NAME,
  description:
    "Record the structured summary of an email thread. Call this exactly once with the final result. All fields are required.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "2–4 sentences in plain language: what the thread is about, who wants what, current status." },
      key_points: { type: "array", items: { type: "string" }, description: "Short bullet facts: products, quantities, prices, PO/invoice/quotation numbers, deadlines, decisions." },
      asks: {
        type: "array",
        description: "Open requests made in the thread.",
        items: {
          type: "object",
          properties: {
            from: { type: "string", description: "Name or email of who is asking" },
            ask: { type: "string", description: "What they want" },
            due: { anyOf: [{ type: "string" }, { type: "null" }], description: "Deadline as written in the email, or null" },
          },
          required: ["from", "ask", "due"],
          additionalProperties: false,
        },
      },
      next_action: { anyOf: [{ type: "string" }, { type: "null" }], description: "What our side should do next, or null if nothing." },
      needs_reply: { type: "boolean", description: "true only if our side still owes a reply." },
      category: { type: "string", enum: [...CATEGORIES] },
      priority: { type: "string", enum: [...PRIORITIES] },
      concluded: { type: "boolean", description: "true if the conversation is finished and nobody is expected to write again." },
      language: { type: "string", enum: [...LANGUAGES], description: "Language of the emails themselves." },
    },
    required: ["summary", "key_points", "asks", "next_action", "needs_reply", "category", "priority", "concluded", "language"],
    additionalProperties: false,
  },
};
