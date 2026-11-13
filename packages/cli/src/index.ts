#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { PostgresStore } from "@splitin/spiderman-store-postgres";
import { serveStdio, handleMcp } from "@splitin/spiderman-mcp";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault, masterKey, apiToken } from "@splitin/spiderman-vault";
import { Engine } from "@splitin/spiderman-core";
import {
  GoogleProvider,
  OutlookProvider,
  OzzyProvider,
  IMessageProvider,
  MatrixMessagesProvider,
  WhatsAppBusinessProvider,
  PlivoProvider,
  ImapSmtpProvider,
  RcsBusinessProvider,
  refreshing,
} from "@splitin/spiderman-providers";
import {
  createApp,
  installOAuth,
  delegatedAuthenticator,
} from "@splitin/spiderman-server";
import { SpidermanClient } from "@splitin/spiderman-sdk";
const args = process.argv.slice(2),
  command = args.shift() ?? "help";
const flag = (name: string, fallback?: string) => {
  const index = args.indexOf("--" + name);
  return index < 0 ? fallback : args[index + 1];
};
const output = (data: unknown) =>
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
const stdin = async () => {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    if (raw.length > 10000000) throw new Error("input_too_large");
  }
  return JSON.parse(raw);
};
const token = () => {
  const value =
    process.env.SPIDERMAN_TOKEN ?? apiToken(flag("profile", "default"));
  if (!value || value.length < 32)
    throw new Error("SPIDERMAN_TOKEN_required_minimum_32_characters");
  return value;
};
const client = () =>
  new SpidermanClient(
    flag("url", process.env.SPIDERMAN_URL ?? "http://127.0.0.1:8787")!,
    token,
  );
