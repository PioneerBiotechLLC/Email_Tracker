import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Seeds the demo organization (and API Pharma, which the demo users are not members of) before the smoke tests. */
export default function globalSetup() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const core = path.resolve(here, "../../../packages/core");
  execSync("pnpm exec tsx scripts/seed-demo.ts", { cwd: core, stdio: "inherit", env: { ...process.env, NODE_ENV: "test" } });
  execSync("pnpm exec tsx scripts/seed-orgs.ts api-pharma", { cwd: core, stdio: "inherit", env: { ...process.env, NODE_ENV: "test" } });
}
