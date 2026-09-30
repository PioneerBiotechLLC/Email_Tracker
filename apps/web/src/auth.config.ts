import type { NextAuthConfig } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

/**
 * Edge-safe part of the Auth.js config (no database imports) — used by the middleware.
 * Multi-tenant login: the "organizations" issuer accepts work accounts from any
 * Microsoft 365 tenant; Auth.js re-runs OIDC discovery for the token's tenant.
 * Access is still limited to emails with a Membership (or owners) — see auth.ts.
 */
const entra = MicrosoftEntraID({
  ...(process.env.AUTH_MICROSOFT_ENTRA_ID_ID ? { clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID } : {}),
  ...(process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET ? { clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET } : {}),
  issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER || "https://login.microsoftonline.com/organizations/v2.0",
});

export const authConfig = {
  providers: [entra],
  session: { strategy: "jwt", maxAge: 12 * 60 * 60 },
  pages: { signIn: "/signin", error: "/no-access" },
  trustHost: true,
  callbacks: {
    authorized({ auth }) {
      return !!auth?.user?.userId;
    },
    session({ session, token }) {
      session.user.userId = token.userId as string;
      session.user.isOwner = !!token.isOwner;
      return session;
    },
  },
} satisfies NextAuthConfig;

declare module "next-auth" {
  interface Session {
    user: { userId: string; isOwner: boolean; email?: string | null; name?: string | null; image?: string | null };
  }
}
