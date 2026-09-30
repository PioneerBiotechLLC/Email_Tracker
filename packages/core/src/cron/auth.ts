import { timingSafeEqual } from "node:crypto";

/** `Authorization: Bearer <CRON_SECRET>` check for the cron endpoints (constant-time). */
export function isAuthorizedCron(authorizationHeader: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || secret.length < 16) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authorizationHeader ?? "");
  if (!m) return false;
  const given = Buffer.from(m[1]!.trim());
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
