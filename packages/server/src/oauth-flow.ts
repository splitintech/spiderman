import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import type { Hono, Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Engine, Transaction } from "@splitin/spiderman-core";
import {
  ConnectorError,
  oauthScopes as scopes,
  selectOAuthScopes,
  oauthInputSchema,
  oauthAuthorizeInputSchema,
  oauthCompleteInputSchema,
  type OAuthCompleteInput,
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
type Variables = { owner: string; actorKind: "human" | "agent" };
type OwnerContext = Context<{ Variables: Variables }>;
interface Pending {
  id: string;
  owner: string;
  provider: string;
  resources: string[];
  scopes: string[];
  connectionId?: string;
  connectionRevision?: number;
  claimToken?: string;
  expiresAt: number;
  secretRef: string;
}
const sha = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const cookieName = (state: string) => "spiderman_oauth_" + state;

async function grantJson(response: Response): Promise<Record<string, any>> {
  const reader = response.body?.getReader();
  if (!reader) throw new ConnectorError("oauth_exchange_invalid");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 1_000_000) {
        await reader.cancel();
        throw new ConnectorError("oauth_exchange_invalid");
      }
      chunks.push(part.value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw Error("invalid");
    return result;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("oauth_exchange_invalid");
  } finally {
    reader.releaseLock();
  }
}

