from fastapi.testclient import TestClient

from app.api.memberships import get_membership_service
from app.main import app
from app.repositories.membership_repository import MembershipAlreadyExistsError
from app.services.membership_service import MembershipService


class FakeProjectRepository:
    def __init__(self):
        self.items = {"PROJ_001": {"project_id": "PROJ_001"}}

    def get(self, project_id):
        return self.items.get(project_id)


class FakeEmployeeRepository:
    def __init__(self):
        self.items = {
            "EMP_001": {"employee_id": "EMP_001"},
            "EMP_002": {"employee_id": "EMP_002"},
        }

    def get(self, employee_id):
        return self.items.get(employee_id)


class FakeMembershipRepository:
    def __init__(self):
        self.items = {}

    def create(self, item):
        key = (item["project_id"], item["SK"])
        if key in self.items:
            raise MembershipAlreadyExistsError
        self.items[key] = item.copy()
        return self.items[key]

    def get(self, project_id, sort_key):
        return self.items.get((project_id, sort_key))

    def query_project_teams(self, project_id):
        return [
            item
            for (item_project_id, sort_key), item in self.items.items()
            if item_project_id == project_id and sort_key.startswith("TEAM#")
        ]

    def query_project_employees(self, project_id):
        return [
            item
            for (item_project_id, sort_key), item in self.items.items()
            if item_project_id == project_id and sort_key.startswith("EMPLOYEE#")
        ]

    def query_employee_projects(self, employee_id):
        return [
            item
            for item in self.items.values()
            if item.get("entity_type") == "PROJECT_EMPLOYEE"
            and item["employee_id"] == employee_id
        ]

    def query_team_employees(self, project_id, team_id):
        return [
            item
            for item in self.items.values()
            if item.get("GSI2PK") == f"PROJECT#{project_id}#TEAM#{team_id}"
        ]

    def update(self, project_id, sort_key, fields, remove_fields=None):
        item = self.items.get((project_id, sort_key))
        if item is None:
            return None
        item.update(fields)
        for field in remove_fields or []:
            item.pop(field, None)
        return item

    def delete(self, project_id, sort_key):
        return self.items.pop((project_id, sort_key), None) is not None


project_repository = FakeProjectRepository()
employee_repository = FakeEmployeeRepository()
membership_repository = FakeMembershipRepository()
service = MembershipService(
    membership_repository, project_repository, employee_repository
)
app.dependency_overrides[get_membership_service] = lambda: service
client = TestClient(app)


def setup_function():
    membership_repository.items.clear()
    project_repository.items = {"PROJ_001": {"project_id": "PROJ_001"}}
    employee_repository.items = {
        "EMP_001": {"employee_id": "EMP_001"},
        "EMP_002": {"employee_id": "EMP_002"},
    }


def team_payload(team_id="TEAM_001"):
    return {
        "team_id": team_id,
        "name": "Backend Team",
        "description": "Backend engineering team",
        "team_lead_id": "EMP_001",
    }


def membership_payload(employee_id="EMP_001", team_id="TEAM_001"):
    return {
        "employee_id": employee_id,
        "team_id": team_id,
        "role": "Software Engineer",
        "allocation_percentage": 100,
    }


def create_team(team_id="TEAM_001"):
    return client.post(
        "/api/v1/management/projects/PROJ_001/teams", json=team_payload(team_id)
    )


def add_employee(employee_id="EMP_001", team_id="TEAM_001"):
    return client.post(
        "/api/v1/management/projects/PROJ_001/employees",
        json=membership_payload(employee_id, team_id),
    )


def test_create_team():
    response = create_team()
    assert response.status_code == 201
    assert response.json()["project_id"] == "PROJ_001"
    assert response.json()["team_id"] == "TEAM_001"


def test_duplicate_team():
    create_team()
    response = create_team()
    assert response.status_code == 409


def test_get_team():
    create_team()
    response = client.get("/api/v1/management/projects/PROJ_001/teams/TEAM_001")
    assert response.status_code == 200
    assert response.json()["name"] == "Backend Team"


