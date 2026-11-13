import type {
  ActionRequest,
  ActionReceipt,
  Connection,
} from "@splitin/spiderman-contracts";
export class SpidermanClient {
  constructor(
    readonly baseUrl: string,
    readonly token: () => string,
    readonly http: typeof fetch = fetch,
  ) {
    const u = new URL(baseUrl);
    if (
      u.protocol !== "https:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
    )
      throw new Error("https_required");
    if (u.username || u.password || u.search || u.hash)
      throw new Error("invalid_service_url");
  }
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    if (!path.startsWith("/v1/") || path.includes(".."))
      throw new Error("invalid_api_path");
    const response = await this.http(new URL(path, this.baseUrl), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: "Bearer " + this.token(),
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error((data as { error?: string }).error ?? "request_failed");
    return data as T;
  }
  connections() {
    return this.request<Connection[]>("/v1/connections");
  }
  connect(
    provider: string,
    credentials: Record<string, unknown>,
    resources: string[] = [],
  ) {
    return this.request<Connection>("/v1/connections", "POST", {
      provider,
      credentials,
      resources,
    });
  }
  disconnect(id: string) {
    return this.request("/v1/connections/" + encodeURIComponent(id), "DELETE");
  }
  capabilities(id: string) {
    return this.request(
      "/v1/connections/" + encodeURIComponent(id) + "/capabilities",
    );
  }
  submit(action: ActionRequest) {
    return this.request<ActionReceipt>("/v1/actions", "POST", action);
  }
  actions() {
    return this.request<ActionReceipt[]>("/v1/actions");
  }
  action(id: string) {
    return this.request<ActionReceipt>("/v1/actions/" + encodeURIComponent(id));
  }
  result(id: string) {
    return this.request("/v1/actions/" + encodeURIComponent(id) + "/result");
  }
  approve(id: string, digest: string) {
    return this.request<ActionReceipt>(
      "/v1/actions/" + encodeURIComponent(id) + "/approve",
      "POST",
      { digest },
    );
  }
  preview(id: string) {
    return this.request("/v1/actions/" + encodeURIComponent(id) + "/preview");
  }
  cancel(id: string) {
    return this.request(
      "/v1/actions/" + encodeURIComponent(id) + "/cancel",
      "POST",
      {},
    );
  }
  policies() {
    return this.request("/v1/policies");
  }
  export() {
    return this.request("/v1/export");
  }
  deleteData() {
    return this.request("/v1/data", "DELETE");
  }
  oauth(provider: string, resources: string[] = []) {
    return this.request<{ authorizationUrl: string; expiresAt: number }>(
      "/v1/oauth/" + encodeURIComponent(provider) + "/start",
      "POST",
      { resources },
    );
  }
  events() {
    return this.request("/v1/events");
  }
}