/** Browser and application-proxy routes share exactly one grant/identity path. */
export function installOAuth(
  app: Hono<{ Variables: Variables }>,
  engine: Engine,
  options: OAuthOptions,
) {
  const origin = new URL(options.origin);
  if (
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new Error("oauth_https_origin_required");
  const http = options.http ?? fetch;
  const configuration = (provider: string) =>
    provider === "outlook" ? options.microsoft : options.google;

  async function pending(
    c: OwnerContext,
    state: string,
    expectedOwner?: string,
  ) {
    if (!/^[\w-]{43}$/.test(state))
      return c.json({ error: "oauth_callback_invalid" }, 400);
    const row = await engine.store.transaction((tx) =>
      tx.get<Pending>("oauth", state),
    );
    if (!row || row.expiresAt <= Date.now())
      return c.json({ error: "oauth_state_expired" }, 400);
    if (expectedOwner !== undefined && row.owner !== expectedOwner)
      return c.json({ error: "oauth_owner_mismatch" }, 403);
    if (row.claimToken) return c.json({ error: "oauth_state_consumed" }, 400);
    if (row.connectionId) {
      const connection = await engine.connection(row.owner, row.connectionId);
      if (
        row.connectionRevision === undefined ||
        connection.revision !== row.connectionRevision
      )
        return c.json({ error: "oauth_connection_changed" }, 409);
    }
    const secret = await engine.vault.get<{ verifier: string; nonce: string }>(
        row.owner,
        row.secretRef,
      ),
      actual = Buffer.from(getCookie(c, cookieName(state)) ?? ""),
      expected = Buffer.from(secret.nonce);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return c.json({ error: "oauth_browser_binding_required" }, 400);
    return { row, secret };
  }

  async function authorize(
    c: OwnerContext,
    state: string,
    expectedOwner?: string,
  ) {
    const loaded = await pending(c, state, expectedOwner);
    if (loaded instanceof Response) return loaded;
    const { row, secret } = loaded,
      application = configuration(row.provider),
      microsoft = row.provider === "outlook";
    if (!application) throw new ConnectorError("oauth_not_configured");
    const selected = [...row.scopes];
    if (
      row.provider === "google-drive" &&
      row.resources.includes("*") &&
      selected.includes("https://www.googleapis.com/auth/drive.file")
    )
      selected.splice(
        selected.indexOf("https://www.googleapis.com/auth/drive.file"),
        1,
        "https://www.googleapis.com/auth/drive",
      );
    const url = new URL(
      microsoft
        ? "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
        : "https://accounts.google.com/o/oauth2/v2/auth",
    );
    url.search = new URLSearchParams({
      client_id: application.clientId,
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
    return { authorizationUrl: url.toString(), expiresAt: row.expiresAt };
  }

  async function complete(
    c: OwnerContext,
    input: OAuthCompleteInput,
    expectedOwner?: string,
    browser = false,
  ) {
    const loaded = await pending(c, input.state, expectedOwner);
    if (loaded instanceof Response) return loaded;
    const { row, secret } = loaded,
      application = configuration(row.provider),
      claimToken = randomBytes(32).toString("hex");
    if (!application) throw new ConnectorError("oauth_not_configured");
    const guard = async (tx: Transaction) => {
      const current = await tx.get<Pending>("oauth", row.id);
      if (
        !current ||
        current.owner !== row.owner ||
        current.claimToken !== claimToken ||
        current.expiresAt <= Date.now()
      )
        throw new ConnectorError("oauth_state_consumed");
    };
    await engine.store.transaction(async (tx) => {
      const current = await tx.get<Pending>("oauth", row.id);
      if (!current || current.claimToken || current.expiresAt <= Date.now())
        throw new ConnectorError("oauth_state_consumed");
      current.claimToken = claimToken;
      await tx.put("oauth", row.id, row.owner, current);
    });
    deleteCookie(c, cookieName(row.id), { path: "/oauth" });
    try {
      if (input.error) return c.json({ error: "oauth_provider_denied" }, 400);
      const endpoint =
        row.provider === "outlook"
          ? "https://login.microsoftonline.com/common/oauth2/v2.0/token"
          : "https://oauth2.googleapis.com/token";
      let response: Response;
      try {
        response = await http(endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(20000),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: application.clientId,
            client_secret: application.clientSecret,
            code: input.code!,
            code_verifier: secret.verifier,
            redirect_uri: origin.origin + "/oauth/callback",
            grant_type: "authorization_code",
          }),
        });
      } catch {
        throw new ConnectorError("oauth_exchange_unavailable");
      }
      if (!response.ok)
        return c.json({ error: "oauth_exchange_rejected" }, 400);
      const grant = await grantJson(response);
      if (!grant.refresh_token && row.connectionId) {
        const connection = await engine.connection(row.owner, row.connectionId);
        if (connection.status === "ready") {
          const prior = await engine.vault.get<Record<string, unknown>>(
            row.owner,
            connection.credentialRef,
          );
          if (prior.clientId === application.clientId)
            grant.refresh_token = prior.refreshToken;
        }
      }
      if (
        typeof grant.access_token !== "string" ||
        !grant.access_token ||
        typeof grant.refresh_token !== "string" ||
        !grant.refresh_token ||
        !Number.isFinite(Number(grant.expires_in ?? 3600)) ||
        Number(grant.expires_in ?? 3600) <= 0
      )
        return c.json({ error: "oauth_refresh_grant_required" }, 400);
      const credentials = {
        accessToken: grant.access_token,
        refreshToken: grant.refresh_token,
        expiresAt: Date.now() + Number(grant.expires_in ?? 3600) * 1000,
        clientId: application.clientId,
        clientSecret: application.clientSecret,
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
            row.connectionRevision,
            guard,
          )
        : await engine.connect(
            row.owner,
            row.provider,
            credentials,
            row.resources,
            guard,
          );
      return browser
        ? c.html(
            '<!doctype html><html lang="en"><meta charset="utf-8"><title>Account connected</title><h1>Account connected</h1><p>Return to Spiderman and refresh your connections.</p><p>Connection ' +
              connection.id +
              "</p></html>",
          )
        : c.json({ status: "connected", connectionId: connection.id });
    } finally {
      await engine.store.transaction(async (tx) => {
        const current = await tx.get<Pending>("oauth", row.id);
        if (current?.claimToken === claimToken)
          await tx.remove("oauth", row.id);
      });
      await engine.vault.delete(row.owner, row.secretRef);
    }
  }

  app.get("/v1/auth/providers", (c) =>
    c.json(Object.keys(scopes).filter((provider) => !!configuration(provider))),
  );
  app.post("/v1/oauth/:provider/start", async (c) => {
    if (c.get("actorKind") !== "human")
      return c.json({ error: "human_control_required" }, 403);
    const provider = c.req.param("provider");
    if (!configuration(provider) || !scopes[provider])
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
    const owner = c.get("owner"),
      state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url");
    const row: Pending = {
      id: state,
      owner,
      provider,
      resources: body.resources.length
        ? body.resources
        : (prior?.resources ?? []),
      scopes: selected,
      connectionId: body.connectionId,
      connectionRevision: prior?.revision,
      expiresAt: Date.now() + 600000,
      secretRef: await engine.vault.put(
        owner,
        "oauth:" + state,
        { verifier, nonce },
        Date.now() + 600000,
      ),
    };
    await engine.store.transaction((tx) => tx.put("oauth", state, owner, row));
    setCookie(c, cookieName(state), nonce, {
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
    const result = await authorize(c, c.req.param("state"));
    return result instanceof Response
      ? result
      : c.redirect(result.authorizationUrl);
  });
  app.get("/oauth/callback", async (c) => {
    const query = new URL(c.req.url).searchParams;
    if (new URL(c.req.url).search.length > 16000 || [...query.keys()].some((key) => query.getAll(key).length > 1))
      return c.json({ error: "oauth_callback_invalid" }, 400);
    const input = oauthCompleteInputSchema.safeParse({
      state: c.req.query("state"),
      code: c.req.query("code"),
      error: c.req.query("error"),
    });
    if (!input.success) return c.json({ error: "oauth_callback_invalid" }, 400);
    return complete(c, input.data, undefined, true);
  });
  app.post("/v1/oauth/authorize", async (c) => {
    if (c.get("actorKind") !== "human")
      return c.json({ error: "human_control_required" }, 403);
    const input = oauthAuthorizeInputSchema.parse(await c.req.json()),
      result = await authorize(c, input.state, c.get("owner"));
    return result instanceof Response ? result : c.json(result);
  });
  app.post("/v1/oauth/complete", async (c) => {
    if (c.get("actorKind") !== "human")
      return c.json({ error: "human_control_required" }, 403);
    return complete(
      c,
      oauthCompleteInputSchema.parse(await c.req.json()),
      c.get("owner"),
    );
  });
  app.delete("/v1/oauth/:state", async (c) => {
    if (c.get("actorKind") !== "human")
      return c.json({ error: "human_control_required" }, 403);
    const { state } = oauthAuthorizeInputSchema.parse({
      state: c.req.param("state"),
    });
    const row = await engine.store.transaction(async (tx) => {
      const pending = await tx.get<Pending>("oauth", state);
      if (!pending || pending.owner !== c.get("owner"))
        throw new ConnectorError("not_found");
      await tx.remove("oauth", state);
      return pending;
    });
    await engine.vault.delete(row.owner, row.secretRef);
    deleteCookie(c, cookieName(state), { path: "/oauth" });
    return c.json({ cancelled: true });
  });
}
