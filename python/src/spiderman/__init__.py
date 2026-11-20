"""Spiderman HTTP client. Execution and approval remain in the shared server."""
import json
from typing import Callable, Any
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
from urllib.parse import urlparse, quote
from .models import ActionRequest, ActionState
from .api import GeneratedAPI

class SpidermanError(RuntimeError):
    pass

class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SpidermanError("redirect_refused")

class SpidermanClient(GeneratedAPI):
    def __init__(self, base_url: str, token: str | Callable[[], str], timeout: float = 30):
        parsed = urlparse(base_url)
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")):
            raise SpidermanError("https_required")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise SpidermanError("invalid_service_url")
        self.base_url, self.token, self.timeout = base_url.rstrip("/"), token, timeout
        self._opener = build_opener(_NoRedirect())

    def request(self, path: str, method: str = "GET", body: Any = None, *, binary: bool = False):
        if not path.startswith("/v1/") or ".." in path:
            raise SpidermanError("invalid_api_path")
        token = self.token() if callable(self.token) else self.token
        request = Request(self.base_url + path, method=method,
                          data=None if body is None else json.dumps(body).encode(),
                          headers={"Authorization": "Bearer " + token, "Accept": "application/json", "Content-Type": "application/json"})
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                return response.read() if binary else json.load(response)
        except HTTPError as error:
            try:
                code = json.load(error).get("error", "request_failed")
            except (ValueError, AttributeError):
                code = "request_failed"
            raise SpidermanError(str(code)) from None

__all__ = ["SpidermanClient", "SpidermanError", "ActionRequest", "ActionState"]
