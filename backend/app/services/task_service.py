from datetime import datetime, timezone

from app.models.task import CreateTaskRequest, TaskListResponse, TaskResponse, UpdateTaskRequest
from app.repositories.employee_repository import EmployeeRepository
from app.repositories.membership_repository import MembershipRepository
from app.repositories.project_repository import ProjectRepository
from app.repositories.task_repository import TaskRepository


class TaskProjectNotFoundError(Exception):
    pass


class TaskEmployeeNotFoundError(Exception):
    pass


class TaskTeamNotFoundError(Exception):
    pass


class TaskMembershipNotFoundError(Exception):
    pass


class TaskAssigneeNotInTeamError(Exception):
    pass


class TaskNotFoundError(Exception):
    pass


class TaskProtectedFieldError(Exception):
    pass


class TaskDependencyUnavailableError(Exception):
    pass


class TaskDependencyValidationError(Exception):
    pass


class TaskService:
    PROTECTED_FIELDS = {
        "status",
        "progress",
        "completed_at",
        "started_at",
        "astra_confidence",
        "last_evidence",
    }

    def __init__(
        self,
        task_repository: TaskRepository,
        project_repository: ProjectRepository,
        employee_repository: EmployeeRepository,
        membership_repository: MembershipRepository,
    ):
        self.task_repository = task_repository
        self.project_repository = project_repository
        self.employee_repository = employee_repository
        self.membership_repository = membership_repository

    def create(self, project_id: str, request: CreateTaskRequest) -> TaskResponse:
        self._require_project(project_id)
        self._validate_assignment(project_id, request.assignee_id, request.team_id)
        timestamp = self._timestamp()
        item = request.model_dump(mode="json")
        item.update(
            {
                "PK": f"PROJECT#{project_id}",
                "SK": f"TASK#{request.task_id}",
                "entity_type": "TASK",
                "project_id": project_id,
                "created_at": timestamp,
                "updated_at": timestamp,
                "last_evidence": [],
            }
        )
        item.update(self._index_fields(project_id, request.task_id, request.assignee_id, request.team_id))
        return TaskResponse.model_validate(self.task_repository.create_with_state(item))

    def get(self, project_id: str, task_id: str) -> TaskResponse:
        self._require_project(project_id)
        item = self.task_repository.get(project_id, task_id)
        if item is None:
            raise TaskNotFoundError
        return TaskResponse.model_validate(item)

    def list_project_tasks(
        self, project_id: str, limit: int, next_token: str | None
    ) -> TaskListResponse:
        self._require_project(project_id)
        items, last_key = self.task_repository.query_project_tasks(
            project_id, limit, self.task_repository.decode_key(next_token)
        )
        return self._page(items, last_key)

    def update(
        self, project_id: str, task_id: str, request: UpdateTaskRequest
    ) -> TaskResponse:
        self._require_project(project_id)
        existing = self.task_repository.get(project_id, task_id)
        if existing is None:
            raise TaskNotFoundError
        fields = request.model_dump(exclude_unset=True, mode="json")
        protected = self.PROTECTED_FIELDS.intersection(fields)
        if protected:
            raise TaskProtectedFieldError(
                "Task state is managed by the State Engine; protected fields cannot be updated: "
                + ", ".join(sorted(protected))
            )

        assignee_id = fields.get("assignee_id", existing.get("assignee_id"))
        team_id = fields.get("team_id", existing.get("team_id"))
        self._validate_assignment(project_id, assignee_id, team_id)
        remove_fields: list[str] = []
        if "assignee_id" in fields:
            if assignee_id is None:
                remove_fields.extend(["GSI1PK", "GSI1SK"])
            else:
                fields.update(self._index_fields(project_id, task_id, assignee_id, None))
        if "team_id" in fields:
            if team_id is None:
                remove_fields.extend(["GSI2PK", "GSI2SK"])
            else:
                fields.update(self._index_fields(project_id, task_id, None, team_id))
        fields["updated_at"] = self._timestamp()
        item = self.task_repository.update(project_id, task_id, fields, remove_fields)
        if item is None:
            raise TaskNotFoundError
        return TaskResponse.model_validate(item)

    def list_employee_tasks(
        self,
        employee_id: str,
        limit: int,
        next_token: str | None,
        project_id: str | None,
        status: str | None,
        priority: str | None,
    ) -> TaskListResponse:
        self._require_employee(employee_id)
        items, last_key = self.task_repository.query_employee_tasks(
            employee_id,
            limit,
            self.task_repository.decode_key(next_token),
            project_id,
            status,
            priority,
        )
        return self._page(items, last_key)

    def list_team_tasks(
        self,
        project_id: str,
        team_id: str,
        limit: int,
        next_token: str | None,
    ) -> TaskListResponse:
        self._require_project(project_id)
        self._require_team(project_id, team_id)
        items, last_key = self.task_repository.query_team_tasks(
            project_id,
            team_id,
            limit,
            self.task_repository.decode_key(next_token),
        )
        return self._page(items, last_key)

    def _validate_assignment(
        self, project_id: str, assignee_id: str | None, team_id: str | None
    ) -> None:
        if team_id is not None:
            self._require_team(project_id, team_id)
        if assignee_id is not None:
            self._require_employee(assignee_id)
            membership = self.membership_repository.get(
                project_id, f"EMPLOYEE#{assignee_id}"
            )
            if membership is None:
                raise TaskMembershipNotFoundError
            if team_id is not None and membership.get("team_id") != team_id:
                raise TaskAssigneeNotInTeamError

    def _require_project(self, project_id: str) -> None:
        try:
            if self.project_repository.get(project_id) is None:
                raise TaskProjectNotFoundError
        except Exception as error:
            if isinstance(error, TaskProjectNotFoundError):
                raise
            raise TaskDependencyUnavailableError from error

    def _require_employee(self, employee_id: str) -> None:
        try:
            if self.employee_repository.get(employee_id) is None:
                raise TaskEmployeeNotFoundError
        except Exception as error:
            if isinstance(error, TaskEmployeeNotFoundError):
                raise
            raise TaskDependencyUnavailableError from error

    def _require_team(self, project_id: str, team_id: str) -> None:
        try:
            if self.membership_repository.get(project_id, f"TEAM#{team_id}") is None:
                raise TaskTeamNotFoundError
        except Exception as error:
            if isinstance(error, TaskTeamNotFoundError):
                raise
            raise TaskDependencyUnavailableError from error

    def _page(self, items: list[dict], last_key: dict | None) -> TaskListResponse:
        return TaskListResponse(
            items=[TaskResponse.model_validate(item) for item in items],
            next_token=self.task_repository.encode_key(last_key),
        )

    @staticmethod
    def _index_fields(
        project_id: str,
        task_id: str,
        assignee_id: str | None,
        team_id: str | None,
    ) -> dict:
        fields = {}
        if assignee_id is not None:
            fields.update(
                {
                    "GSI1PK": f"EMPLOYEE#{assignee_id}",
                    "GSI1SK": f"PROJECT#{project_id}#TASK#{task_id}",
                }
            )
        if team_id is not None:
            fields.update(
                {
                    "GSI2PK": f"TEAM#{team_id}",
                    "GSI2SK": f"PROJECT#{project_id}#TASK#{task_id}",
                }
            )
        return fields

    @staticmethod
    def _timestamp() -> str:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
