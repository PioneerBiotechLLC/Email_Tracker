import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@email-tracker/core"],
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
