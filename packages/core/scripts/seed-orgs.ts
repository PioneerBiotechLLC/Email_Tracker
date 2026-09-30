/**
 * Idempotent company records for the known companies (no mailboxes, no users).
 *   pnpm org:seed                 both
 *   pnpm org:seed-pioneer         Pioneer Biotech only
 *   pnpm org:seed-api-pharma      API Pharma only
 * Tenant IDs are recorded by "Connect Microsoft 365" (admin consent) in the dashboard,
 * or pass --tenant <id> to set one here.
 */
import { getDb, disconnectDb } from "../src/index.js";

interface CompanySeed {
  slug: string; name: string; domain: string; domains: string[]; timezone: string; workDays: number[]; workStart: string; workEnd: string;
  replySlaHours: number; summaryLanguage: string; primaryColor: string; secondaryColor: string; headingFont: string; bodyFont: string; aiContext: string;
}

const COMPANIES: Record<string, CompanySeed> = {
  pioneer: {
    slug: "pioneer-biotech", name: "Pioneer Biotech", domain: "pbio.tech", domains: [], timezone: "Asia/Dubai", workDays: [0, 1, 2, 3, 4], workStart: "09:00", workEnd: "18:00",
    replySlaHours: 24, summaryLanguage: "en", primaryColor: "#C2922F", secondaryColor: "#0B1F3A", headingFont: "merriweather", bodyFont: "source-sans",
    aiContext: "Life sciences distribution: pharma & biopharma, medical devices, scientific/analytical instruments, bioprocessing equipment, lab equipment, APIs and raw materials. Offices in Masdar City (Abu Dhabi) and New Cairo (Egypt).",
  },
  "api-pharma": {
    slug: "api-pharma", name: "API Pharma", domain: "api-pharma.net", domains: [], timezone: "Asia/Dubai", workDays: [0, 1, 2, 3, 4], workStart: "09:00", workEnd: "18:00",
    replySlaHours: 24, summaryLanguage: "en", primaryColor: "#BE272C", secondaryColor: "#BE6B27", headingFont: "merriweather", bodyFont: "source-sans",
    aiContext: "Pharmaceutical trading: APIs & excipients distribution (MOH-approved storage in UAE), branches in UAE, KSA, Egypt, Algeria.",
  },
};

const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith("--"));
const tenantIdx = args.indexOf("--tenant");
const tenant = tenantIdx >= 0 ? args[tenantIdx + 1] : undefined;
const targets = only ? [COMPANIES[only]] : Object.values(COMPANIES);
if (targets.some((t) => !t)) throw new Error(`Unknown company "${only}". Known: ${Object.keys(COMPANIES).join(", ")}`);

const db = getDb();
try {
  for (const c of targets as CompanySeed[]) {
    const existing = await db.organization.findFirst({ where: { OR: [{ slug: c.slug }, { domain: c.domain }] } });
    const data = { ...c, ...(tenant ? { azureTenantId: tenant, consentGrantedAt: new Date() } : {}) };
    const org = existing
      ? await db.organization.update({ where: { id: existing.id }, data: { ...data, slug: existing.slug } })
      : await db.organization.create({ data });
    console.log(`${existing ? "Updated" : "Created"} ${org.name} (/c/${org.slug}, ${org.domain}) tenant=${org.azureTenantId ?? "not connected yet"}`);
  }
} finally {
  await disconnectDb();
}
