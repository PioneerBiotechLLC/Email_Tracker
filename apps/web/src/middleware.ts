import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "./auth.config";
import { e2eBypassEmail } from "./lib/e2e";

const { auth } = NextAuth(authConfig);

/** Every page needs a signed-in, allow-listed user. Machine endpoints (Graph webhooks/consent callback, cron, health) authenticate themselves. */
export default auth((req) => {
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
