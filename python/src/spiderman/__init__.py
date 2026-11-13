"""Spiderman HTTP client. Execution and approval remain in the shared server."""
import json
from typing import Callable, Any
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
from urllib.parse import urlparse, quote
from .models import ActionRequest, ActionState

class SpidermanError(RuntimeError):
    pass

class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SpidermanError("redirect_refused")

class SpidermanClient:
    def __init__(self, base_url: str, token: str | Callable[[], str], timeout: float = 30):
        parsed = urlparse(base_url)
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")):
            raise SpidermanError("https_required")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise SpidermanError("invalid_service_url")
        self.base_url, self.token, self.timeout = base_url.rstrip("/"), token, timeout
        self._opener = build_opener(_NoRedirect())

    def request(self, path: str, method: str = "GET", body: Any = None):
        if not path.startswith("/v1/") or ".." in path:
            raise SpidermanError("invalid_api_path")
        token = self.token() if callable(self.token) else self.token
        request = Request(self.base_url + path, method=method,
                          data=None if body is None else json.dumps(body).encode(),
                          headers={"Authorization": "Bearer " + token, "Accept": "application/json", "Content-Type": "application/json"})
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                return json.load(response)
        except HTTPError as error:
            try:
                code = json.load(error).get("error", "request_failed")
            except (ValueError, AttributeError):
                code = "request_failed"
            raise SpidermanError(str(code)) from None

    def connections(self):
        return self.request("/v1/connections")

    def connect(self, provider: str, credentials: dict, resources: list[str] | None = None):
        return self.request("/v1/connections", "POST", {"provider": provider, "credentials": credentials, "resources": resources or []})

    def disconnect(self, connection_id: str):
        return self.request("/v1/connections/" + quote(connection_id, safe=""), "DELETE")

    def capabilities(self, connection_id: str):
        return self.request("/v1/connections/" + quote(connection_id, safe="") + "/capabilities")

    def submit(self, action: ActionRequest):
        return self.request("/v1/actions", "POST", action)

    def action(self, action_id: str):
        return self.request("/v1/actions/" + quote(action_id, safe=""))

    def result(self, action_id: str):
        return self.request("/v1/actions/" + quote(action_id, safe="") + "/result")

    def approve(self, action_id: str, digest: str):
        return self.request("/v1/actions/" + quote(action_id, safe="") + "/approve", "POST", {"digest": digest})

    def actions(self):
        return self.request("/v1/actions")

    def preview(self, action_id: str):
        return self.request("/v1/actions/" + quote(action_id, safe="") + "/preview")

    def cancel(self, action_id: str):
        return self.request("/v1/actions/" + quote(action_id, safe="") + "/cancel", "POST", {})

    def policies(self):
        return self.request("/v1/policies")

    def export(self):
        return self.request("/v1/export")

    def delete_data(self):
        return self.request("/v1/data", "DELETE")

    def oauth(self, provider: str, resources: list[str] | None = None):
        return self.request("/v1/oauth/" + quote(provider, safe="") + "/start", "POST", {"resources": resources or []})

    def events(self):
        return self.request("/v1/events")

__all__ = ["SpidermanClient", "SpidermanError", "ActionRequest", "ActionState"]
