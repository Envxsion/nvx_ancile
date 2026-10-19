"""
------------------------------------------------------------------
 Title    |  Reading a file for one message
 Ref      |  ROADMAP.md CH6
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Core attaches a PDF to a message: this reads its text,
          |  page by page, and returns it. Nothing is stored, indexed
          |  or added to a notebook.
 How      |  POST /kn/v1/attachments/extract (multipart `file`) uses
          |  the same pdfium reader as sources (ingest/extract.py),
          |  so a PDF reads the same attached as added. A PDF with no
          |  text layer is refused in words that fit an attachment:
          |  the way to read a scanned file is to add it as a source
          |  with OCR on, not to attach it.
 Note     |  Text, code and CSV are read in Core; only PDFs come here.
------------------------------------------------------------------
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, UploadFile

from .errors import AncileError
from .ingest.extract import extract_pdf

router = APIRouter()

MAX_BYTES = 25 * 1024 * 1024


@router.post("/attachments/extract")
def extract_attachment(file: Annotated[UploadFile, File()]) -> dict[str, object]:
    data = file.file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise AncileError(
            "attachment.too_large",
            "That file is too large to attach",
            "Attach a smaller file, or add it to a notebook as a source.",
            status=413,
            error_class="permanent",
        )
    if not data:
        raise AncileError(
            "attachment.empty",
            "That file is empty",
            "Choose the file again.",
            status=422,
            error_class="permanent",
        )
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "attachment.pdf"
        path.write_bytes(data)
        try:
            doc = extract_pdf(path)
        except AncileError as exc:
            if exc.code == "extract.scanned_pdf":
                raise AncileError(
                    "attachment.scanned_pdf",
                    "This PDF has no text to read",
                    "It looks scanned. Add it to a notebook as a source with OCR on, "
                    "or attach a copy that has a text layer.",
                    status=422,
                    error_class="permanent",
                    detail=exc.detail,
                ) from exc
            raise
    return {
        "markdown": doc.markdown,
        "pages": len(doc.pages),
        "title": doc.title,
    }
