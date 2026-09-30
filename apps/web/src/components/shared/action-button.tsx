"use client";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";

/** A one-button form for a server action with a pending state (no confirmation prompt). */
export function ActionButton({ action, children, pendingLabel = "Working…", variant = "default", size = "sm", disabled, title, testId }: {
  action: () => Promise<void>;
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: "outline" | "default" | "destructive" | "ghost" | "secondary";
  size?: "sm" | "default";
  disabled?: boolean;
  title?: string;
  testId?: string;
}) {
  const [pending, start] = useTransition();
  return (
    <form onSubmit={(e) => { e.preventDefault(); start(() => action()); }}>
      <Button type="submit" variant={variant} size={size} disabled={disabled || pending} title={title} data-testid={testId}>{pending ? pendingLabel : children}</Button>
    </form>
  );
}
