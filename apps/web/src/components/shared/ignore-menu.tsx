"use client";
import { useTransition } from "react";
import { EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** Admin quick actions on an email: create an "ignore" rule for its sender or its sender's whole domain. */
export function IgnoreMenu({ address, domain, ignoreSender, ignoreDomain }: { address: string; domain: string; ignoreSender: () => Promise<void>; ignoreDomain: () => Promise<void> }) {
  const [pending, start] = useTransition();
  const run = (what: string, action: () => Promise<void>) => {
    if (window.confirm(`Ignore all email from ${what}? It is hidden from the tracker, threads and statistics and never sent to the AI. Nothing changes in Outlook, and you can undo this.`)) start(() => action());
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" disabled={pending} aria-label={`Ignore options for ${address}`}><EyeOff className="size-3.5" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Exclude from tracking</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => run(address, ignoreSender)}>Ignore this sender ({address})</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run(`@${domain} and its subdomains`, ignoreDomain)}>Ignore this domain ({domain})</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
