import Link from "next/link";
import { signOut } from "@/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "No access" };

const REASONS: Record<string, string> = {
  not_listed: "This account is not on the dashboard's user list. Ask an administrator to add exactly the address below, then try again.",
  inactive: "This account has been deactivated. Ask an administrator to re-activate it.",
  no_company: "This account is not a member of any company yet. Ask an administrator to add you to a company.",
  no_email: "Microsoft did not send an email address or sign-in name for this account.",
  server_error: "The dashboard could not check your access (database or configuration problem). Try again in a minute; if it persists, check /api/health and the Vercel function logs.",
};

/** Also Auth.js's error page (pages.error): `?error=Configuration|AccessDenied|Verification|…`. */
export default async function NoAccessPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
  const reason = one("reason");
  const error = one("error");
  const account = one("account");
  const message = reason
    ? REASONS[reason] ?? REASONS.not_listed
    : error
      ? `Sign-in failed (${error}). ${error === "Configuration" ? "A sign-in setting is missing or wrong on the server (AUTH_* variables or the database)." : "Try again, or use another account."}`
      : "Your Microsoft account signed in, but it is not on this dashboard's user list. Ask an administrator to add you, then try again.";
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>No access</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {account && (
            <p className="text-sm">
              Signed in as <span className="font-mono">{account}</span>
            </p>
          )}
          {(reason || error) && <p className="text-xs text-muted-foreground">Code: {reason ?? error}</p>}
          <div className="flex gap-2">
            <Button asChild variant="outline"><Link href="/signin">Try another account</Link></Button>
            <form action={async () => { "use server"; await signOut({ redirectTo: "/signin" }); }}><Button type="submit" variant="ghost">Sign out</Button></form>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
