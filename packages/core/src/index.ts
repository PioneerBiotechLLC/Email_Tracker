export { getEnv, type Env } from "./env.js";
export { loadDotenv } from "./dotenv.js";
export { createLogger, type Logger } from "./log.js";
export { getDb, disconnectDb } from "./db.js";
export type { PrismaClient } from "./db.js";
export * from "./db.js";
export { protectBody, readBody, encryptText, decryptText, getEncryptionKey } from "./crypto.js";
export { getGraphClient, withGraphRetry, graphBatch } from "./graph/client.js";
export { getGraphAccessToken } from "./graph/auth.js";
export { GraphProvider } from "./mail/graph-provider.js";
export type * from "./mail/provider.js";
export { normalizeSubject, isAutoReplySubject } from "./mail/subject.js";
export { extractReplyHeaders, headerMap, parseMessageIds, normalizeMessageId } from "./mail/headers.js";
export { cleanBody, htmlToText, stripQuotedHistory, stripSignature, tidyWhitespace } from "./mail/text.js";
export { syncMailbox, type SyncOptions, type SyncStats } from "./sync/sync-mailbox.js";
export { recomputeThread, recomputeMailboxThreads, businessHoursFor, slaHoursFor, ownerAddresses } from "./sync/threads.js";
export {
  detectReplies, computeThreadStatus, effectiveTime, isFromUs, isRealInbound, isRealOutbound, REPLY_VERBS, FORWARD_VERB,
  type ReplyInputMessage, type ReplyResult, type DetectOptions, type ThreadState, type StatusOptions, type StatusResult,
} from "./sync/replies.js";
export { businessMinutesBetween, addBusinessMinutes, rawMinutesBetween, localParts, zonedTimeToUtc, DEFAULT_BUSINESS_HOURS, type BusinessHours } from "./sync/business-hours.js";
export { getAnthropic, hasAnthropicKey, supportsEffort } from "./ai/client.js";
export { PRICES, BATCH_DISCOUNT, priceFor, estimateCostUsd, estimateTokens, type TokenUsage, type ModelPrice } from "./ai/pricing.js";
export { ThreadSummarySchema, SUMMARY_TOOL, SUMMARY_TOOL_NAME, CATEGORIES, PRIORITIES, LANGUAGES, type ThreadSummary } from "./ai/schema.js";
export { systemPrompt, userMessage, buildThreadInput, formatMessageLine, formatLocalDate, DEFAULT_INPUT_TOKEN_BUDGET, type InputMessage, type BuiltInput } from "./ai/prompts.js";
export {
  summarizeThread, summarizeThreads, prepareThread, applySummaryToThread, decideSkip, applyNeedsReplyDecision, shouldCloseAsConcluded,
  chooseModel, parseSummaryResponse, callSummary, summarizeWithRetry, buildMessageParams, countCallsToday, recordUsage, startOfLocalDay,
  type SummarizeResult, type SummarizeManyResult, type SummaryClient, type SummaryRequest, type PreparedThread, type SkipReason,
} from "./ai/summarize-thread.js";
export { planBackfill, runBackfill, EST_OUTPUT_TOKENS, type BackfillPlan, type RunResult } from "./ai/backfill.js";
export { usageReport, type UsageReport, type UsageRow } from "./ai/usage.js";
export { can, assertCan, assertSameOrg, mailboxScope, ForbiddenError, type Role, type Action, type SessionContext } from "./auth/permissions.js";
export { logAudit, type AuditEntry } from "./auth/audit.js";
export { computeKpis, bucketByDay, slowestSenders, worstStatus, inboundStatus, median, average, dayKey, senderKey, type InboundRow, type Kpis, type DayBucket, type SenderStat, type ThreadStatusName } from "./stats/kpis.js";
export { requireGraphEnv } from "./env.js";
