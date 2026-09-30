import { defineConfig } from "prisma/config";
import { loadDotenv } from "./src/dotenv.js";

loadDotenv();

// Migrations must use a direct connection (Neon: DIRECT_URL); the app uses the pooled DATABASE_URL.
// The datasource is optional so `prisma generate` works without any database URL (e.g. on Vercel builds).
// Commands that need a connection (migrate, db push, studio) fail with a clear Prisma error when it's missing.
const migrationUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  ...(migrationUrl ? { datasource: { url: migrationUrl } } : {}),
});
