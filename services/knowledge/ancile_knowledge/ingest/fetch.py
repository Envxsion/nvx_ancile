"""
------------------------------------------------------------------
 Title    |  Fetching URL sources safely
 Ref      |  DESIGN.md §7.1 (resilience), §5.8 (security)
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Download a web page for a URL source without letting the
          |  URL reach the local network (SSRF): no loopback, private,
          |  link-local, multicast or reserved addresses, http(s) only,
          |  and every redirect hop is checked again.
 How      |  guard_url() resolves the host once, rejects any unsafe
          |  address, and pins the request to the vetted IP (Host and
          |  TLS SNI keep the real name), so DNS cannot rebind between
          |  the check and the connect. Redirects are followed by hand
          |  (at most 5), each through the guard. The call goes through
          |  resilience.retry with a breaker per host. Conditional
          |  headers (ETag, Last-Modified) make re-checks cheap.
 Note     |  Adapted from Open Notebook's URL validation (MIT, Luis
          |  Novo). Stricter here:
          |  private ranges are blocked too, unless
          |  KNOWLEDGE_ALLOW_PRIVATE_URLS=true.
------------------------------------------------------------------
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin, urlparse, urlunparse

import httpx

from ..errors import AncileError
from ..obs import get_logger, outbound_headers
from ..resilience import CircuitBreaker, RetryableError, RetryPolicy, classify_status, retry

log = get_logger("fetch")

MAX_REDIRECTS = 5
USER_AGENT = "NVX-Ancile/1.0 (+https://nvx.sh; knowledge fetcher)"
_AWS_IMDS_V6 = ipaddress.ip_address("fd00:ec2::254")

IP = ipaddress.IPv4Address | ipaddress.IPv6Address

# Injectable for tests: hostname -> list of IP strings.
Resolver = Callable[[str], list[str]]


def _system_resolve(host: str) -> list[str]:
    infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(i[4][0]).split("%")[0] for i in infos))


resolve_host: Resolver = _system_resolve
# Tests swap in httpx.MockTransport; None means a real network transport.
transport: httpx.AsyncBaseTransport | None = None


def blocked_reason(ip: IP, *, allow_private: bool) -> str | None:
    """Why this address may not be fetched, or None when it is safe."""
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    if ip.is_unspecified:
        return "an unspecified address"
    if ip.is_loopback:
        return "a loopback address"
    if ip.is_link_local or (isinstance(ip, ipaddress.IPv6Address) and int(ip) == int(_AWS_IMDS_V6)):
        return "a link-local or cloud metadata address"
    if ip.is_multicast:
        return "a multicast address"
    if ip.is_reserved:
        return "a reserved address"
    if not allow_private and (ip.is_private or not ip.is_global):
        return "a private network address"
    return None


def unsafe_url(message: str) -> AncileError:
    return AncileError(
        "extract.url_blocked",
        "This URL points somewhere Ancile will not fetch from",
        f"{message} Use a public http or https link, or paste the text instead.",
        status=422,
        error_class="policy",
    )


@dataclass(frozen=True)
class Target:
    url: str  # pinned to the vetted IP
    host_header: str
    sni: str | None
    original: str


def guard_url(url: str, *, allow_private: bool = False, resolver: Resolver | None = None) -> Target:
    """Validate a URL and pin it to a safe IP. Raises extract.url_blocked."""
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https"):
        raise unsafe_url(
            f"Only http and https links can be added (this one is {parsed.scheme or 'missing'})."
        )
    host = parsed.hostname
    if not host:
        raise unsafe_url("The link has no host name.")
    try:
        literal: IP | None = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        reason = blocked_reason(literal, allow_private=allow_private)
        if reason:
            raise unsafe_url(f"The address is {reason}.")
        ips = [str(literal)]
    else:
        try:
            ips = (resolver or resolve_host)(host)
        except (socket.gaierror, UnicodeError) as exc:
            raise AncileError(
                "extract.fetch_failed",
                "The web address could not be found",
                f"Check the link: {host} did not resolve.",
                status=422,
                error_class="permanent",
            ) from exc
        if not ips:
            raise unsafe_url("The host did not resolve to any address.")
        for raw in ips:
            reason = blocked_reason(ipaddress.ip_address(raw), allow_private=allow_private)
            if reason:
                raise unsafe_url(f"{host} resolves to {reason}.")
    pinned_ip = next((i for i in ips if ":" not in i), ips[0])
    host_for_url = f"[{pinned_ip}]" if ":" in pinned_ip else pinned_ip
    ascii_host = host.encode("idna").decode("ascii") if literal is None else host
    netloc = f"{host_for_url}:{parsed.port}" if parsed.port else host_for_url
    host_header = f"{ascii_host}:{parsed.port}" if parsed.port else ascii_host
    pinned = urlunparse((parsed.scheme, netloc, parsed.path or "/", parsed.params, parsed.query, ""))
    sni = ascii_host if parsed.scheme == "https" and literal is None else None
    return Target(pinned, host_header, sni, url.strip())


@dataclass
class FetchResult:
    url: str  # final URL after redirects (original host names)
    status: int
    body: bytes
    content_type: str | None
    etag: str | None
    last_modified: str | None
    headers: dict[str, str] = field(default_factory=dict)


_breakers: dict[str, CircuitBreaker] = {}


def _breaker(host: str) -> CircuitBreaker:
    b = _breakers.get(host)
    if b is None:
        b = _breakers[host] = CircuitBreaker(target=f"web:{host}")
    return b


def fetch_failed(url: str, detail: str, *, retryable: bool = False) -> AncileError:
    return AncileError(
        "extract.fetch_failed",
        "The page could not be fetched",
        "Check the link opens in a browser, or paste the text instead.",
        status=502,
        retryable=retryable,
        error_class="transient" if retryable else "permanent",
        detail=f"{url}: {detail}",
    )


async def fetch_url(
    url: str,
    *,
    allow_private: bool = False,
    max_bytes: int = 50 * 1024 * 1024,
    etag: str | None = None,
    last_modified: str | None = None,
    method: str = "GET",
    timeout_s: float = 30,
    policy: RetryPolicy | None = None,
) -> FetchResult:
    """
    GET (or HEAD) a public URL. 304 is returned as a result, not an error.
    4xx is a permanent extract.fetch_failed; 5xx and network errors retry.
    """
    conditional: dict[str, str] = {}
    if etag:
        conditional["if-none-match"] = etag
    if last_modified:
        conditional["if-modified-since"] = last_modified

    async with httpx.AsyncClient(
        transport=transport, timeout=timeout_s, follow_redirects=False, trust_env=False
    ) as client:
        current = url
        for _hop in range(MAX_REDIRECTS + 1):
            target = guard_url(current, allow_private=allow_private)
            host = urlparse(current).hostname or "?"
            breaker = _breaker(host)
            hop_url = current

            async def once(t: Target = target, b: CircuitBreaker = breaker, u: str = hop_url) -> FetchResult:
                if not b.allow():
                    raise RetryableError(f"circuit open for {u}", "capacity")
                headers = {
                    "host": t.host_header,
                    "user-agent": USER_AGENT,
                    "accept": "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
                    **conditional,
                    **outbound_headers(),
                }
                ext: dict[str, Any] = {"sni_hostname": t.sni} if t.sni else {}
                try:
                    req = client.build_request(method, t.url, headers=headers, extensions=ext)
                    resp = await client.send(req, stream=True)
                except httpx.TransportError as exc:
                    b.record(False)
                    raise RetryableError(f"{type(exc).__name__}") from exc
                try:
                    if resp.status_code >= 500 or resp.status_code == 429:
                        b.record(False)
                        ra = resp.headers.get("retry-after")
                        raise RetryableError(
                            f"HTTP {resp.status_code}",
                            classify_status(resp.status_code),
                            float(ra) if ra and ra.isdigit() else None,
                        )
                    b.record(True)
                    chunks: list[bytes] = []
                    size = 0
                    if method != "HEAD" and resp.status_code < 300:
                        async for part in resp.aiter_bytes():
                            size += len(part)
                            if size > max_bytes:
                                raise AncileError(
                                    "source.too_large",
                                    "The page is larger than the limit",
                                    "Save it as a file and upload it, or raise KNOWLEDGE_MAX_FETCH_MB.",
                                    status=413,
                                    error_class="permanent",
                                )
                            chunks.append(part)
                    return FetchResult(
                        url=u,
                        status=resp.status_code,
                        body=b"".join(chunks),
                        content_type=resp.headers.get("content-type"),
                        etag=resp.headers.get("etag"),
                        last_modified=resp.headers.get("last-modified"),
                        headers=dict(resp.headers),
                    )
                finally:
                    await resp.aclose()

            try:
                result = await retry(once, target=f"web:{host}", policy=policy)
            except AncileError as exc:
                if exc.code == "dependency.unavailable":
                    raise fetch_failed(current, "the server did not answer", retryable=True) from exc
                raise
            if result.status in (301, 302, 303, 307, 308):
                location = result.headers.get("location")
                if not location:
                    raise fetch_failed(current, f"HTTP {result.status} without a location")
                current = urljoin(current, location)
                continue
            if result.status == 304:
                return result
            if result.status >= 400:
                raise fetch_failed(current, f"HTTP {result.status}")
            log.info("fetched", host=host, status=result.status, bytes=len(result.body))
            return result
    raise fetch_failed(url, f"more than {MAX_REDIRECTS} redirects")
