"""Tests that need no database.

Anything touching Postgres belongs in an integration suite with a real instance —
row-level security cannot be exercised against a stub.
"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

JIRA_TOKEN = "ATATT3xFfGF0T4Jw8mQ2vK9pLxYzR1nS"
GITHUB_TOKEN = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"


def test_health() -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_openapi_tags_are_documented() -> None:
    """Every tag used by a route carries a description, so /docs reads cleanly."""
    schema = client.get("/openapi.json").json()
    described = {tag["name"] for tag in schema["tags"]}

    used = {
        tag
        for path in schema["paths"].values()
        for operation in path.values()
        for tag in operation.get("tags", [])
    }

    assert used <= described
    assert {"teams", "integrations", "sessions", "health"} <= described


def test_integration_test_accepts_valid_jira_credentials() -> None:
    response = client.post(
        "/api/v1/integrations/test",
        json={
            "provider": "jira",
            "domain": "capstone-core.atlassian.net",
            "token": JIRA_TOKEN,
        },
    )
    assert response.status_code == 200

    body = response.json()
    assert body["ok"] is True
    assert body["status"] == "active"
    assert body["details"]["projects_visible"] == 3


def test_integration_test_rejects_wrong_provider_token() -> None:
    """A GitHub token pasted into the Jira form fails, and says why."""
    response = client.post(
        "/api/v1/integrations/test",
        json={
            "provider": "jira",
            "domain": "capstone-core.atlassian.net",
            "token": GITHUB_TOKEN,
        },
    )
    assert response.status_code == 200

    body = response.json()
    assert body["ok"] is False
    assert body["status"] == "error"
    assert "ATATT" in body["message"]


def test_integration_test_rejects_bad_domain() -> None:
    response = client.post(
        "/api/v1/integrations/test",
        json={"provider": "jira", "domain": "not-a-jira-host.example", "token": JIRA_TOKEN},
    )
    assert response.json()["ok"] is False


def test_integration_test_never_echoes_the_token() -> None:
    """The submitted secret must not appear anywhere in the response."""
    response = client.post(
        "/api/v1/integrations/test",
        json={
            "provider": "github",
            "domain": "github.com/capstone-core",
            "token": GITHUB_TOKEN,
        },
    )
    assert GITHUB_TOKEN not in response.text


def test_sessions_active_requires_team_header() -> None:
    response = client.get("/api/v1/sessions/active")
    assert response.status_code == 400
    assert "X-Team-Id" in response.json()["detail"]


def test_team_upsert_rejects_invalid_jira_key() -> None:
    response = client.post(
        "/api/v1/teams",
        json={"name": "Capstone Core", "slug": "capstone-core", "jira_project_key": "astra"},
    )
    assert response.status_code == 422


def test_team_upsert_rejects_invalid_github_repo() -> None:
    response = client.post(
        "/api/v1/teams",
        json={"name": "Capstone Core", "slug": "capstone-core", "github_repo": "no-slash"},
    )
    assert response.status_code == 422
