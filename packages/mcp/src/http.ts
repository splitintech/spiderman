import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createQualifiedMcp, type McpOptions } from "./index.js";
import type { Engine } from "@splitin/spiderman-core";
/** Call only after the HTTP host has authenticated and bound the owner. */
export async function handleMcp(
  request: Request,
  engine: Engine,
  owner: string,
  options: McpOptions = {},
): Promise<Response> {
  const server = await createQualifiedMcp(engine, owner, options),
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
