/**
 * CHAT_ENABLED as the web app reads it. No imports, so the middleware (edge runtime) can use it too.
 * (Destructured on purpose, like lib/e2e.ts: the value must come from the real runtime environment.)
 */
const { CHAT_ENABLED } = process.env;

export const chatEnabledInEnv = CHAT_ENABLED === "true" || CHAT_ENABLED === "1";

/** Playwright only: a cookie that switches the chat OFF for one browser context, so one dev server covers the flag-off case. */
export const E2E_CHAT_COOKIE = "e2e-chat";
