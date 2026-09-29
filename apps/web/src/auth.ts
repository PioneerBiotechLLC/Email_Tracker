import NextAuth from "next-auth";
import { getDb } from "@email-tracker/core";
import { authConfig } from "./auth.config";

/**
 * Full Auth.js instance (Node runtime). Only emails present and active in the
 * AppUser table may sign in; their org and role are stored in the JWT.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user }) {
      const email = user.email?.toLowerCase();
      if (!email) return "/no-access";
      const appUser = await getDb().appUser.findUnique({ where: { email } });
      if (!appUser || !appUser.isActive) return "/no-access";
      await getDb().appUser.update({ where: { id: appUser.id }, data: { lastLoginAt: new Date(), ...(user.name && !appUser.name ? { name: user.name } : {}) } });
      return true;
    },
    async jwt({ token, user }) {
      const email = (user?.email ?? token.email)?.toLowerCase();
      // Load on sign-in, then refresh every 5 minutes so role changes/deactivation take effect quickly.
      const stale = typeof token.refreshedAt !== "number" || Date.now() - token.refreshedAt > 5 * 60_000;
      if (email && (user || stale || !token.orgId)) {
        const appUser = await getDb().appUser.findUnique({ where: { email } });
        if (!appUser || !appUser.isActive) return null;
        token.orgId = appUser.orgId;
        token.role = appUser.role;
        token.userId = appUser.id;
        token.refreshedAt = Date.now();
      }
      return token;
    },
  },
});
