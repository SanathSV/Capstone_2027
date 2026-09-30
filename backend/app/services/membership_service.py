from datetime import datetime, timezone

from app.models.membership import (
    MembershipCreateRequest,
    MembershipResponse,
    MembershipUpdateRequest,
)
from app.models.team import TeamCreateRequest, TeamResponse, TeamUpdateRequest
from app.repositories.employee_repository import (
    EmployeeRepository,
    EmployeeRepositoryValidationError,
    EmployeeTableUnavailableError,
)
from app.repositories.membership_repository import (
    MembershipRepository,
    MembershipRepositoryValidationError,
    MembershipTableUnavailableError,
)
from app.repositories.project_repository import (
    ProjectRepository,
    ProjectRepositoryValidationError,
    ProjectTableUnavailableError,
)


class MembershipProjectNotFoundError(Exception):
    pass


class MembershipEmployeeNotFoundError(Exception):
    pass


class MembershipTeamNotFoundError(Exception):
    pass


class MembershipNotFoundError(Exception):
    pass


class MembershipDependencyUnavailableError(Exception):
    pass


class MembershipDependencyValidationError(Exception):
    pass


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class MembershipService:
    def __init__(
        self,
        membership_repository: MembershipRepository,
        project_repository: ProjectRepository,
        employee_repository: EmployeeRepository,
    ):
        self.membership_repository = membership_repository
        self.project_repository = project_repository
        self.employee_repository = employee_repository

    def create_team(
        self, project_id: str, request: TeamCreateRequest
    ) -> TeamResponse:
        self._require_project(project_id)
        self._require_employee(request.team_lead_id)
        timestamp = utc_timestamp()
        item = {
            "PK": f"PROJECT#{project_id}",
            "SK": f"TEAM#{request.team_id}",
            "entity_type": "PROJECT_TEAM",
            "project_id": project_id,
            "team_id": request.team_id,
            "name": request.name,
            "description": request.description,
            "team_lead_id": request.team_lead_id,
            "status": "ACTIVE",
            "created_at": timestamp,
            "updated_at": timestamp,
        }
        return TeamResponse.model_validate(self.membership_repository.create(item))

    def list_teams(self, project_id: str) -> list[TeamResponse]:
        self._require_project(project_id)
        return [
            TeamResponse.model_validate(item)
            for item in self.membership_repository.query_project_teams(project_id)
        ]

    def get_team(self, project_id: str, team_id: str) -> TeamResponse:
        self._require_project(project_id)
        item = self.membership_repository.get(project_id, f"TEAM#{team_id}")
        if item is None:
            raise MembershipTeamNotFoundError
        return TeamResponse.model_validate(item)

    def update_team(
        self, project_id: str, team_id: str, request: TeamUpdateRequest
    ) -> TeamResponse:
        self._require_project(project_id)
        fields = request.model_dump(exclude_unset=True, mode="json")
        if "team_lead_id" in fields:
            self._require_employee(fields["team_lead_id"])
        fields["updated_at"] = utc_timestamp()
        item = self.membership_repository.update(
            project_id, f"TEAM#{team_id}", fields
        )
        if item is None:
            raise MembershipTeamNotFoundError
        return TeamResponse.model_validate(item)

    def add_employee(
        self, project_id: str, request: MembershipCreateRequest
    ) -> MembershipResponse:
        self._require_project(project_id)
        self._require_employee(request.employee_id)
        if request.team_id is not None:
            self._require_team(project_id, request.team_id)
        timestamp = utc_timestamp()
        item = {
            "PK": f"PROJECT#{project_id}",
            "SK": f"EMPLOYEE#{request.employee_id}",
            "GSI1PK": f"EMPLOYEE#{request.employee_id}",
            "GSI1SK": f"PROJECT#{project_id}",
            "entity_type": "PROJECT_EMPLOYEE",
            "project_id": project_id,
            "employee_id": request.employee_id,
            "team_id": request.team_id,
            "role": request.role,
            "allocation_percentage": request.allocation_percentage,
            "status": "ACTIVE",
            "joined_at": timestamp,
            "updated_at": timestamp,
        }
        if request.team_id is not None:
            item.update(self._team_index(project_id, request.team_id, request.employee_id))
        return MembershipResponse.model_validate(
            self.membership_repository.create(item)
        )

    def list_project_employees(self, project_id: str) -> list[MembershipResponse]:
        self._require_project(project_id)
        return [
            MembershipResponse.model_validate(item)
            for item in self.membership_repository.query_project_employees(project_id)
        ]

    def list_employee_projects(self, employee_id: str) -> list[MembershipResponse]:
        self._require_employee(employee_id)
        return [
            MembershipResponse.model_validate(item)
            for item in self.membership_repository.query_employee_projects(employee_id)
        ]

    def update_employee(
        self,
        project_id: str,
        employee_id: str,
        request: MembershipUpdateRequest,
    ) -> MembershipResponse:
        self._require_project(project_id)
        self._require_employee(employee_id)
        existing = self._require_membership(project_id, employee_id)
        fields = request.model_dump(exclude_unset=True, mode="json")
        remove_fields: list[str] = []
        if "team_id" in fields:
            team_id = fields["team_id"]
            if team_id is None:
                remove_fields = ["GSI2PK", "GSI2SK"]
            else:
                self._require_team(project_id, team_id)
                fields.update(self._team_index(project_id, team_id, employee_id))
        elif existing.get("team_id"):
            pass
        fields["updated_at"] = utc_timestamp()
        item = self.membership_repository.update(
            project_id,
            f"EMPLOYEE#{employee_id}",
            fields,
            remove_fields=remove_fields,
        )
        if item is None:
            raise MembershipNotFoundError
        return MembershipResponse.model_validate(item)

    def add_employee_to_team(
        self, project_id: str, team_id: str, employee_id: str
    ) -> MembershipResponse:
        self._require_project(project_id)
        self._require_team(project_id, team_id)
        self._require_employee(employee_id)
        self._require_membership(project_id, employee_id)
        item = self.membership_repository.update(
            project_id,
            f"EMPLOYEE#{employee_id}",
            {
                "team_id": team_id,
                **self._team_index(project_id, team_id, employee_id),
                "updated_at": utc_timestamp(),
            },
        )
        if item is None:
            raise MembershipNotFoundError
        return MembershipResponse.model_validate(item)

    def list_team_employees(
        self, project_id: str, team_id: str
    ) -> list[MembershipResponse]:
        self._require_project(project_id)
        self._require_team(project_id, team_id)
        return [
            MembershipResponse.model_validate(item)
            for item in self.membership_repository.query_team_employees(
                project_id, team_id
            )
        ]

    def remove_employee(self, project_id: str, employee_id: str) -> None:
        self._require_project(project_id)
        self._require_membership(project_id, employee_id)
        if not self.membership_repository.delete(
            project_id, f"EMPLOYEE#{employee_id}"
        ):
            raise MembershipNotFoundError

    def remove_employee_from_team(
        self, project_id: str, team_id: str, employee_id: str
    ) -> None:
        self._require_project(project_id)
        self._require_team(project_id, team_id)
        membership = self._require_membership(project_id, employee_id)
        if membership.get("team_id") != team_id:
            raise MembershipTeamNotFoundError
        item = self.membership_repository.update(
            project_id,
            f"EMPLOYEE#{employee_id}",
            {"team_id": None, "updated_at": utc_timestamp()},
            remove_fields=["GSI2PK", "GSI2SK"],
        )
        if item is None:
            raise MembershipNotFoundError

    def _require_project(self, project_id: str) -> None:
        try:
            if self.project_repository.get(project_id) is None:
                raise MembershipProjectNotFoundError
        except (ProjectTableUnavailableError, ProjectRepositoryValidationError) as error:
            self._raise_dependency_error(error)

    def _require_employee(self, employee_id: str | None) -> None:
        if employee_id is None:
            return
        try:
            if self.employee_repository.get(employee_id) is None:
                raise MembershipEmployeeNotFoundError
        except (EmployeeTableUnavailableError, EmployeeRepositoryValidationError) as error:
            self._raise_dependency_error(error)

    def _require_team(self, project_id: str, team_id: str) -> dict:
        try:
            item = self.membership_repository.get(project_id, f"TEAM#{team_id}")
        except (
            MembershipTableUnavailableError,
            MembershipRepositoryValidationError,
        ) as error:
            self._raise_dependency_error(error)
        if item is None:
            raise MembershipTeamNotFoundError
        return item

    def _require_membership(self, project_id: str, employee_id: str) -> dict:
        item = self.membership_repository.get(project_id, f"EMPLOYEE#{employee_id}")
        if item is None:
            raise MembershipNotFoundError
        return item

    @staticmethod
    def _team_index(project_id: str, team_id: str, employee_id: str) -> dict:
        return {
            "GSI2PK": f"PROJECT#{project_id}#TEAM#{team_id}",
            "GSI2SK": f"EMPLOYEE#{employee_id}",
        }

    @staticmethod
    def _raise_dependency_error(error: Exception) -> None:
        raise MembershipDependencyUnavailableError from error
