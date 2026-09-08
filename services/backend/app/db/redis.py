"""Redis (Upstash) client factory."""

from redis.asyncio import Redis, from_url

from app.core.config import settings

_client: Redis | None = None


def get_redis() -> Redis:
    """Return the shared Redis client, creating it on first use."""
    global _client
    if _client is None:
        _client = from_url(settings.redis_url, decode_responses=True)
    return _client
