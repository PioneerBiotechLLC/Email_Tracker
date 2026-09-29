import { signIn } from "@/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  const { callbackUrl } = await searchParams;
  const target = callbackUrl && callbackUrl.startsWith("/") ? callbackUrl : "/";
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Email Tracker</CardTitle>
          <CardDescription>Sign in with your Microsoft 365 work account. Only users added by an administrator can access the dashboard.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={async () => { "use server"; await signIn("microsoft-entra-id", { redirectTo: target }); }}>
            <Button type="submit" className="w-full">Sign in with Microsoft</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
