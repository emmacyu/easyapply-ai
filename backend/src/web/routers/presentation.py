"""Presentation section: GitHub repo -> slide deck -> .pptx, and optionally
Google Slides. `/api/google/status` gates the reference-link read and the export."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

router = APIRouter()


@router.get("/api/google/status")
def google_status() -> dict[str, Any]:
    """Whether Google Slides/Drive is connected (gates the reference-link read
    and the 'Export to Google Slides' action)."""
    from src.integrations import gslides_client

    return gslides_client.status()


@router.post("/api/presentation/generate")
def presentation_generate(body: dict[str, Any]) -> dict[str, Any]:
    """{repo_url, reference_slides_url?, reference_text?, target_slides?} -> deck."""
    from src.ai.presentation import generate_deck

    repo_url = (body.get("repo_url") or "").strip()
    if not repo_url:
        raise HTTPException(status_code=400, detail="repo_url is required")

    reference_text = (body.get("reference_text") or "").strip()
    ref_url = (body.get("reference_slides_url") or "").strip()
    if ref_url and not reference_text:
        from src.integrations import gslides_client

        try:
            reference_text = gslides_client.read_presentation_text(ref_url)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=400,
                detail=f"Couldn't read the reference Google Slides: {str(exc)[:180]}",
            )

    try:
        deck = generate_deck(
            repo_url,
            reference_text=reference_text,
            target_slides=int(body.get("target_slides") or 10),
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)[:250])
    return deck


@router.post("/api/presentation/pptx")
def presentation_pptx(body: dict[str, Any]) -> Response:
    """Body = a deck dict -> downloadable .pptx."""
    from src.render.pptx import deck_to_pptx, safe_filename

    deck = body.get("deck") if "deck" in body else body
    if not isinstance(deck, dict) or not deck.get("slides"):
        raise HTTPException(status_code=400, detail="a deck with slides is required")
    data = deck_to_pptx(deck)
    fname = safe_filename(deck.get("title") or "presentation") + ".pptx"
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.post("/api/presentation/google-slides")
def presentation_google_slides(body: dict[str, Any]) -> dict[str, str]:
    """Body = a deck dict -> creates a Google Slides deck (OAuth-gated)."""
    from src.integrations import gslides_client

    deck = body.get("deck") if "deck" in body else body
    if not isinstance(deck, dict) or not deck.get("slides"):
        raise HTTPException(status_code=400, detail="a deck with slides is required")
    try:
        return gslides_client.create_presentation(deck)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)[:250])
