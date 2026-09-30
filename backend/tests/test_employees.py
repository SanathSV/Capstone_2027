from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.api.employees import get_employee_service
from app.main import app
from app.repositories.employee_repository import EmployeeAlreadyExistsError
from app.services.employee_service import EmployeeNotFoundError, EmployeeService


class FakeRepository:
    def __init__(self):
        self.items = {}

    def create(self, item):
        if item["employee_id"] in self.items:
            raise EmployeeAlreadyExistsError
        self.items[item["employee_id"]] = item.copy()
        return self.items[item["employee_id"]]

    def get(self, employee_id):
        return self.items.get(employee_id)

    def list(self, limit, exclusive_start_key):
        keys = sorted(self.items)
        start = 0
        if exclusive_start_key:
            start = keys.index(exclusive_start_key["employee_id"]) + 1
        selected = keys[start : start + limit]
        last = {"employee_id": selected[-1]} if start + limit < len(keys) else None
        return [self.items[key] for key in selected], last

    def update(self, employee_id, fields):
        if employee_id not in self.items:
            return None
        self.items[employee_id].update(fields)
        return self.items[employee_id]

    def find_by_device_id(self, device_id):
        for item in self.items.values():
            if item.get("agent", {}).get("device_id") == device_id:
                return item
        return None

    @staticmethod
    def encode_key(key):
        from app.repositories.employee_repository import EmployeeRepository

        return EmployeeRepository.encode_key(key)

    @staticmethod
    def decode_key(token):
        from app.repositories.employee_repository import EmployeeRepository

        return EmployeeRepository.decode_key(token)


repository = FakeRepository()
service = EmployeeService(repository)
app.dependency_overrides[get_employee_service] = lambda: service
client = TestClient(app)


def employee_payload(employee_id="EMP_001"):
    return {
        "employee_id": employee_id,
        "name": "John Doe",
        "email": f"{employee_id.lower()}@example.com",
        "role": "Software Engineer",
        "department": "Engineering",
        "manager_id": "EMP_010",
    }


def setup_function():
    repository.items.clear()


def test_create_employee():
    response = client.post("/api/v1/management/employees", json=employee_payload())
    assert response.status_code == 201
    body = response.json()
    assert body["employment_status"] == "ACTIVE"
    assert body["agent"]["status"] == "UNKNOWN"
    assert body["created_at"] == body["updated_at"]


def test_duplicate_employee():
    client.post("/api/v1/management/employees", json=employee_payload())
    response = client.post("/api/v1/management/employees", json=employee_payload())
    assert response.status_code == 409


def test_get_employee():
    client.post("/api/v1/management/employees", json=employee_payload())
    response = client.get("/api/v1/management/employees/EMP_001")
    assert response.status_code == 200
    assert response.json()["employee_id"] == "EMP_001"


def test_employee_not_found():
    response = client.get("/api/v1/management/employees/MISSING")
    assert response.status_code == 404


def test_update_employee():
    client.post("/api/v1/management/employees", json=employee_payload())
    response = client.patch(
        "/api/v1/management/employees/EMP_001",
        json={"name": "Jane Doe", "employment_status": "ON_LEAVE"},
    )
    assert response.status_code == 200
    assert response.json()["name"] == "Jane Doe"
    assert response.json()["employment_status"] == "ON_LEAVE"
    assert response.json()["department"] == "Engineering"


def test_list_employees():
    for employee_id in ("EMP_001", "EMP_002"):
        client.post("/api/v1/management/employees", json=employee_payload(employee_id))
    response = client.get("/api/v1/management/employees")
    assert response.status_code == 200
    assert len(response.json()["items"]) == 2


def test_pagination():
    for employee_id in ("EMP_001", "EMP_002", "EMP_003"):
        client.post("/api/v1/management/employees", json=employee_payload(employee_id))
    first = client.get("/api/v1/management/employees?limit=2").json()
    assert len(first["items"]) == 2
    assert first["next_token"]
    second = client.get(
        f"/api/v1/management/employees?limit=2&next_token={first['next_token']}"
    )
    assert [item["employee_id"] for item in second.json()["items"]] == ["EMP_003"]
    assert second.json()["next_token"] is None


def test_agent_registration():
    client.post("/api/v1/management/employees", json=employee_payload())
    response = client.post(
        "/api/v1/agent/register",
        json={
            "employee_id": "EMP_001",
            "device_id": "DEVICE_001",
            "agent_version": "1.2.0",
            "os": "macos",
        },
    )
    assert response.status_code == 200
    assert response.json()["agent"]["device_id"] == "DEVICE_001"
    assert response.json()["agent"]["os"] == "macos"


def test_agent_registration_for_nonexistent_employee():
    response = client.post(
        "/api/v1/agent/register",
        json={
            "employee_id": "MISSING",
            "device_id": "DEVICE_001",
            "agent_version": "1.2.0",
            "os": "macos",
        },
    )
    assert response.status_code == 404


def test_heartbeat():
    client.post("/api/v1/management/employees", json=employee_payload())
    client.post(
        "/api/v1/agent/register",
        json={
            "employee_id": "EMP_001",
            "device_id": "DEVICE_001",
            "agent_version": "1.2.0",
            "os": "macos",
        },
    )
    response = client.post(
        "/api/v1/agent/heartbeat",
        json={
            "device_id": "DEVICE_001",
            "timestamp": "2026-09-30T16:00:00Z",
            "agent_version": "1.2.1",
        },
    )
    assert response.status_code == 200
    assert response.json()["agent"]["status"] == "ONLINE"
    assert response.json()["agent"]["agent_version"] == "1.2.1"
    assert response.json()["agent"]["last_heartbeat"] == "2026-09-30T16:00:00Z"
