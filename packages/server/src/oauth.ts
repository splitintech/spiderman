import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Engine } from "@splitin/spiderman-core";
import {
  ConnectorError,
  oauthScopes as scopes,
  selectOAuthScopes,
  oauthInputSchema,
} from "@splitin/spiderman-contracts";
export interface OAuthApplication {
  clientId: string;
  clientSecret: string;
}
export interface OAuthOptions {
  origin: string;
  google?: OAuthApplication;
  microsoft?: OAuthApplication;
  http?: typeof fetch;
}
interface Pending {
  id: string;
  owner: string;
  provider: string;
  resources: string[];
  scopes: string[];
  connectionId?: string;
  expiresAt: number;
  secretRef: string;
}
const sha = (s: string) => createHash("sha256").update(s).digest("base64url");
export function installOAuth(
  app: Hono<{ Variables: { owner: string; actorKind: "human" | "agent" } }>,
  engine: Engine,
  options: OAuthOptions,
) {
  const origin = new URL(options.origin);
  if (
    origin.protocol !== "https:" &&
    !["127.0.0.1", "localhost"].includes(origin.hostname)
  )
    throw new Error("oauth_https_required");
  const http = options.http ?? fetch;
  app.get("/v1/auth/providers", (c) =>
    c.json([
      ...Object.keys(scopes).filter((provider) =>
        provider === "outlook" ? !!options.microsoft : !!options.google,
      ),
    ]),
  );
  app.post("/v1/oauth/:provider/start", async (c) => {
    const provider = c.req.param("provider"),
      configuration =
        provider === "outlook" ? options.microsoft : options.google;
    if (!configuration || !scopes[provider])
      return c.json({ error: "oauth_provider_not_configured" }, 409);
    const body = oauthInputSchema.parse(await c.req.json()),
      prior = body.connectionId
        ? await engine.connection(c.get("owner"), body.connectionId)
        : undefined;
    if (prior && prior.provider !== provider)
      throw new ConnectorError("oauth_provider_mismatch");
    let selected: string[];
    try {
      selected = selectOAuthScopes(provider, body.scopes);
    } catch {
      throw new ConnectorError("oauth_scope_denied");
    }
    const resources = body.resources.length
      ? body.resources
      : (prior?.resources ?? []);
    const owner = c.get("owner"),
      state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url");
    const secretRef = await engine.vault.put(
      owner,
      "oauth:" + state,
      { verifier, nonce },
      Date.now() + 600000,
    );
    const row: Pending = {
      id: state,
      owner,
      provider,
      resources,
      scopes: selected,
      connectionId: body.connectionId,
      expiresAt: Date.now() + 600000,
      secretRef,
    };
    await engine.store.transaction((tx) => tx.put("oauth", state, owner, row));
    setCookie(c, "spiderman_oauth_" + state, nonce, {
      httpOnly: true,
      secure: origin.protocol === "https:",
      sameSite: "Lax",
      path: "/oauth",
      maxAge: 600,
    });
    return c.json({
      authorizationUrl: origin.origin + "/oauth/authorize/" + state,
      expiresAt: row.expiresAt,
    });
  });
  app.get("/oauth/authorize/:state", async (c) => {
    const state = c.req.param("state"),
      row = await engine.store.transaction((tx) =>
        tx.get<Pending>("oauth", state),
      );
    if (!row || row.expiresAt <= Date.now())
      return c.json({ error: "oauth_state_expired" }, 400);
    const secret = await engine.vault.get<{ verifier: string; nonce: string }>(
        row.owner,
        row.secretRef,
      ),
      microsoft = row.provider === "outlook",
      configuration = microsoft ? options.microsoft : options.google;
    if (!configuration) throw new ConnectorError("oauth_not_configured");
    const actual = Buffer.from(getCookie(c, "spiderman_oauth_" + state) ?? ""),
      expected = Buffer.from(secret.nonce);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return c.json({ error: "oauth_browser_binding_required" }, 400);
    const selected = [...row.scopes];
    if (
      row.provider === "google-drive" &&
      row.resources.includes("*") &&
      selected.includes("https://www.googleapis.com/auth/drive.file")
    ) {
      selected.splice(
        selected.indexOf("https://www.googleapis.com/auth/drive.file"),
        1,
        "https://www.googleapis.com/auth/drive",
      );
    }
    const url = new URL(
      microsoft
        ? "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
        : "https://accounts.google.com/o/oauth2/v2/auth",
    );
    url.search = new URLSearchParams({
      client_id: configuration.clientId,
      response_type: "code",
      redirect_uri: origin.origin + "/oauth/callback",
      scope: selected.join(" "),
      state,
      code_challenge: sha(secret.verifier),
      code_challenge_method: "S256",
      ...(microsoft
        ? {}
        : {
            access_type: "offline",
            prompt: "consent",
            include_granted_scopes: "true",
          }),
    }).toString();
    return c.redirect(url.toString());
  });
  app.get("/oauth/callback", async (c) => {
    const state = c.req.query("state") ?? "",
      code = c.req.query("code");
    if (!/^[\w-]{43}$/.test(state) || !code)
      return c.json({ error: "oauth_callback_invalid" }, 400);
    const row = await engine.store.transaction((tx) =>
      tx.get<Pending>("oauth", state),
    );
    if (!row || row.expiresAt <= Date.now())
      return c.json({ error: "oauth_state_expired" }, 400);
    const secret = await engine.vault.get<{ verifier: string; nonce: string }>(
        row.owner,
        row.secretRef,
      ),
      cookie = getCookie(c, "spiderman_oauth_" + state) ?? "";
    const expected = Buffer.from(secret.nonce),
      actual = Buffer.from(cookie);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return c.json({ error: "oauth_browser_binding_required" }, 400);
    await engine.store.transaction(async (tx) => {
      if (!(await tx.get("oauth", state)))
        throw new ConnectorError("oauth_state_consumed");
      await tx.remove("oauth", state);
    });
    deleteCookie(c, "spiderman_oauth_" + state, { path: "/oauth" });
    const microsoft = row.provider === "outlook",
      configuration = (microsoft ? options.microsoft : options.google)!;
    const endpoint = microsoft
      ? "https://login.microsoftonline.com/common/oauth2/v2.0/token"
      : "https://oauth2.googleapis.com/token";
    const response = await http(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        code,
        code_verifier: secret.verifier,
        redirect_uri: origin.origin + "/oauth/callback",
        grant_type: "authorization_code",
      }),
    });
    if (!response.ok) return c.json({ error: "oauth_exchange_rejected" }, 400);
    const grant: any = await response.json();
    const priorCredentials = row.connectionId
      ? await engine.vault.get<Record<string, unknown>>(
          row.owner,
          (await engine.connection(row.owner, row.connectionId)).credentialRef,
        )
      : undefined;
    if (
      !grant.refresh_token &&
      priorCredentials?.clientId === configuration.clientId
    )
      grant.refresh_token = priorCredentials.refreshToken;
    if (
      typeof grant.access_token !== "string" ||
      typeof grant.refresh_token !== "string" ||
      !Number.isFinite(Number(grant.expires_in ?? 3600)) ||
      Number(grant.expires_in ?? 3600) <= 0
    )
      return c.json({ error: "oauth_refresh_grant_required" }, 400);
    const credentials = {
      accessToken: grant.access_token,
      refreshToken: grant.refresh_token,
      expiresAt: Date.now() + Number(grant.expires_in ?? 3600) * 1000,
      clientId: configuration.clientId,
      clientSecret: configuration.clientSecret,
      tokenEndpoint: endpoint,
      grantedScopes:
        typeof grant.scope === "string" ? grant.scope.split(" ") : row.scopes,
    };
    const connection = row.connectionId
      ? await engine.reconnect(
          row.owner,
          row.connectionId,
          credentials,
          row.resources,
        )
      : await engine.connect(
          row.owner,
          row.provider,
          credentials,
          row.resources,
        );
    await engine.vault.delete(row.owner, row.secretRef);
    return c.html(
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Account connected</title><h1>Account connected</h1><p>Return to Spiderman and refresh your connections.</p><p>Connection ' +
        connection.id +
        "</p></html>",
    );
  });
}
