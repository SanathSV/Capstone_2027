"""OpenAPI metadata — everything that shapes how /docs reads."""

API_TITLE = "Astra API"
API_VERSION = "0.1.0"

API_DESCRIPTION = """
Backend for **Astra**, an AI meeting assistant for Google Meet.

The dashboard, the Chrome extension and the Playwright bot all talk to this service.

### Tenancy

Every table is protected by PostgreSQL row-level security keyed on `team_id`.
Each request opens a transaction with `SET LOCAL app.current_team_id`, so a query
that forgets its `WHERE team_id = ...` returns nothing rather than another
team's data.

### Secrets

Integration tokens are never stored in Postgres and never returned by this API.
Rows hold a `credential_ref` pointing into the secret store; the value itself
lives only in the vault.
"""

TAGS_METADATA = [
    {
        "name": "health",
        "description": "Liveness probe used by the dashboard's gateway status indicator.",
    },
    {
        "name": "teams",
        "description": (
            "Team configuration and the roster that maps a Google Meet display name "
            "onto a Jira account and a GitHub handle. Speaker attribution depends "
            "entirely on this mapping."
        ),
    },
    {
        "name": "integrations",
        "description": (
            "Jira, GitHub and Google Workspace connections. Credentials submitted for "
            "testing are validated in memory and discarded — nothing is persisted."
        ),
    },
    {
        "name": "sessions",
        "description": (
            "Meeting captures. A session is `live` while the bot is in the call, "
            "`processing` while the transcript is being analyzed, then `completed`."
        ),
    },
]

CONTACT = {"name": "Astra", "url": "https://github.com/SanathSV/astra"}

LICENSE_INFO = {"name": "MIT"}