async function runtime(create = false) {
  const store = process.env.SPIDERMAN_DATABASE_URL
    ? new PostgresStore(process.env.SPIDERMAN_DATABASE_URL)
    : new SqliteStore(
        flag("db", process.env.SPIDERMAN_DB ?? "./spiderman.db")!,
      );
  if (create && store instanceof PostgresStore) await store.migrate();
  const key = process.env.SPIDERMAN_MASTER_KEY
    ? Buffer.from(process.env.SPIDERMAN_MASTER_KEY, "hex")
    : masterKey(flag("profile", "default"), create);
  const vault = new EncryptedVault(store, key),
    engine = new Engine(store, vault);
  engine
    .register(refreshing(new GoogleProvider("gmail")))
    .register(refreshing(new GoogleProvider("google-drive")))
    .register(refreshing(new GoogleProvider("google-sheets")))
    .register(refreshing(new GoogleProvider("google-calendar")))
    .register(refreshing(new OutlookProvider()));
  const origins = (process.env.SPIDERMAN_BRIDGE_ORIGINS ?? "")
    .split(",")
    .filter(Boolean);
  engine
    .register(new OzzyProvider(origins))
    .register(new IMessageProvider(origins))
    .register(new MatrixMessagesProvider(origins))
    .register(
      new PlivoProvider(
        (process.env.SPIDERMAN_ANSWER_ORIGINS ?? "").split(",").filter(Boolean),
      ),
    )
    .register(
      new ImapSmtpProvider(
        (process.env.SPIDERMAN_MAIL_HOSTS ?? "").split(",").filter(Boolean),
      ),
    )
    .register(new RcsBusinessProvider());
  if (process.env.SPIDERMAN_META_VERSION)
    engine.register(
      new WhatsAppBusinessProvider(process.env.SPIDERMAN_META_VERSION),
    );
  return { store, vault, engine };
}
async function main() {
  if (command === "help" || command === "--help") {
    output({
      name: "spiderman",
      version: "0.1.0-alpha.1",
      commands: [
        "init",
        "connect",
        "disconnect",
        "connections",
        "capabilities",
        "actions",
        "approve",
        "policies",
        "events",
        "worker",
        "serve",
        "mcp",
        "doctor",
        "export",
        "delete",
      ],
      qualification: "automated_only",
      note: "Credentials and action JSON are read from stdin; authentication is supplied via protected environment.",
    });
    return;
  }
  if (command === "init") {
    const { store } = await runtime(true);
    if (!process.env.SPIDERMAN_TOKEN)
      apiToken(flag("profile", "default"), true);
    await store.close();
    output({
      initialized: true,
      keyStorage: process.env.SPIDERMAN_MASTER_KEY
        ? "operator_configured"
        : "os_keychain",
      apiToken: "protected_in_keychain_or_environment",
    });
    return;
  }
  if (command === "serve") {
    const { engine } = await runtime();
    const expected = process.env.SPIDERMAN_DELEGATION_SECRET
        ? Buffer.alloc(0)
        : Buffer.from(token()),
      owner = process.env.SPIDERMAN_OWNER;
    if (!process.env.SPIDERMAN_DELEGATION_SECRET && !owner)
      throw new Error("SPIDERMAN_OWNER_required");
    const port = Number(flag("port", "8787"));
    const app = createApp(engine, {
      allowedOrigins: process.env.SPIDERMAN_ALLOWED_ORIGINS?.split(",") ?? [
        "http://127.0.0.1:" + port,
      ],
      authenticate: process.env.SPIDERMAN_DELEGATION_SECRET
        ? delegatedAuthenticator(process.env.SPIDERMAN_DELEGATION_SECRET)
        : async (candidate) => {
            const actual = Buffer.from(candidate);
            return actual.length === expected.length &&
              timingSafeEqual(actual, expected)
              ? owner
              : undefined;
          },
    });
    app.post("/v1/mcp", async (c) =>
      handleMcp(c.req.raw, engine, c.get("owner")),
    );
    if (process.env.SPIDERMAN_OAUTH_ORIGIN)
      installOAuth(app, engine, {
        origin: process.env.SPIDERMAN_OAUTH_ORIGIN,
        google:
          process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
            ? {
                clientId: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
              }
            : undefined,
        microsoft:
          process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET
            ? {
                clientId: process.env.MICROSOFT_CLIENT_ID,
                clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
              }
            : undefined,
      });
    serve({ fetch: app.fetch, hostname: flag("host", "127.0.0.1"), port });
    process.stderr.write("Spiderman listening on loopback " + port + "\n");
    return;
  }
  if (command === "mcp") {
    const { engine } = await runtime();
    const owner = process.env.SPIDERMAN_OWNER;
    if (!owner) throw new Error("SPIDERMAN_OWNER_required");
    await serveStdio(engine, owner);
    return;
  }
  if (command === "worker") {
    const { engine, store } = await runtime();
    if (args.includes("--once")) {
      output((await engine.runOnce()) ?? { idle: true });
      await store.close();
      return;
    }
    let stopping = false;
    process.once("SIGINT", () => {
      stopping = true;
    });
    process.once("SIGTERM", () => {
      stopping = true;
    });
    let lastMaintenance = 0;
    while (!stopping) {
      await engine.runOnce();
      if (Date.now() - lastMaintenance > 60000) {
        await engine.maintenance();
        lastMaintenance = Date.now();
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    await store.close();
    return;
  }
  if (command === "doctor") {
    const { engine, store } = await runtime();
    output({
      runtime: process.version,
      providers: [...engine.providers.keys()],
      publication: "not_verified",
      liveQualification: "pending",
      keyStorage: process.env.SPIDERMAN_MASTER_KEY
        ? "operator_configured"
        : "os_keychain",
    });
    await store.close();
    return;
  }
  const sdk = client(),
    id = args[0];
  switch (command) {
    case "export":
      output(await sdk.request("/v1/export"));
      break;
    case "delete":
      if (!args.includes("--confirm"))
        throw new Error("delete_requires_confirm_flag");
      output(await sdk.request("/v1/data", "DELETE"));
      break;
    case "connections":
      output(await sdk.connections());
      break;
    case "connect": {
      const b = await stdin();
      output(await sdk.connect(b.provider, b.credentials, b.resources));
      break;
    }
    case "disconnect":
      if (!id) throw new Error("connection_id_required");
      output(await sdk.disconnect(id));
      break;
    case "capabilities":
      if (!id) throw new Error("connection_id_required");
      output(await sdk.capabilities(id));
      break;
    case "actions":
      if (id === "retry")
        output(
          await sdk.request(
            "/v1/actions/" + encodeURIComponent(args[1] ?? "") + "/retry",
            "POST",
            {},
          ),
        );
      else if (id === "inspect")
        output(
          await sdk.request(
            "/v1/actions/" + encodeURIComponent(args[1] ?? "") + "/preview",
          ),
        );
      else if (id === "submit") output(await sdk.submit(await stdin()));
      else if (id === "result") output(await sdk.result(args[1]!));
      else output(id ? await sdk.action(id) : await sdk.actions());
      break;
    case "approve":
      if (!id || !flag("digest"))
        throw new Error("action_id_and_digest_required");
      output(await sdk.approve(id, flag("digest")!));
      break;
    case "events":
      output(await sdk.events());
      break;
    case "policies":
      if (id === "create")
        output(await sdk.request("/v1/policies", "POST", await stdin()));
      else if (id === "delete")
        output(
          await sdk.request(
            "/v1/policies/" + encodeURIComponent(args[1] ?? ""),
            "DELETE",
          ),
        );
      else output(await sdk.request("/v1/policies"));
      break;
    default:
      throw new Error("unknown_command");
  }
}
main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      error:
        error instanceof Error && /^[A-Za-z0-9_]+$/.test(error.message)
          ? error.message
          : "command_failed",
    }) + "\n",
  );
  process.exitCode = 1;
});
