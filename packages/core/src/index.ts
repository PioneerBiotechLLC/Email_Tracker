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
