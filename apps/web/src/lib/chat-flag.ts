import "server-only";
import { cookies } from "next/headers";
import { chatEnabledInEnv, E2E_CHAT_COOKIE } from "@/lib/chat-env";
import { e2eBypassEmail } from "@/lib/e2e";

/**
 * Whether the "Ask" chat is on (CHAT_ENABLED). When off there is no menu entry
 * and the middleware answers 404 for the page and its routes; server code checks again here.
 */
export async function chatEnabled(): Promise<boolean> {
  if (!chatEnabledInEnv) return false;
  // The auth bypass is never active outside NODE_ENV=test, so this cookie means nothing in a deployed app.
  if (e2eBypassEmail && (await cookies()).get(E2E_CHAT_COOKIE)?.value === "off") return false;
  return true;
}
