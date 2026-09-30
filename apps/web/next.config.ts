import type { NextConfig } from "next";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// The monorepo keeps one .env at the repo root (Next only auto-loads apps/web/.env*).
// Load it here so config-time settings such as DEV_ALLOWED_ORIGINS are available.
const rootEnv = path.resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) {
  for (const raw of readFileSync(rootEnv, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value === "") continue; // empty = not configured
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// Hosts other than localhost that may open the DEV server (office PCs on the LAN):
// comma-separated IPs/hostnames in DEV_ALLOWED_ORIGINS, e.g. "192.168.70.96,mohameds-macbook-air.local"
const devOrigins = (process.env.DEV_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// Production guard: the Playwright auth bypass must never reach a production build.
if (process.env.NODE_ENV === "production" && process.env.E2E_BYPASS_EMAIL) {
  throw new Error("E2E_BYPASS_EMAIL is set in a production build. Remove it from the environment.");
}

const isDev = process.env.NODE_ENV !== "production";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self' https://login.microsoftonline.com",
  "base-uri 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  transpilePackages: ["@email-tracker/core"],
  allowedDevOrigins: ["*.local", ...devOrigins],
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg", "@azure/msal-node", "@microsoft/microsoft-graph-client", "@anthropic-ai/sdk"],
  experimental: { serverActions: { bodySizeLimit: "1mb" } },
  // The core package is TypeScript source with ESM-style ".js" import specifiers.
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] };
    return config;
  },
  turbopack: { resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"] },
};

export default nextConfig;
