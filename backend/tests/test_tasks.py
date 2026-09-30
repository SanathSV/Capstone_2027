from fastapi.testclient import TestClient

from app.api.tasks import get_task_service
from app.main import app
from app.repositories.task_repository import TaskAlreadyExistsError
from app.services.task_service import TaskService


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
        self.items = {
            ("PROJ_001", "TEAM#TEAM_001"): {"team_id": "TEAM_001"},
            ("PROJ_001", "TEAM#TEAM_002"): {"team_id": "TEAM_002"},
            ("PROJ_001", "EMPLOYEE#EMP_001"): {"employee_id": "EMP_001", "team_id": "TEAM_001"},
            ("PROJ_001", "EMPLOYEE#EMP_002"): {"employee_id": "EMP_002", "team_id": "TEAM_002"},
        }

    def get(self, project_id, sort_key):
        return self.items.get((project_id, sort_key))


class FakeTaskRepository:
    def __init__(self):
        self.items = {}

    def create_with_state(self, item):
        key = (item["project_id"], item["task_id"])
        if key in self.items:
            raise TaskAlreadyExistsError
        self.items[key] = item.copy()
        return self.items[key]

    def get(self, project_id, task_id):
        return self.items.get((project_id, task_id))

    def update(self, project_id, task_id, fields, remove_fields=None):
        item = self.items.get((project_id, task_id))
        if item is None:
            return None
        item.update(fields)
        for field in remove_fields or []:
            item.pop(field, None)
        return item

    def query_project_tasks(self, project_id, limit, start_key):
        items = [item for (project, _), item in sorted(self.items.items()) if project == project_id]
        return self._page(items, limit, start_key, "project_id", project_id)

    def query_employee_tasks(self, employee_id, limit, start_key, project_id=None, status=None, priority=None):
        items = [item for item in self.items.values() if item.get("assignee_id") == employee_id]
        if project_id:
            items = [item for item in items if item["project_id"] == project_id]
        if status:
            items = [item for item in items if item["status"] == status]
        if priority:
            items = [item for item in items if item["priority"] == priority]
        return self._page(items, limit, start_key, "employee_id", employee_id)

    def query_team_tasks(self, project_id, team_id, limit, start_key):
        items = [
            item for item in self.items.values()
            if item["project_id"] == project_id and item.get("team_id") == team_id
        ]
        return self._page(items, limit, start_key, "team_id", team_id)

    def encode_key(self, key):
        from app.repositories.task_repository import TaskRepository

        return TaskRepository.__new__(TaskRepository).encode_key(key)

    def decode_key(self, token):
        from app.repositories.task_repository import TaskRepository

        return TaskRepository.__new__(TaskRepository).decode_key(token)

    @staticmethod
    def _page(items, limit, start_key, key_name, key_value):
        start = 0
        if start_key:
            start = next(
                (index + 1 for index, item in enumerate(items) if item["task_id"] == start_key["SK"].removeprefix("TASK#")),
                0,
            )
        selected = items[start : start + limit]
        last = None
        if start + limit < len(items) and selected:
            last = {"PK": f"PROJECT#{selected[-1]['project_id']}", "SK": f"TASK#{selected[-1]['task_id']}"}
        return selected, last


project_repository = FakeProjectRepository()
employee_repository = FakeEmployeeRepository()
membership_repository = FakeMembershipRepository()
task_repository = FakeTaskRepository()
service = TaskService(
    task_repository,
    project_repository,
    employee_repository,
    membership_repository,
)
app.dependency_overrides[get_task_service] = lambda: service
client = TestClient(app)


def setup_function():
    task_repository.items.clear()
    membership_repository.items = {
        ("PROJ_001", "TEAM#TEAM_001"): {"team_id": "TEAM_001"},
        ("PROJ_001", "TEAM#TEAM_002"): {"team_id": "TEAM_002"},
        ("PROJ_001", "EMPLOYEE#EMP_001"): {
            "employee_id": "EMP_001",
            "team_id": "TEAM_001",
        },
        ("PROJ_001", "EMPLOYEE#EMP_002"): {
            "employee_id": "EMP_002",
            "team_id": "TEAM_002",
        },
    }


def payload(task_id="TASK_001", assignee_id="EMP_001", team_id="TEAM_001"):
    return {
        "task_id": task_id,
        "title": "Implement authentication API",
        "description": "Implement JWT authentication endpoints",
        "jira_issue_key": "ASTRA-101",
        "assignee_id": assignee_id,
        "team_id": team_id,
        "status": "NOT_STARTED",
        "progress": 0,
        "priority": "HIGH",
        "estimated_hours": 12,
        "acceptance_criteria": ["Login works", "JWT tokens are generated"],
    }


def create_task(task_id="TASK_001", assignee_id="EMP_001", team_id="TEAM_001"):
    return client.post(
        "/api/v1/management/projects/PROJ_001/tasks",
        json=payload(task_id, assignee_id, team_id),
    )


def test_create_task():
    response = create_task()
    assert response.status_code == 201
    assert response.json()["task_id"] == "TASK_001"
    assert response.json()["progress"] == 0


