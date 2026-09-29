/**
 * Test-only auth bypass for Playwright. Active ONLY when NODE_ENV=test and
 * E2E_BYPASS_EMAIL names an active AppUser. `next build` / `next start` run with
 * NODE_ENV=production, so this can never switch on in a deployed app.
 * (Destructured on purpose: the bundler inlines `process.env.NODE_ENV` as a
 * literal, but leaves destructuring to the real runtime environment.)
 */
const { NODE_ENV, E2E_BYPASS_EMAIL } = process.env;

export const e2eBypassEmail: string | null = NODE_ENV === "test" && E2E_BYPASS_EMAIL ? E2E_BYPASS_EMAIL.toLowerCase() : null;
