import type { Principal } from "./auth.js";
export { delegatedAuthenticator, type Principal } from "./auth.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  connectionInputSchema,
  ConnectorError,
} from "@splitin/spiderman-contracts";
import type { Engine } from "@splitin/spiderman-core";
export { installOAuth, type OAuthOptions } from "./oauth.js";
export type Authenticate = (
  token: string,
) => Promise<string | Principal | undefined>;
export interface ServerOptions {
  authenticate: Authenticate;
  allowedOrigins?: string[];
}
export function createApp(engine: Engine, options: ServerOptions) {
  const app = new Hono<{
    Variables: { owner: string; actorKind: "human" | "agent" };
  }>();
  app.use("*", bodyLimit({ maxSize: 10_000_000 }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const origin = c.req.header("Origin");
    if (origin && !(options.allowedOrigins ?? []).includes(origin))
      return c.json({ error: "origin_denied" }, 403);
    await next();
  });
  app.get("/health", (c) =>
    c.json({
      status: "ready",
      schemaVersion: "1",
      qualification: "automated_only",
    }),
  );
  app.get("/", (c) => c.html(consoleHtml));
  app.get("/console.js", (c) =>
    c.body(consoleJs, 200, { "Content-Type": "application/javascript" }),
  );
  app.get("/console.css", (c) =>
    c.body(consoleCss, 200, { "Content-Type": "text/css" }),
  );
  app.use("/v1/*", async (c, next) => {
    const auth = c.req.header("Authorization") ?? "";
    if (!auth.startsWith("Bearer "))
      return c.json({ error: "authentication_required" }, 401);
    const owner = await options.authenticate(auth.slice(7));
    if (!owner) return c.json({ error: "authentication_required" }, 401);
    c.set("owner", typeof owner === "string" ? owner : owner.owner);
    c.set("actorKind", typeof owner === "string" ? "human" : owner.kind);
    await next();
  });
  app.use("/v1/*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const control =
      c.req.method !== "GET" &&
      (path === "/v1/connections" ||
        path.startsWith("/v1/oauth/") ||
        path.startsWith("/v1/policies") ||
        path.endsWith("/approve") ||
        c.req.method === "DELETE");
    if (control && c.get("actorKind") !== "human")
      return c.json({ error: "human_control_required" }, 403);
    await next();
  });
  app.get("/v1/connections", async (c) =>
    c.json(await engine.connections(c.get("owner"))),
  );
  app.post("/v1/connections", async (c) => {
    const body = connectionInputSchema.parse(await c.req.json());
    return c.json(
      await engine.connect(
        c.get("owner"),
        body.provider,
        body.credentials,
        body.resources,
      ),
      201,
    );
  });
  app.delete("/v1/connections/:id", async (c) => {
    await engine.disconnect(c.get("owner"), c.req.param("id"));
    return c.json({ disconnected: true });
  });
  app.get("/v1/connections/:id/capabilities", async (c) =>
    c.json(await engine.capabilities(c.get("owner"), c.req.param("id"))),
  );
  app.get("/v1/actions", async (c) =>
    c.json(await engine.actions(c.get("owner"))),
  );
  app.post("/v1/actions", async (c) =>
    c.json(await engine.submit(c.get("owner"), await c.req.json()), 202),
  );
  app.get("/v1/actions/:id", async (c) =>
    c.json(await engine.action(c.get("owner"), c.req.param("id"))),
  );
  app.get("/v1/actions/:id/result", async (c) =>
    c.json(await engine.result(c.get("owner"), c.req.param("id"))),
  );
  app.get("/v1/actions/:id/preview", async (c) =>
    c.json(await engine.preview(c.get("owner"), c.req.param("id"))),
  );
  app.post("/v1/actions/:id/approve", async (c) => {
    const body = await c.req.json();
    if (typeof body.digest !== "string")
      return c.json({ error: "digest_required" }, 400);
    return c.json(
      await engine.approve(c.get("owner"), c.req.param("id"), body.digest),
    );
  });
  app.post("/v1/actions/:id/cancel", async (c) =>
    c.json(await engine.cancel(c.get("owner"), c.req.param("id"))),
  );
  app.post("/v1/policies", async (c) =>
    c.json(await engine.policy(c.get("owner"), await c.req.json()), 201),
  );
  app.delete("/v1/policies/:id", async (c) => {
    await engine.removePolicy(c.get("owner"), c.req.param("id"));
    return c.json({ deleted: true });
  });
  app.get("/v1/policies", async (c) =>
    c.json(await engine.policies(c.get("owner"))),
  );
  app.get("/v1/export", async (c) =>
    c.json(await engine.export(c.get("owner"))),
  );
  app.delete("/v1/data", async (c) =>
    c.json(await engine.deleteData(c.get("owner"))),
  );
  app.post("/v1/actions/:id/retry", async (c) =>
    c.json(await engine.retry(c.get("owner"), c.req.param("id"))),
  );
  app.get("/v1/events/:id/content", async (c) =>
    c.json(await engine.eventContent(c.get("owner"), c.req.param("id"))),
  );
  app.get("/v1/events", async (c) =>
    c.json(await engine.events(c.get("owner"))),
  );
  app.onError((error, c) => {
    if (error instanceof ConnectorError)
      return c.json(
        { error: error.code },
        error.code === "not_found" ? 404 : 409,
      );
    if (error.name === "ZodError" || error instanceof SyntaxError)
      return c.json({ error: "validation_failed" }, 400);
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
const consoleHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spiderman connections</title><link rel="stylesheet" href="/console.css"></head><body><main><p class="eyebrow">SPIDERMAN / DEVELOPER CONSOLE</p><h1>Your accounts.<br>Your agent. Your control.</h1><p>Inspect personal connections and approve exact actions. Credentials stay out of URLs and browser storage.</p><form id="auth"><label>Personal API token<input id="token" type="password" autocomplete="off" required></label><button>Connect console</button></form><p id="status" role="status"></p><section aria-labelledby="connections-title"><h2 id="connections-title">Connections</h2><ul id="connections"></ul></section><section aria-labelledby="actions-title"><h2 id="actions-title">Actions</h2><ul id="actions"></ul><button id="refresh" hidden>Refresh</button></section></main><script src="/console.js" defer></script></body></html>`;
const consoleCss = `:root{font-family:system-ui,sans-serif;background:#f6f3ed;color:#202326}body{margin:0}main{max-width:880px;margin:auto;padding:clamp(20px,5vw,64px)}.eyebrow{font-size:12px;letter-spacing:.12em;color:#58615e}h1{font-size:clamp(32px,6vw,60px);line-height:1.08;font-weight:550;letter-spacing:-.045em}p{max-width:620px;line-height:1.6}form{display:flex;gap:12px;align-items:end;flex-wrap:wrap}label{display:grid;gap:8px;flex:1}input,button{font:inherit;border-radius:8px;padding:12px;border:1px solid #b8c2b8;min-height:44px;box-sizing:border-box}button{background:#174c3b;color:white;cursor:pointer}input{width:100%;min-width:160px}pre{white-space:pre-wrap;overflow-wrap:anywhere}section{margin-top:40px;border-top:1px solid #cbd0c8}ul{padding:0;list-style:none}li{padding:16px 0;border-bottom:1px solid #d8dbd4;overflow-wrap:anywhere}li button{margin-top:10px;display:block}button:focus-visible,input:focus-visible{outline:3px solid #c47825;outline-offset:3px}`;
const consoleJs = `let token='';const byId=id=>document.getElementById(id);async function api(path,method='GET',body){const response=await fetch('/v1/'+path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const data=await response.json();if(!response.ok)throw Error(data.error);return data;}async function refresh(){try{const connections=await api('connections'),actions=await api('actions');byId('connections').replaceChildren(...connections.map(c=>{const li=document.createElement('li');li.textContent=c.provider+' · '+c.accountId+' · '+c.status;return li;}));byId('actions').replaceChildren(...await Promise.all(actions.map(async a=>{const li=document.createElement('li');li.dataset.actionId=a.id;li.textContent=a.operation+' · '+a.state+' · '+a.inputDigest;if(a.state==='awaiting_approval'){const preview=await api('actions/'+a.id+'/preview');const pre=document.createElement('pre');pre.textContent=JSON.stringify(preview.input,null,2);li.append(pre);const button=document.createElement('button');button.textContent='Approve exact action';button.onclick=async()=>{try{await api('actions/'+a.id+'/approve','POST',{digest:a.inputDigest});await refresh();}catch(e){byId('status').textContent=e.message;}};li.append(button);}return li;})));byId('status').textContent='Connected. Personal records only.';byId('refresh').hidden=false;}catch(e){byId('status').textContent=e.message;}}byId('auth').onsubmit=event=>{event.preventDefault();token=byId('token').value;byId('token').value='';refresh();};byId('refresh').onclick=refresh;`;
