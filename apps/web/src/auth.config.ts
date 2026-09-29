import type { NextAuthConfig } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

/**
 * Edge-safe part of the Auth.js config (no database imports) — used by the
 * middleware. The provider reads AUTH_MICROSOFT_ENTRA_ID_ID / _SECRET / _ISSUER.
 */
export const authConfig = {
  providers: [MicrosoftEntraID],
  session: { strategy: "jwt", maxAge: 12 * 60 * 60 },
  pages: { signIn: "/signin", error: "/no-access" },
  trustHost: true,
  callbacks: {
    authorized({ auth }) {
      return !!auth?.user?.orgId;
    },
    session({ session, token }) {
      session.user.orgId = token.orgId as string;
      session.user.role = token.role as "admin" | "viewer";
      session.user.userId = token.userId as string;
      return session;
    },
  },
} satisfies NextAuthConfig;

declare module "next-auth" {
  interface Session {
    user: { orgId: string; role: "admin" | "viewer"; userId: string; email?: string | null; name?: string | null; image?: string | null };
  }
}
