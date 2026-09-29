"use client";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useTheme } from "next-themes";
import { formatMinutes } from "@/lib/format";

// Series colors validated with the dataviz palette checker for both surfaces.
const SERIES = { light: { received: "#5B6DD6", replied: "#21A396" }, dark: { received: "#6F7FE0", replied: "#239A8C" } };
const AWAIT = { light: "#B8860B", dark: "#D4A017" };

export interface DayPoint { day: string; received: number; replied: number; medianBusinessMinutes: number | null }
export interface CategoryPoint { category: string; count: number }

const shortDay = (d: string) => d.slice(5).replace("-", "/");
const tooltipStyle = { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--popover-foreground)", fontSize: 12 };

export function ReceivedVsRepliedChart({ data }: { data: DayPoint[] }) {
  const { resolvedTheme } = useTheme();
  const c = SERIES[resolvedTheme === "dark" ? "dark" : "light"];
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} barGap={2} barCategoryGap="30%">
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} minTickGap={16} />
        <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} width={28} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--accent)" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="received" name="Received" fill={c.received} radius={[4, 4, 0, 0]} />
        <Bar dataKey="replied" name="Replied" fill={c.replied} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ResponseTimeChart({ data }: { data: DayPoint[] }) {
  const { resolvedTheme } = useTheme();
  const c = SERIES[resolvedTheme === "dark" ? "dark" : "light"];
  const points = data.map((d) => ({ day: d.day, hours: d.medianBusinessMinutes == null ? null : Math.round((d.medianBusinessMinutes / 60) * 10) / 10 }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={points}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} minTickGap={16} />
        <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} width={34} unit="h" />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => [typeof v === "number" ? formatMinutes(v * 60) : "–", "Median response (business hours)"]} />
        <Line type="monotone" dataKey="hours" name="Median response time" stroke={c.replied} strokeWidth={2} dot={{ r: 3 }} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function AwaitingByCategoryChart({ data }: { data: CategoryPoint[] }) {
  const { resolvedTheme } = useTheme();
  const fill = AWAIT[resolvedTheme === "dark" ? "dark" : "light"];
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, 28 * data.length + 40)}>
      <BarChart data={data} layout="vertical" barCategoryGap="30%">
        <CartesianGrid horizontal={false} stroke="var(--border)" />
        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="category" width={90} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--accent)" }} />
        <Bar dataKey="count" name="Awaiting reply" fill={fill} radius={[0, 4, 4, 0]} label={{ position: "right", fontSize: 11, fill: "var(--foreground)" }} />
      </BarChart>
    </ResponsiveContainer>
  );
}
