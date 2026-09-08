"""Joins a Google Meet call. Selectors live here and nowhere else."""

from playwright.async_api import BrowserContext, Page

from app.core.config import settings


async def join_meeting(context: BrowserContext, meet_url: str) -> Page:
    """Open the meeting and request to join. Returns the in-call page.

    Scaffold: the selector flow (mute, name entry, "Ask to join") is intentionally
    unimplemented until the capture pipeline is specified.
    """
    page = await context.new_page()
    await page.goto(meet_url, timeout=settings.join_timeout_seconds * 1000)
    raise NotImplementedError("Join flow not implemented yet")
