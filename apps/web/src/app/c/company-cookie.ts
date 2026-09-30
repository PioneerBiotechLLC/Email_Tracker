"use server";
import { cookies } from "next/headers";
import { COMPANY_COOKIE } from "@/lib/session";

/** Remembers the last company opened (used by the company switcher). */
export async function rememberCompany(slug: string): Promise<void> {
  (await cookies()).set(COMPANY_COOKIE, slug, { path: "/", maxAge: 365 * 86_400, sameSite: "lax", httpOnly: true, secure: process.env.NODE_ENV === "production" });
}
