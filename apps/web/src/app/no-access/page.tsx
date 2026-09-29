import Link from "next/link";
import { signOut } from "@/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "No access" };

export default function NoAccessPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>No access</CardTitle>
          <CardDescription>Your Microsoft account signed in, but it is not on this dashboard&apos;s user list. Ask an administrator to add you, then try again.</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button asChild variant="outline"><Link href="/signin">Try another account</Link></Button>
          <form action={async () => { "use server"; await signOut({ redirectTo: "/signin" }); }}><Button type="submit" variant="ghost">Sign out</Button></form>
        </CardContent>
      </Card>
    </main>
  );
}
