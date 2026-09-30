import { defineConfig, env } from "prisma/config";
import { loadDotenv } from "./src/dotenv.js";

loadDotenv();

// Migrations must use a direct connection (Neon: DIRECT_URL); the app uses the pooled DATABASE_URL.
const migrationUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: migrationUrl ?? env("DATABASE_URL") },
});
