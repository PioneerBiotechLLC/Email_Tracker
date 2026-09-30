import { redirect } from "next/navigation";
import { pickOrg } from "@email-tracker/core";
import { getSession, getVisibleCompanies, rememberedCompanySlug } from "@/lib/session";

/** Opens the last-used company (cookie), else the first one the user belongs to. */
export default async function RootPage() {
  const session = await getSession();
  const companies = await getVisibleCompanies(session);
  const org = pickOrg(companies, null, await rememberedCompanySlug());
  if (org) redirect(`/c/${org.slug}`);
  if (session.isOwner) redirect("/companies");
  redirect("/no-access");
}
