import Link from "next/link";
export default function NotFound() {
  return <div className="mx-auto max-w-lg rounded-lg border p-6"><h1 className="text-lg font-bold">Not found</h1><p className="mt-2 text-sm text-muted-foreground">This thread does not exist or belongs to another organization.</p><Link className="mt-4 inline-block text-sm underline" href="/threads">Back to threads</Link></div>;
}
