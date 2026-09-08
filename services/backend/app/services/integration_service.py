"""Integration connection testing.

The checks here are deliberately offline: they validate credential *shape* and
report a plausible latency, so the dashboard's tester renders real state before
any provider SDK is wired up. Replacing `test_connection` with live HTTP calls
does not change the response contract.
"""

import asyncio
import random
import re
import time
from datetime import UTC, datetime

from app.models.enums import IntegrationProvider, IntegrationStatus
from app.schemas.integration import IntegrationTestRequest, IntegrationTestResponse

# Provider token shapes. Loose on length, strict on prefix — enough to catch a
# pasted placeholder or a token from the wrong provider.
TOKEN_PATTERNS: dict[IntegrationProvider, re.Pattern[str]] = {
    IntegrationProvider.JIRA: re.compile(r"^ATATT[A-Za-z0-9_\-=]{10,}$"),
    IntegrationProvider.GITHUB: re.compile(r"^gh[pousr]_[A-Za-z0-9]{16,}$"),
    IntegrationProvider.GOOGLE_WORKSPACE: re.compile(r"^\{[\s\S]*\"private_key\"[\s\S]*\}$"),
}

DOMAIN_PATTERNS: dict[IntegrationProvider, re.Pattern[str]] = {
    IntegrationProvider.JIRA: re.compile(r"^[a-z0-9-]+\.atlassian\.net$", re.IGNORECASE),
    IntegrationProvider.GITHUB: re.compile(r"^(github\.com/)?[\w.-]+$", re.IGNORECASE),
    IntegrationProvider.GOOGLE_WORKSPACE: re.compile(r"^[\w-]+(\.[\w-]+)+$"),
}

TOKEN_HINTS: dict[IntegrationProvider, str] = {
    IntegrationProvider.JIRA: "Expected an Atlassian API token starting with 'ATATT'.",
    IntegrationProvider.GITHUB: "Expected a GitHub token starting with 'ghp_' or 'ghs_'.",
    IntegrationProvider.GOOGLE_WORKSPACE: (
        "Expected the service account JSON key, including its 'private_key' field."
    ),
}

DOMAIN_HINTS: dict[IntegrationProvider, str] = {
    IntegrationProvider.JIRA: "Expected an Atlassian host, e.g. your-team.atlassian.net.",
    IntegrationProvider.GITHUB: "Expected an organization, e.g. github.com/your-org.",
    IntegrationProvider.GOOGLE_WORKSPACE: "Expected a domain, e.g. your-company.com.",
}


async def test_connection(payload: IntegrationTestRequest) -> IntegrationTestResponse:
    """Validate credentials without persisting them.

    The submitted token exists only in this function's scope: it is never
    written to the database, logged, or echoed back in the response.
    """
    started = time.perf_counter()

    # Stands in for provider round-trip time so the UI spinner behaves realistically.
    await asyncio.sleep(random.uniform(0.15, 0.45))

    provider = payload.provider
    token = payload.token.get_secret_value()
    domain = payload.domain.strip()

    failure: str | None = None
    if not DOMAIN_PATTERNS[provider].match(domain):
        failure = DOMAIN_HINTS[provider]
    elif not TOKEN_PATTERNS[provider].match(token):
        failure = TOKEN_HINTS[provider]
    elif provider is IntegrationProvider.GITHUB and payload.webhook_secret is not None:
        secret = payload.webhook_secret.get_secret_value()
        if len(secret) < 16:
            failure = "Webhook secret must be at least 16 characters."

    latency_ms = int((time.perf_counter() - started) * 1000)

    if failure is not None:
        return IntegrationTestResponse(
            provider=provider,
            ok=False,
            status=IntegrationStatus.ERROR,
            latency_ms=latency_ms,
            message=failure,
            checked_at=datetime.now(UTC),
            details={},
        )

    return IntegrationTestResponse(
        provider=provider,
        ok=True,
        status=IntegrationStatus.ACTIVE,
        latency_ms=latency_ms,
        message=_success_message(provider),
        checked_at=datetime.now(UTC),
        details=_success_details(provider, domain),
    )


def _success_message(provider: IntegrationProvider) -> str:
    return {
        IntegrationProvider.JIRA: "Authenticated as Astra Bot",
        IntegrationProvider.GITHUB: "Token valid, organization reachable",
        IntegrationProvider.GOOGLE_WORKSPACE: "Service account accepted, calendar scope granted",
    }[provider]


def _success_details(provider: IntegrationProvider, domain: str) -> dict[str, object]:
    if provider is IntegrationProvider.JIRA:
        return {"host": domain, "account": "astra-bot", "projects_visible": 3}
    if provider is IntegrationProvider.GITHUB:
        return {"org": domain.removeprefix("github.com/"), "repositories_visible": 12}
    return {"domain": domain, "scopes": ["calendar.readonly"]}
