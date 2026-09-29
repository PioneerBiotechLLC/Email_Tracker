"use client";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";

/** A one-button form for a server action, with a confirmation prompt. */
export function ConfirmForm({ action, confirmText, children, variant = "outline", size = "sm", disabled }: { action: () => Promise<void>; confirmText: string; children: React.ReactNode; variant?: "outline" | "default" | "destructive" | "ghost" | "secondary"; size?: "sm" | "default"; disabled?: boolean }) {
  const [pending, start] = useTransition();
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (window.confirm(confirmText)) start(() => action()); }}>
      <Button type="submit" variant={variant} size={size} disabled={disabled || pending}>{pending ? "Working…" : children}</Button>
    </form>
  );
}