def test_duplicate_task_returns_409():
    create_task()
    assert create_task().status_code == 409


def test_invalid_project_returns_404():
    response = client.post(
        "/api/v1/management/projects/MISSING/tasks", json=payload()
    )
    assert response.status_code == 404


def test_invalid_assignee_returns_404():
    assert create_task(assignee_id="EMP_MISSING", team_id=None).status_code == 404


def test_employee_not_in_project_returns_400():
    employee_repository.items["EMP_003"] = {"employee_id": "EMP_003"}
    assert create_task(assignee_id="EMP_003", team_id=None).status_code == 400


def test_invalid_team_returns_404():
    assert create_task(team_id="TEAM_MISSING").status_code == 404


def test_assignee_not_in_team_returns_400():
    assert create_task(assignee_id="EMP_001", team_id="TEAM_002").status_code == 400


def test_get_project_tasks():
    create_task()
    response = client.get("/api/v1/management/projects/PROJ_001/tasks")
    assert response.status_code == 200
    assert response.json()["items"][0]["task_id"] == "TASK_001"


def test_get_single_task():
    create_task()
    response = client.get("/api/v1/management/projects/PROJ_001/tasks/TASK_001")
    assert response.status_code == 200
    assert response.json()["title"] == "Implement authentication API"


def test_update_task_metadata():
    create_task()
    response = client.patch(
        "/api/v1/management/projects/PROJ_001/tasks/TASK_001",
        json={"title": "Updated title", "actual_hours": 4},
    )
    assert response.status_code == 200
    assert response.json()["title"] == "Updated title"
    assert response.json()["actual_hours"] == 4


def test_change_assignee_updates_employee_index():
    create_task()
    membership_repository.items[("PROJ_001", "EMPLOYEE#EMP_002")] = {
        "employee_id": "EMP_002", "team_id": "TEAM_001"
    }
    response = client.patch(
        "/api/v1/management/projects/PROJ_001/tasks/TASK_001",
        json={"assignee_id": "EMP_002"},
    )
    assert response.status_code == 200
    assert response.json()["assignee_id"] == "EMP_002"
    assert task_repository.items[("PROJ_001", "TASK_001")]["GSI1PK"] == "EMPLOYEE#EMP_002"


def test_remove_assignee_removes_employee_index():
    create_task()
    response = client.patch(
        "/api/v1/management/projects/PROJ_001/tasks/TASK_001",
        json={"assignee_id": None, "team_id": None},
    )
    assert response.status_code == 200
    item = task_repository.items[("PROJ_001", "TASK_001")]
    assert "GSI1PK" not in item and "GSI2PK" not in item


def test_change_team_updates_team_index():
    create_task()
    response = client.patch(
        "/api/v1/management/projects/PROJ_001/tasks/TASK_001",
        json={"team_id": "TEAM_002", "assignee_id": "EMP_002"},
    )
    assert response.status_code == 200
    assert task_repository.items[("PROJ_001", "TASK_001")]["GSI2PK"] == "TEAM#TEAM_002"


def test_remove_team_removes_team_index():
    create_task()
    response = client.patch(
        "/api/v1/management/projects/PROJ_001/tasks/TASK_001",
        json={"team_id": None},
    )
    assert response.status_code == 200
    assert "GSI2PK" not in task_repository.items[("PROJ_001", "TASK_001")]


def test_get_employee_tasks():
    create_task()
    response = client.get("/api/v1/management/employees/EMP_001/tasks")
    assert response.status_code == 200
    assert response.json()["items"][0]["task_id"] == "TASK_001"


def test_get_team_tasks():
    create_task()
    response = client.get("/api/v1/management/projects/PROJ_001/teams/TEAM_001/tasks")
    assert response.status_code == 200
    assert response.json()["items"][0]["task_id"] == "TASK_001"


def test_pagination():
    create_task("TASK_001")
    create_task("TASK_002")
    first = client.get("/api/v1/management/projects/PROJ_001/tasks?limit=1").json()
    assert first["next_token"]
    second = client.get(
        f"/api/v1/management/projects/PROJ_001/tasks?limit=1&next_token={first['next_token']}"
    )
    assert second.status_code == 200
    assert second.json()["items"][0]["task_id"] == "TASK_002"


def test_protected_state_fields_return_400():
    create_task()
    response = client.patch(
        "/api/v1/management/projects/PROJ_001/tasks/TASK_001",
        json={"progress": 50, "status": "IN_PROGRESS"},
    )
    assert response.status_code == 400
    assert "State Engine" in response.json()["detail"]


def test_invalid_progress_returns_422():
    invalid = payload()
    invalid["progress"] = 101
    assert client.post("/api/v1/management/projects/PROJ_001/tasks", json=invalid).status_code == 422


def test_negative_hours_return_422():
    invalid = payload()
    invalid["estimated_hours"] = -1
    assert client.post("/api/v1/management/projects/PROJ_001/tasks", json=invalid).status_code == 422
