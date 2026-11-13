import { authorizeExternalRequest } from "@splitin/spiderman-core";
import { ConnectorError } from "@splitin/spiderman-contracts";
import type { Http } from "./http.js";
/** Fixed, adapter-constructed URLs only. Never accepts an untrusted artifact URL. */
export async function binary(
  http: Http,
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit;
    signal: AbortSignal;
    maxBytes?: number;
  },
) {
  await authorizeExternalRequest();
  const method = options.method ?? "GET",
    max = options.maxBytes ?? 6_000_000;
  let response: Response;
  try {
    response = await http(url, {
      method,
      headers: options.headers,
      body: options.body,
      signal: options.signal,
      redirect: "error",
    });
  } catch {
    throw new ConnectorError("provider_transport_failed", method !== "GET");
  }
  if (!response.ok)
    throw new ConnectorError(
      "provider_http_" + response.status,
      method !== "GET" && response.status >= 500,
    );
  const reader = response.body?.getReader();
  if (!reader) throw new ConnectorError("artifact_empty", method !== "GET");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new ConnectorError("artifact_too_large", method !== "GET");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new ConnectorError("artifact_empty", method !== "GET");
  return {
    bytes: Buffer.concat(chunks),
    contentType: (
      response.headers.get("content-type") ?? "application/octet-stream"
    )
      .split(";")[0]!
      .toLowerCase(),
  };
}
