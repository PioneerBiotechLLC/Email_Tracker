import { ConfidentialClientApplication } from "@azure/msal-node";
import { getEnv } from "../env.js";

const GRAPH_SCOPES = ["https://graph.microsoft.com/.default"];

const apps = new Map<string, ConfidentialClientApplication>();

/**
 * App-only (client credentials) auth per Azure tenant. One app registration
 * (AZURE_CLIENT_ID/SECRET) can serve many tenants once each tenant's admin
 * has consented, so new companies are just new Organization rows.
 * MSAL caches tokens in memory and refreshes them automatically.
 */
export function getMsalApp(tenantId: string): ConfidentialClientApplication {
  let app = apps.get(tenantId);
  if (!app) {
    const env = getEnv();
    app = new ConfidentialClientApplication({
      auth: {
        clientId: env.AZURE_CLIENT_ID,
        clientSecret: env.AZURE_CLIENT_SECRET,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
    });
    apps.set(tenantId, app);
  }
  return app;
}

export async function getGraphAccessToken(tenantId: string): Promise<string> {
  const result = await getMsalApp(tenantId).acquireTokenByClientCredential({ scopes: GRAPH_SCOPES });
  if (!result?.accessToken) throw new Error(`Failed to acquire Graph token for tenant ${tenantId}`);
  return result.accessToken;
}
