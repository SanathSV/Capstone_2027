"""Owns the Playwright browser lifecycle for a single meeting."""

from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from playwright.async_api import BrowserContext, async_playwright

from app.core.config import settings


@asynccontextmanager
async def meet_context() -> AsyncIterator[BrowserContext]:
    """Launch a persistent Chromium context with mic/camera prompts pre-answered."""
    async with async_playwright() as playwright:
        context = await playwright.chromium.launch_persistent_context(
            settings.user_data_dir,
            headless=settings.headless,
            args=[
                "--use-fake-ui-for-media-stream",
                "--disable-blink-features=AutomationControlled",
            ],
        )
        try:
            yield context
        finally:
            await context.close()
