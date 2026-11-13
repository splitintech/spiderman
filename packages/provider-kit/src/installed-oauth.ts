import {
  selectOAuthScopes,
  ConnectorError,
} from "@splitin/spiderman-contracts";
import { loopbackAuthorize } from "@splitin/spiderman-oauth-loopback";
import type { Http } from "./http.js";
/** BYO installed application, loopback PKCE. Credentials go directly to the owned connection API. */
export async function installedOAuth(
  input: {
    provider: string;
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    onUrl: (url: string) => void;
    timeoutMs?: number;
  },
  http: Http = fetch,
) {
  const microsoft = input.provider === "outlook",
    scopes = selectOAuthScopes(input.provider, input.scopes),
    endpoint = microsoft
      ? "https://login.microsoftonline.com/common/oauth2/v2.0/token"
      : "https://oauth2.googleapis.com/token";
  if (!input.clientId) throw new ConnectorError("oauth_client_id_required");
  return loopbackAuthorize({
    authUrl: microsoft
      ? "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
      : "https://accounts.google.com/o/oauth2/v2/auth",
    params: {
      client_id: input.clientId,
      scope: scopes.join(" "),
      ...(microsoft
        ? {}
        : {
            access_type: "offline",
            prompt: "consent",
            include_granted_scopes: "true",
          }),
    },
    redirectHost: microsoft ? "localhost" : "127.0.0.1",
    redirectPath: microsoft ? "/" : "/callback",
    onUrl: input.onUrl,
    timeoutMs: input.timeoutMs,
    exchange: async ({ code, verifier, redirectUri }) => {
      const response = await http(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: input.clientId,
          ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }),
      });
      if (!response.ok) throw new ConnectorError("oauth_exchange_rejected");
      const grant: any = await response.json();
      if (
        typeof grant.access_token !== "string" ||
        typeof grant.refresh_token !== "string" ||
        !Number.isFinite(Number(grant.expires_in ?? 3600)) ||
        Number(grant.expires_in ?? 3600) <= 0
      )
        throw new ConnectorError("oauth_refresh_grant_required");
      return {
        accessToken: grant.access_token,
        refreshToken: grant.refresh_token,
        expiresAt: Date.now() + Number(grant.expires_in ?? 3600) * 1000,
        clientId: input.clientId,
        ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
        tokenEndpoint: endpoint,
        grantedScopes:
          typeof grant.scope === "string" ? grant.scope.split(" ") : scopes,
      };
    },
  });
}
