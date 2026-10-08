"""
------------------------------------------------------------------
 Title    |  /kn/v1: the internal API Core calls
 Ref      |  DESIGN.md §4.2
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Sources, search, evidence, duplicates. Internal network
          |  only, and every call must carry the service token
          |  (Authorization: Bearer $ANCILE_SERVICE_TOKEN).
 How      |  Sources, notebook links, duplicates and maintenance live
          |  in sources/routes.py and are mounted here, so the token
          |  check covers them. Search is here.
 Note     |  TODO(phase-5): /tags/recompute and /transformations/run
          |  answer 501 in the standard error shape until then.
------------------------------------------------------------------
"""

from __future__ import annotations

import hmac
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, Field

from .errors import AncileError
from .search import evidence as evidence_service
from .search import service as search_service
from .settings import get_settings
from .sources.routes import router as sources_router


def require_service_token(authorization: Annotated[str | None, Header()] = None) -> None:
    expected = get_settings().service_token
    if not expected:
        raise AncileError(
            "auth.service_token_unset",
            "The knowledge service has no service token configured",
            "Set ANCILE_SERVICE_TOKEN in .env for both Core and Knowledge.",
            status=503,
        )
    presented = (authorization or "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(presented.encode(), expected.encode()):
        raise AncileError(
            "auth.service_token_invalid",
            "The request did not carry a valid service token",
            "Only Core may call /kn/v1. Check ANCILE_SERVICE_TOKEN matches on both services.",
            status=401,
            error_class="permanent",
        )


router = APIRouter(prefix="/kn/v1", dependencies=[Depends(require_service_token)])


def _todo(phase: int, what: str) -> AncileError:
    return AncileError(
        "knowledge.not_implemented",
        f"{what} is not available yet",
        f"Planned for phase {phase} (ROADMAP.md).",
        status=501,
        error_class="permanent",
    )


class SearchRequest(BaseModel):
    workspace_id: str = Field(min_length=1, max_length=200)
    query: str = Field(min_length=1, max_length=4000)
    notebook_id: str | None = None
    source_ids: list[str] | None = Field(default=None, max_length=200)
    k: int = Field(default=12, ge=1, le=100)
    mode: Literal["hybrid", "vector", "text"] = "hybrid"
    rerank: bool = True


class EvidenceRequest(BaseModel):
    workspace_id: str = Field(min_length=1, max_length=200)
    claims: list[Annotated[str, Field(min_length=1, max_length=4000)]] = Field(min_length=1, max_length=50)
    notebook_id: str | None = None
    k_per_claim: int = Field(default=4, ge=1, le=20)


router.include_router(sources_router)


@router.post("/search")
def search(body: SearchRequest) -> dict[str, Any]:
    if not body.query.strip():
        raise AncileError(
            "request.invalid",
            "The search query is empty",
            "Type something to search for.",
            status=422,
            error_class="permanent",
        )
    return search_service.search(
        search_service.Query(
            workspace_id=body.workspace_id,
            query=body.query.strip(),
            notebook_id=body.notebook_id,
            source_ids=body.source_ids,
            k=body.k,
            mode=body.mode,
            rerank=body.rerank,
        )
    )


@router.post("/evidence")
def evidence(body: EvidenceRequest) -> dict[str, Any]:
    claims = [c.strip() for c in body.claims]
    if not all(claims):
        raise AncileError(
            "request.invalid",
            "A claim to find evidence for is empty",
            "Send each claim as non-empty text.",
            status=422,
            error_class="permanent",
        )
    return evidence_service.evidence(
        evidence_service.EvidenceQuery(
            workspace_id=body.workspace_id,
            claims=claims,
            notebook_id=body.notebook_id,
            k_per_claim=body.k_per_claim,
        )
    )


@router.post("/tags/recompute")
async def recompute_tags() -> None:
    # TODO(phase-5): recompute tags for a workspace (tags are set at ingestion today).
    raise _todo(5, "Recomputing tags")


@router.post("/transformations/run")
async def run_transformation() -> None:
    # TODO(phase-5): model-written insights through Core's Gateway.
    raise _todo(5, "Transformations")
