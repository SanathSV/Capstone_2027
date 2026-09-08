"""Ships captured artifacts back to the Astra backend."""

import httpx

from app.core.config import settings


async def upload_transcript(meeting_id: str, payload: dict) -> None:
    """POST a transcript chunk to the backend."""
    async with httpx.AsyncClient(base_url=settings.backend_url) as client:
        response = await client.post(
            f"/api/v1/meetings/{meeting_id}/transcript",
            json=payload,
            headers={"X-Bot-Key": settings.bot_api_key},
        )
        response.raise_for_status()
