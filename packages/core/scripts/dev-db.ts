/**
 * Local Postgres for development without Docker: starts Prisma's built-in dev
 * server (`prisma dev`, data persists between runs under the name below) and
 * writes its connection string into the repo-root .env as DATABASE_URL.
 * Keep this terminal open; Ctrl+C stops the database.
 *   pnpm db:local
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const envPath = resolve(root, ".env");
const NAME = "emailtracker";

function saveUrl(url: string) {
  if (!existsSync(envPath)) copyFileSync(resolve(root, ".env.example"), envPath);
  const text = readFileSync(envPath, "utf8");
  const line = `DATABASE_URL="${url}"`;
  const next = /^DATABASE_URL=.*$/m.test(text) ? text.replace(/^DATABASE_URL=.*$/m, line) : `${line}\n${text}`;
  if (next !== text) writeFileSync(envPath, next);
}

const child = spawn("pnpm", ["exec", "prisma", "dev", "--name", NAME], {
  cwd: here,
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://placeholder:placeholder@localhost:5432/placeholder" },
  stdio: ["inherit", "pipe", "inherit"],
});

let saved = false;
child.stdout.on("data", (chunk: Buffer) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (saved) return;
  const m = /DATABASE_URL="(postgres[^"]+)"/.exec(text.replace(/\x1b\[[0-9;]*m/g, ""));
  if (m) {
    saved = true;
    saveUrl(m[1]!);
    console.log(`\n✔ Saved DATABASE_URL to ${envPath}. Keep this terminal open; in another terminal run:\n   pnpm db:deploy && pnpm db:seed-demo && pnpm dev\n`);
  }
});
child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
