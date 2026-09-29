import { defineConfig, env } from "prisma/config";
import { loadDotenv } from "./src/dotenv.js";

loadDotenv();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
