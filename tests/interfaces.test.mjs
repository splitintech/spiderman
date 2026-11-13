import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Engine } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
import { createApp } from "@splitin/spiderman-server";
import { createMcp, handleMcp } from "@splitin/spiderman-mcp";
const exec = promisify(execFile);
function fixture() {
  const store = new SqliteStore(":memory:");
  const engine = new Engine(
    store,
    new EncryptedVault(store, Buffer.alloc(32, 5)),
  );
  engine.register({
    manifest: {
      provider: "synthetic",
      version: "1",
      qualification: "automated_only",
      operations: [
        {
          name: "send",
          risk: "write",
          scopes: ["send"],
          recipientKeys: ["recipient"],
          input: z.object({ recipient: z.email(), text: z.string() }).strict(),
        },
      ],
    },
    verify: async () => ({ accountId: "alice@example.test", scopes: ["send"] }),
    execute: async () => ({
      providerId: "synthetic-message-id",
      data: { submitted: true },
    }),
  });
  return { store, engine };
}
const request = (c) => ({
  connectionId: c.id,
  operation: "send",
  input: {
    recipient: "bob@example.test",
    text: "Untrusted content cannot approve this action.",
  },
  idempotencyKey: "interface-test-action",
});
test("MCP protocol discovers owned capabilities and cannot approve a proposed send", async () => {
  const { store, engine } = fixture(),
    server = createMcp(engine, "alice"),
    client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    const connection = await engine.connect("alice", "synthetic", {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "propose_action"));
    assert.equal(
      tools.tools.some((tool) => /approv|policy/.test(tool.name)),
      false,
    );
    const result = await client.callTool({
      name: "propose_action",
      arguments: request(connection),
    });
    const action = JSON.parse(result.content[0].text);
    assert.equal(action.state, "awaiting_approval");
    assert.equal(await engine.runOnce(), undefined);
    const other = createMcp(engine, "bob"),
      bob = new Client({ name: "bob", version: "1" }),
      [bt, st] = InMemoryTransport.createLinkedPair();
    try {
      await other.connect(st);
      await bob.connect(bt);
      const listed = await bob.callTool({ name: "connections", arguments: {} });
      assert.deepEqual(JSON.parse(listed.content[0].text), []);
      const denied = await bob.callTool({
        name: "action_status",
        arguments: { actionId: action.id },
      });
      assert.equal(denied.isError, true);
    } finally {
      await bob.close();
      await other.close();
    }
  } finally {
    await client.close();
    await server.close();
    await store.close();
  }
});
test("CLI, Python client and remote MCP use the real HTTP/worker authorization path", async () => {
  const { store, engine } = fixture(),
    token = "synthetic-test-token-at-least-32-characters";
  const app = createApp(engine, {
    authenticate: async (value) => (value === token ? "alice" : undefined),
  });
  app.post("/v1/mcp", (c) => handleMcp(c.req.raw, engine, c.get("owner")));
  const listener = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise((resolve) =>
    listener.listening ? resolve() : listener.once("listening", resolve),
  );
  const url = "http://127.0.0.1:" + listener.address().port;
  const env = {
    ...process.env,
    SPIDERMAN_TOKEN: token,
    SPIDERMAN_URL: url,
    PYTHONPATH: resolve("python/src"),
  };
  const cli = async (...args) =>
    JSON.parse(
      (
        await exec(process.execPath, ["packages/cli/dist/index.js", ...args], {
          env,
        })
      ).stdout,
    );
  const mcp = new Client({ name: "remote-test", version: "1" });
  try {
    const c = await engine.connect("alice", "synthetic", {}),
      a = await engine.submit("alice", request(c));
    assert.equal((await cli("connections"))[0].id, c.id);
    assert.equal((await cli("actions", a.id)).state, "awaiting_approval");
    const script =
      "import os,json; from spiderman import SpidermanClient,SpidermanError; c=SpidermanClient(os.environ['SPIDERMAN_URL'],os.environ['SPIDERMAN_TOKEN']); a=c.request('/v1/actions')[0]; c.approve(a['id'],a['inputDigest']); print(json.dumps(c.action(a['id'])))";
    const py = JSON.parse(
      (await exec("python3", ["-c", script], { env })).stdout,
    );
    assert.equal(py.state, "queued");
    assert.equal((await engine.runOnce()).state, "succeeded");
    assert.deepEqual(await cli("actions", "result", a.id), { submitted: true });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(url + "/v1/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + token } },
      }),
    );
    const status = await mcp.callTool({
      name: "action_status",
      arguments: { actionId: a.id },
    });
    assert.equal(JSON.parse(status.content[0].text).state, "succeeded");
  } finally {
    await mcp.close();
    await new Promise((resolve) => listener.close(resolve));
    await store.close();
  }
});
