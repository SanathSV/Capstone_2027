"""Bot entrypoint: join a meeting, capture, upload."""

import asyncio

from app.core.config import settings
from app.meet.joiner import join_meeting
from app.meet.session import meet_context


async def main() -> None:
    if not settings.meet_url:
        raise SystemExit("MEET_URL is not set — see .env.example")

    async with meet_context() as context:
        await join_meeting(context, settings.meet_url)


if __name__ == "__main__":
    asyncio.run(main())
