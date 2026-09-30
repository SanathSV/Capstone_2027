import logging
from typing import Callable

from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.core.dynamodb import (
    get_employees_table,
    get_projects_table,
    get_project_memberships_table,
)
from app.models.membership import (
    MembershipCreateRequest,
    MembershipResponse,
    MembershipUpdateRequest,
)
from app.models.team import TeamCreateRequest, TeamEmployeeRequest, TeamResponse, TeamUpdateRequest
from app.repositories.employee_repository import EmployeeRepository
from app.repositories.membership_repository import (
    MembershipAlreadyExistsError,
    MembershipRepository,
    MembershipRepositoryValidationError,
    MembershipTableUnavailableError,
)
from app.repositories.project_repository import ProjectRepository
from app.services.membership_service import (
    MembershipDependencyUnavailableError,
    MembershipDependencyValidationError,
    MembershipEmployeeNotFoundError,
    MembershipNotFoundError,
    MembershipProjectNotFoundError,
    MembershipService,
    MembershipTeamNotFoundError,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def get_membership_service() -> MembershipService:
    return MembershipService(
        membership_repository=MembershipRepository(get_project_memberships_table()),
        project_repository=ProjectRepository(get_projects_table()),
        employee_repository=EmployeeRepository(get_employees_table()),
    )


def handle_membership_error(error: Exception) -> None:
    if isinstance(error, MembershipDependencyValidationError):
        raise HTTPException(status_code=400, detail=str(error)) from error
    if isinstance(error, MembershipDependencyUnavailableError):
        raise HTTPException(
            status_code=503, detail="A required Astra database is unavailable"
        ) from error
    if isinstance(error, MembershipRepositoryValidationError):
        raise HTTPException(status_code=400, detail=str(error)) from error
    if isinstance(error, MembershipTableUnavailableError):
        raise HTTPException(
            status_code=503, detail="Membership database is unavailable"
        ) from error
    raise error


def run_with_errors(operation: Callable):
    try:
        return operation()
    except MembershipProjectNotFoundError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except MembershipEmployeeNotFoundError as error:
        raise HTTPException(status_code=404, detail="Employee not found") from error
    except MembershipTeamNotFoundError as error:
        raise HTTPException(status_code=404, detail="Team not found") from error
    except MembershipNotFoundError as error:
        raise HTTPException(status_code=404, detail="Project membership not found") from error
    except MembershipAlreadyExistsError as error:
        raise HTTPException(status_code=409, detail="Resource already exists") from error
    except (
        MembershipDependencyUnavailableError,
        MembershipDependencyValidationError,
        MembershipRepositoryValidationError,
        MembershipTableUnavailableError,
    ) as error:
        handle_membership_error(error)


@router.post(
    "/api/v1/management/projects/{project_id}/teams",
    response_model=TeamResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_team(
    project_id: str,
    request: TeamCreateRequest,
    service: MembershipService = Depends(get_membership_service),
):
    team = run_with_errors(lambda: service.create_team(project_id, request))
    logger.info("team_created", extra={"project_id": project_id, "team_id": request.team_id})
    return team


@router.get(
    "/api/v1/management/projects/{project_id}/teams",
    response_model=list[TeamResponse],
)
def list_teams(
    project_id: str,
    service: MembershipService = Depends(get_membership_service),
):
    return run_with_errors(lambda: service.list_teams(project_id))


@router.get(
    "/api/v1/management/projects/{project_id}/teams/{team_id}",
    response_model=TeamResponse,
)
def get_team(
    project_id: str,
    team_id: str,
    service: MembershipService = Depends(get_membership_service),
):
    return run_with_errors(lambda: service.get_team(project_id, team_id))


@router.patch(
    "/api/v1/management/projects/{project_id}/teams/{team_id}",
    response_model=TeamResponse,
)
def update_team(
    project_id: str,
    team_id: str,
    request: TeamUpdateRequest,
    service: MembershipService = Depends(get_membership_service),
):
    return run_with_errors(lambda: service.update_team(project_id, team_id, request))


@router.post(
    "/api/v1/management/projects/{project_id}/employees",
    response_model=MembershipResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_employee(
    project_id: str,
    request: MembershipCreateRequest,
    service: MembershipService = Depends(get_membership_service),
):
    membership = run_with_errors(lambda: service.add_employee(project_id, request))
    logger.info(
        "project_employee_added",
        extra={"project_id": project_id, "employee_id": request.employee_id},
    )
    return membership


@router.get(
    "/api/v1/management/projects/{project_id}/employees",
    response_model=list[MembershipResponse],
)
def list_project_employees(
    project_id: str,
    service: MembershipService = Depends(get_membership_service),
):
    return run_with_errors(lambda: service.list_project_employees(project_id))


@router.get(
    "/api/v1/management/employees/{employee_id}/projects",
    response_model=list[MembershipResponse],
)
def list_employee_projects(
    employee_id: str,
    service: MembershipService = Depends(get_membership_service),
):
    return run_with_errors(lambda: service.list_employee_projects(employee_id))


@router.patch(
    "/api/v1/management/projects/{project_id}/employees/{employee_id}",
    response_model=MembershipResponse,
)
def update_employee_membership(
    project_id: str,
    employee_id: str,
    request: MembershipUpdateRequest,
    service: MembershipService = Depends(get_membership_service),
):
    return run_with_errors(
        lambda: service.update_employee(project_id, employee_id, request)
    )


@router.post(
    "/api/v1/management/projects/{project_id}/teams/{team_id}/employees",
    response_model=MembershipResponse,
)
def add_employee_to_team(
    project_id: str,
    team_id: str,
    request: TeamEmployeeRequest,
    service: MembershipService = Depends(get_membership_service),
):
    return run_with_errors(
        lambda: service.add_employee_to_team(
            project_id, team_id, request.employee_id
        )
    )


@router.get(
    "/api/v1/management/projects/{project_id}/teams/{team_id}/employees",
    response_model=list[MembershipResponse],
)
def list_team_employees(
    project_id: str,
    team_id: str,
    service: MembershipService = Depends(get_membership_service),
):
    return run_with_errors(lambda: service.list_team_employees(project_id, team_id))


@router.delete(
    "/api/v1/management/projects/{project_id}/employees/{employee_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_employee(
    project_id: str,
    employee_id: str,
    service: MembershipService = Depends(get_membership_service),
):
    run_with_errors(lambda: service.remove_employee(project_id, employee_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/api/v1/management/projects/{project_id}/teams/{team_id}/employees/{employee_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_employee_from_team(
    project_id: str,
    team_id: str,
    employee_id: str,
    service: MembershipService = Depends(get_membership_service),
):
    run_with_errors(
        lambda: service.remove_employee_from_team(
            project_id, team_id, employee_id
        )
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
