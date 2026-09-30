import NextAuth from "next-auth";
import { createLogger, getDb } from "@email-tracker/core";

const log = createLogger("auth");
import { authConfig } from "./auth.config";

/**
 * Full Auth.js instance (Node runtime). Only active AppUsers that are owners or
 * have at least one company membership may sign in.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user }) {
      const email = user.email?.toLowerCase();
      const denied = (reason: string) => `/no-access?${new URLSearchParams({ reason, ...(email ? { account: email } : {}) }).toString()}`;
      if (!email) return denied("no_email");
      try {
        const appUser = await getDb().appUser.findUnique({ where: { email }, include: { _count: { select: { memberships: true } } } });
        if (!appUser) return denied("not_listed");
        if (!appUser.isActive) return denied("inactive");
        if (!appUser.isOwner && appUser._count.memberships === 0) return denied("no_company");
        await getDb().appUser.update({ where: { id: appUser.id }, data: { lastLoginAt: new Date(), ...(user.name && !appUser.name ? { name: user.name } : {}) } });
        return true;
      } catch (err) {
        log.error("sign-in lookup failed", { error: err instanceof Error ? err.message : String(err) });
        return denied("server_error");
      }
    },
    async jwt({ token, user }) {
      const email = (user?.email ?? token.email)?.toLowerCase();
      // Load on sign-in, then refresh every 5 minutes so deactivation / owner changes take effect quickly.
      const stale = typeof token.refreshedAt !== "number" || Date.now() - token.refreshedAt > 5 * 60_000;
      if (email && (user || stale || !token.userId)) {
        const appUser = await getDb().appUser.findUnique({ where: { email } });
        if (!appUser || !appUser.isActive) return null;
        token.userId = appUser.id;
        token.isOwner = appUser.isOwner;
        token.refreshedAt = Date.now();
      }
      return token;
    },
  },
});
