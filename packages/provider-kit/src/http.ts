import { ConnectorError } from "@splitin/spiderman-contracts";
import { authorizeExternalRequest } from "@splitin/spiderman-core";
export type Http = typeof fetch;
export async function json(
  http: Http,
  url: string,
  method = "GET",
  token?: string,
  body?: unknown,
  signal = AbortSignal.timeout(30000),
  headers: Record<string, string> = {},
): Promise<any> {
  await authorizeExternalRequest();
  let response: Response;
  try {
    response = await http(url, {
      method,
      signal,
      redirect: "error",
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ConnectorError("provider_transport_failed", method !== "GET");
  }
  if (!response.ok) {
    throw new ConnectorError(
      response.status === 401
        ? "provider_auth_expired"
        : response.status === 403
          ? "provider_permission_denied"
          : response.status === 429
            ? "provider_rate_limited"
            : "provider_http_" + response.status,
      method !== "GET" && response.status >= 500,
    );
  }
  if (response.status === 204) return {};
  if (Number(response.headers.get("content-length") ?? 0) > 10_000_000)
    throw new ConnectorError("provider_response_too_large", method !== "GET");
  try {
    const reader = response.body?.getReader();
    if (!reader)
      return response.status === 202
        ? { accepted: true, delivery: "unverified" }
        : {};
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 10_000_000) {
          await reader.cancel();
          throw new ConnectorError(
            "provider_response_too_large",
            method !== "GET",
          );
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    if (!bodyText.trim() && response.status === 202)
      return { accepted: true, delivery: "unverified" };
    const parsed = JSON.parse(bodyText),
      etag = response.headers.get("etag");
    if (
      etag &&
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.etag === undefined
    )
      parsed.etag = etag;
    return parsed;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("provider_response_invalid", method !== "GET");
  }
}
export const required = (
  object: Record<string, unknown>,
  key: string,
): string => {
  const value = object[key];
  if (typeof value !== "string" || !value.length)
    throw new ConnectorError("credential_" + key + "_required");
  return value;
};
export function localEndpoint(
  credentials: Record<string, unknown>,
  allowedOrigins: readonly string[],
): string {
  const url = new URL(required(credentials, "endpoint"));
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new ConnectorError("endpoint_origin_required");
  if (!allowedOrigins.includes(url.origin))
    throw new ConnectorError("endpoint_not_allowlisted");
  if (
    url.protocol !== "https:" &&
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
  )
    throw new ConnectorError("endpoint_tls_required");
  return url.origin;
}
