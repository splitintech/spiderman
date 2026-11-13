import { ConnectorError } from "@splitin/spiderman-contracts";
import type { Provider, ProviderContext } from "@splitin/spiderman-core";
import { required, type Http } from "./http.js";
/** Compose refresh with a provider. One active action per connection prevents rotating-token races. */
export function refreshing(provider: Provider, http: Http = fetch): Provider {
  return {
    ...provider,
    manifest: provider.manifest,
    verify: (credentials) => provider.verify(credentials),
    execute: async (operation, input, context) => {
      const c = context.credentials;
      if (
        typeof c.expiresAt === "number" &&
        c.expiresAt <= Date.now() + 30000
      ) {
        const endpoint = required(c, "tokenEndpoint");
        if (
          ![
            "https://oauth2.googleapis.com/token",
            "https://login.microsoftonline.com/common/oauth2/v2.0/token",
          ].includes(endpoint)
        )
          throw new ConnectorError("token_endpoint_denied");
        if (!context.updateCredentials)
          throw new ConnectorError("credential_rotation_unavailable");
        let response;
        try {
          response = await http(endpoint, {
            method: "POST",
            signal: context.signal,
            redirect: "error",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: required(c, "clientId"),
              client_secret: required(c, "clientSecret"),
              refresh_token: required(c, "refreshToken"),
            }),
          });
        } catch {
          throw new ConnectorError("token_refresh_unavailable");
        }
        if (!response.ok) throw new ConnectorError("token_refresh_rejected");
        const token: any = await response.json();
        if (!token.access_token)
          throw new ConnectorError("token_refresh_invalid");
        const next = {
          ...c,
          accessToken: token.access_token,
          refreshToken: token.refresh_token ?? c.refreshToken,
          expiresAt: Date.now() + Number(token.expires_in ?? 3600) * 1000,
        };
        const identity = await provider.verify(next);
        if (identity.accountId !== context.connection.accountId)
          throw new ConnectorError("refreshed_account_mismatch");
        const operationSpec = provider.manifest.operations.find(
          (op) => op.name === operation,
        );
        if (
          !operationSpec ||
          !operationSpec.scopes.every((scope) =>
            identity.scopes.includes(scope),
          )
        )
          throw new ConnectorError("refreshed_scope_missing");
        await context.updateCredentials(next);
        context = { ...context, credentials: next };
      }
      await context.beforeDispatch?.();
      return provider.execute(operation, input, context);
    },
  };
}
