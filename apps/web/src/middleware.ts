import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "./auth.config";
import { chatEnabledInEnv, E2E_CHAT_COOKIE } from "./lib/chat-env";
import { e2eBypassEmail } from "./lib/e2e";

const { auth } = NextAuth(authConfig);

/** Every page needs a signed-in, allow-listed user. Machine endpoints (Graph webhooks/consent callback, cron, health) authenticate themselves. */
const ASK_PATH = /^\/c\/[^/]+\/ask(\/|$)/;

export default auth((req) => {
  // The Ask chat does not exist while CHAT_ENABLED is off: a real 404, before any page starts streaming.
  if (ASK_PATH.test(req.nextUrl.pathname) && (!chatEnabledInEnv || (e2eBypassEmail && req.cookies.get(E2E_CHAT_COOKIE)?.value === "off"))) {
    return new NextResponse("Not found", { status: 404 });
  }
  // Test-only bypass for Playwright (see lib/e2e.ts); never active outside NODE_ENV=test.
  if (e2eBypassEmail) return NextResponse.next();
  if (!req.auth?.user?.userId) {
    const url = new URL("/signin", req.nextUrl.origin);
    url.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!api/auth|api/graph/webhook|api/graph/lifecycle|api/graph/consent|api/cron|api/health|signin|no-access|_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
