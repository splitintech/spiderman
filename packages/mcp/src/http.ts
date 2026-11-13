import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcp } from "./index.js";
import type { Engine } from "@splitin/spiderman-core";
/** Call only after the HTTP host has authenticated and bound the owner. */
export async function handleMcp(
  request: Request,
  engine: Engine,
  owner: string,
): Promise<Response> {
  const server = createMcp(engine, owner),
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
