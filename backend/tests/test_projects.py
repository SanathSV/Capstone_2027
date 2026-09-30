from fastapi.testclient import TestClient

from app.api.projects import get_project_service
from app.main import app
from app.repositories.project_repository import ProjectAlreadyExistsError
from app.services.project_service import ProjectService


class FakeEmployeeRepository:
    def __init__(self):
        self.items = {}

    def get(self, employee_id):
        return self.items.get(employee_id)


class FakeProjectRepository:
    def __init__(self):
        self.items = {}

    def create(self, item):
        if item["project_id"] in self.items:
            raise ProjectAlreadyExistsError
        self.items[item["project_id"]] = item.copy()
        return self.items[item["project_id"]]

    def get(self, project_id):
        return self.items.get(project_id)

    def list(self, limit, exclusive_start_key):
        keys = sorted(self.items)
        start = 0
        if exclusive_start_key:
            start = keys.index(exclusive_start_key["project_id"]) + 1
        selected = keys[start : start + limit]
        last = {"project_id": selected[-1]} if start + limit < len(keys) else None
        return [self.items[key] for key in selected], last

    def update(self, project_id, fields):
        if project_id not in self.items:
            return None
        self.items[project_id].update(fields)
        return self.items[project_id]

    @staticmethod
    def encode_key(key):
        from app.repositories.project_repository import ProjectRepository

        return ProjectRepository.encode_key(key)

    @staticmethod
    def decode_key(token):
        from app.repositories.project_repository import ProjectRepository

        return ProjectRepository.decode_key(token)


employee_repository = FakeEmployeeRepository()
project_repository = FakeProjectRepository()
project_service = ProjectService(project_repository, employee_repository)
app.dependency_overrides[get_project_service] = lambda: project_service
client = TestClient(app)


def setup_function():
    employee_repository.items.clear()
    project_repository.items.clear()
    employee_repository.items["EMP_001"] = {"employee_id": "EMP_001"}


def project_payload(project_id="PROJ_001"):
    return {
        "project_id": project_id,
        "name": "Astra",
        "description": "Workforce intelligence platform",
        "status": "ACTIVE",
        "owner_employee_id": "EMP_001",
        "department": "Engineering",
    }


def test_create_project():
    response = client.post("/api/v1/management/projects", json=project_payload())
    assert response.status_code == 201
    body = response.json()
    assert body["project_id"] == "PROJ_001"
    assert body["status"] == "ACTIVE"
    assert body["created_at"] == body["created_at"]


def test_duplicate_project():
    client.post("/api/v1/management/projects", json=project_payload())
    response = client.post("/api/v1/management/projects", json=project_payload())
    assert response.status_code == 409


def test_get_project():
    client.post("/api/v1/management/projects", json=project_payload())
    response = client.get("/api/v1/management/projects/PROJ_001")
    assert response.status_code == 200
    assert response.json()["name"] == "Astra"


def test_project_not_found():
    response = client.get("/api/v1/management/projects/MISSING")
    assert response.status_code == 404


def test_list_projects():
    for project_id in ("PROJ_001", "PROJ_002"):
        client.post(
            "/api/v1/management/projects", json=project_payload(project_id)
        )
    response = client.get("/api/v1/management/projects")
    assert response.status_code == 200
    assert len(response.json()["items"]) == 2


def test_pagination():
    for project_id in ("PROJ_001", "PROJ_002", "PROJ_003"):
        client.post(
            "/api/v1/management/projects", json=project_payload(project_id)
        )
    first = client.get("/api/v1/management/projects?limit=2").json()
    assert len(first["items"]) == 2
    second = client.get(
        f"/api/v1/management/projects?limit=2&next_token={first['next_token']}"
    )
    assert [item["project_id"] for item in second.json()["items"]] == ["PROJ_003"]
    assert second.json()["next_token"] is None


def test_update_project():
    client.post("/api/v1/management/projects", json=project_payload())
    response = client.patch(
        "/api/v1/management/projects/PROJ_001",
        json={"name": "Astra Platform", "department": "Product"},
    )
    assert response.status_code == 200
    assert response.json()["name"] == "Astra Platform"
    assert response.json()["department"] == "Product"
    assert response.json()["project_id"] == "PROJ_001"


def test_invalid_owner_employee():
    payload = project_payload()
    payload["owner_employee_id"] = "EMP_MISSING"
    response = client.post("/api/v1/management/projects", json=payload)
    assert response.status_code == 404


def test_valid_owner_employee():
    response = client.post("/api/v1/management/projects", json=project_payload())
    assert response.status_code == 201
    assert response.json()["owner_employee_id"] == "EMP_001"


def test_github_metadata():
    payload = project_payload()
    payload["github"] = {
        "provider": "github",
        "organization": "my-org",
        "repository": "astra",
        "repository_id": "123456",
        "default_branch": "main",
        "installation_id": "install-123",
    }
    response = client.post("/api/v1/management/projects", json=payload)
    assert response.status_code == 201
    assert response.json()["github"]["repository"] == "astra"


def test_jira_metadata():
    payload = project_payload()
    payload["jira"] = {
        "provider": "jira",
        "cloud_id": "abc123",
        "project_key": "ASTRA",
    }
    response = client.post("/api/v1/management/projects", json=payload)
    assert response.status_code == 201
    assert response.json()["jira"]["project_key"] == "ASTRA"
