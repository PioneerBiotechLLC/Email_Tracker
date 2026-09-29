"use client";
import { Button } from "@/components/ui/button";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const forbidden = error.message.includes("permission") || error.message.includes("Not found in your organization");
  return (
    <div className="mx-auto max-w-lg rounded-lg border p-6">
      <h1 className="text-lg font-bold">{forbidden ? "Not allowed" : "Something went wrong"}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{forbidden ? error.message : "The page could not be loaded. Try again, and if it keeps failing check the server logs."}</p>
      {error.digest && <p className="mt-1 text-xs text-muted-foreground">Reference: {error.digest}</p>}
      <Button className="mt-4" onClick={reset}>Try again</Button>
    </div>
  );
}
