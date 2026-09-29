import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke tests against the demo seed. The web server runs with NODE_ENV=test and
 * E2E_BYPASS_EMAIL so the Microsoft login is bypassed (test-only code path).
 * Requires DATABASE_URL (a database where `pnpm db:seed-demo` has been run;
 * globalSetup runs the seed).
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/signin`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { NODE_ENV: "test", E2E_BYPASS_EMAIL: "demo-admin@demo-pharma.example", AUTH_SECRET: process.env.AUTH_SECRET ?? "e2e-test-secret-not-for-production", AUTH_TRUST_HOST: "true" },
  },
});