def test_list_project_teams():
    create_team("TEAM_001")
    create_team("TEAM_002")
    response = client.get("/api/v1/management/projects/PROJ_001/teams")
    assert response.status_code == 200
    assert len(response.json()) == 2


def test_update_team():
    create_team()
    response = client.patch(
        "/api/v1/management/projects/PROJ_001/teams/TEAM_001",
        json={"name": "Platform Team", "status": "INACTIVE"},
    )
    assert response.status_code == 200
    assert response.json()["name"] == "Platform Team"
    assert response.json()["status"] == "INACTIVE"


def test_invalid_project():
    response = client.post(
        "/api/v1/management/projects/MISSING/teams", json=team_payload()
    )
    assert response.status_code == 404


def test_invalid_team_lead():
    payload = team_payload()
    payload["team_lead_id"] = "EMP_MISSING"
    response = client.post(
        "/api/v1/management/projects/PROJ_001/teams", json=payload
    )
    assert response.status_code == 404


def test_add_employee_to_project():
    create_team()
    response = add_employee()
    assert response.status_code == 201
    assert response.json()["employee_id"] == "EMP_001"


def test_duplicate_project_membership():
    create_team()
    add_employee()
    response = add_employee()
    assert response.status_code == 409


def test_invalid_employee():
    response = add_employee("EMP_MISSING")
    assert response.status_code == 404


def test_invalid_membership_project():
    response = client.post(
        "/api/v1/management/projects/MISSING/employees",
        json=membership_payload(),
    )
    assert response.status_code == 404


def test_invalid_membership_team():
    response = add_employee(team_id="TEAM_MISSING")
    assert response.status_code == 404


def test_list_project_employees():
    create_team()
    add_employee("EMP_001")
    add_employee("EMP_002")
    response = client.get("/api/v1/management/projects/PROJ_001/employees")
    assert response.status_code == 200
    assert len(response.json()) == 2


def test_get_employee_projects():
    create_team()
    add_employee()
    response = client.get("/api/v1/management/employees/EMP_001/projects")
    assert response.status_code == 200
    assert response.json()[0]["project_id"] == "PROJ_001"


def test_update_membership():
    create_team()
    create_team("TEAM_002")
    add_employee()
    response = client.patch(
        "/api/v1/management/projects/PROJ_001/employees/EMP_001",
        json={
            "team_id": "TEAM_002",
            "role": "Tech Lead",
            "allocation_percentage": 80,
        },
    )
    assert response.status_code == 200
    assert response.json()["team_id"] == "TEAM_002"
    assert response.json()["role"] == "Tech Lead"
    assert not membership_repository.query_team_employees("PROJ_001", "TEAM_001")
    assert len(membership_repository.query_team_employees("PROJ_001", "TEAM_002")) == 1


def test_move_employee_between_teams():
    create_team()
    create_team("TEAM_002")
    add_employee()
    response = client.post(
        "/api/v1/management/projects/PROJ_001/teams/TEAM_002/employees",
        json={"employee_id": "EMP_001"},
    )
    assert response.status_code == 200
    assert response.json()["team_id"] == "TEAM_002"


def test_get_team_employees():
    create_team()
    add_employee()
    response = client.get(
        "/api/v1/management/projects/PROJ_001/teams/TEAM_001/employees"
    )
    assert response.status_code == 200
    assert response.json()[0]["employee_id"] == "EMP_001"


def test_remove_employee_from_team():
    create_team()
    add_employee()
    response = client.delete(
        "/api/v1/management/projects/PROJ_001/teams/TEAM_001/employees/EMP_001"
    )
    assert response.status_code == 204
    membership = membership_repository.get("PROJ_001", "EMPLOYEE#EMP_001")
    assert membership["team_id"] is None
    assert "GSI2PK" not in membership
    assert not membership_repository.query_team_employees("PROJ_001", "TEAM_001")


def test_remove_employee_from_project():
    create_team()
    add_employee()
    response = client.delete(
        "/api/v1/management/projects/PROJ_001/employees/EMP_001"
    )
    assert response.status_code == 204
    assert membership_repository.get("PROJ_001", "EMPLOYEE#EMP_001") is None
