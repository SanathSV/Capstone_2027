from datetime import datetime, timezone

from app.models.project import (
    ProjectCreateRequest,
    ProjectPage,
    ProjectResponse,
    ProjectUpdateRequest,
)
from app.repositories.employee_repository import (
    EmployeeRepository,
    EmployeeRepositoryValidationError,
    EmployeeTableUnavailableError,
)
from app.repositories.project_repository import ProjectRepository


class ProjectNotFoundError(Exception):
    pass


class ProjectOwnerNotFoundError(Exception):
    pass


class ProjectEmployeeTableUnavailableError(Exception):
    pass


class ProjectEmployeeValidationError(Exception):
    pass


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class ProjectService:
    def __init__(
        self,
        project_repository: ProjectRepository,
        employee_repository: EmployeeRepository,
    ):
        self.project_repository = project_repository
        self.employee_repository = employee_repository

    def create(self, request: ProjectCreateRequest) -> ProjectResponse:
        self._verify_owner(request.owner_employee_id)
        timestamp = utc_timestamp()
        item = request.model_dump(mode="json", exclude_none=True)
        item.update({"created_at": timestamp, "updated_at": timestamp})
        return ProjectResponse.model_validate(self.project_repository.create(item))

    def get(self, project_id: str) -> ProjectResponse:
        item = self.project_repository.get(project_id)
        if item is None:
            raise ProjectNotFoundError
        return ProjectResponse.model_validate(item)

    def list(self, limit: int, next_token: str | None) -> ProjectPage:
        start_key = self.project_repository.decode_key(next_token)
        items, last_key = self.project_repository.list(limit, start_key)
        return ProjectPage(
            items=[ProjectResponse.model_validate(item) for item in items],
            next_token=self.project_repository.encode_key(last_key),
        )

    def update(
        self, project_id: str, request: ProjectUpdateRequest
    ) -> ProjectResponse:
        fields = request.model_dump(exclude_unset=True, mode="json")
        if "owner_employee_id" in fields:
            self._verify_owner(fields["owner_employee_id"])
        fields["updated_at"] = utc_timestamp()
        item = self.project_repository.update(project_id, fields)
        if item is None:
            raise ProjectNotFoundError
        return ProjectResponse.model_validate(item)

    def _verify_owner(self, employee_id: str | None) -> None:
        if employee_id is None:
            return
        try:
            employee = self.employee_repository.get(employee_id)
        except EmployeeTableUnavailableError as error:
            raise ProjectEmployeeTableUnavailableError from error
        except EmployeeRepositoryValidationError as error:
            raise ProjectEmployeeValidationError(str(error)) from error
        if employee is None:
            raise ProjectOwnerNotFoundError
