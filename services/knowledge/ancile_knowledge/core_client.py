"""
------------------------------------------------------------------
 Title    |  Core client: every model call goes through the Gateway
 Ref      |  DESIGN.md §1.2 (D5), §4.2
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Knowledge never talks to a model provider directly (the
          |  local fastembed embedder aside). Chat and cloud embeddings
          |  go to Core's internal OpenAI-compatible endpoint, so
          |  fallbacks, budgets and the "why" view cover them too.
 How      |  httpx with the service token and propagated traceparent.
          |  Retries via resilience.retry; a breaker per Core.
------------------------------------------------------------------
"""

from __future__ import annotations

from typing import Any

import httpx

from .obs import outbound_headers
from .resilience import CircuitBreaker, RetryableError, classify_status, retry


class CoreClient:
    def __init__(self, base_url: str, token: str, timeout_s: float = 60) -> None:
        self._base = base_url.rstrip("/")
        self._token = token
        self._http = httpx.AsyncClient(timeout=timeout_s)
        self.breaker = CircuitBreaker(target="core")

    async def close(self) -> None:
        await self._http.aclose()

    async def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        if not self.breaker.allow():
            raise RetryableError("core circuit open", "capacity")

        async def call() -> dict[str, Any]:
            headers = {"authorization": f"Bearer {self._token}", **outbound_headers()}
            try:
                r = await self._http.post(f"{self._base}{path}", json=body, headers=headers)
            except httpx.TransportError as exc:
                self.breaker.record(False)
                raise RetryableError(str(exc)) from exc
            if r.status_code >= 400:
                cls = classify_status(r.status_code)
                self.breaker.record(cls not in ("transient", "capacity"))
                retry_after = r.headers.get("retry-after")
                raise RetryableError(
                    f"core returned {r.status_code}", cls, float(retry_after) if retry_after else None
                )
            self.breaker.record(True)
            data: dict[str, Any] = r.json()
            return data

        return await retry(call, target="core")

    async def chat(self, messages: list[dict[str, Any]], *, task_class: str = "utility", **extra: Any) -> str:
        """Model is a task class; Core's router resolves it to a fallback chain."""
        body = {"model": f"task:{task_class}", "messages": messages, **extra}
        data = await self._post("/openai/chat/completions", body)
        return str(data["choices"][0]["message"]["content"])

    async def embeddings(self, model: str, texts: list[str]) -> list[list[float]]:
        data = await self._post("/openai/embeddings", {"model": model, "input": texts})
        return [list(map(float, d["embedding"])) for d in data["data"]]
