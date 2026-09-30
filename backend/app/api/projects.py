import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.dynamodb import get_employees_table, get_projects_table
from app.models.project import (
    ProjectCreateRequest,
    ProjectPage,
    ProjectResponse,
    ProjectUpdateRequest,
)
from app.repositories.employee_repository import EmployeeRepository
from app.repositories.project_repository import (
    ProjectAlreadyExistsError,
    ProjectRepository,
    ProjectRepositoryValidationError,
    ProjectTableUnavailableError,
)
from app.services.project_service import (
    ProjectEmployeeTableUnavailableError,
    ProjectEmployeeValidationError,
    ProjectNotFoundError,
    ProjectOwnerNotFoundError,
    ProjectService,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def get_project_service() -> ProjectService:
    return ProjectService(
        project_repository=ProjectRepository(get_projects_table()),
        employee_repository=EmployeeRepository(get_employees_table()),
    )


def handle_project_repository_error(error: Exception) -> None:
    if isinstance(error, ProjectRepositoryValidationError):
        raise HTTPException(status_code=400, detail=str(error)) from error
    if isinstance(error, ProjectTableUnavailableError):
        raise HTTPException(
            status_code=503, detail="Project database is unavailable"
        ) from error
    if isinstance(error, ProjectEmployeeTableUnavailableError):
        raise HTTPException(
            status_code=503, detail="Employee database is unavailable"
        ) from error
    if isinstance(error, ProjectEmployeeValidationError):
        raise HTTPException(status_code=400, detail=str(error)) from error
    raise error


@router.post(
    "/api/v1/management/projects",
    response_model=ProjectResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_project(
    request: ProjectCreateRequest,
    service: ProjectService = Depends(get_project_service),
):
    try:
        project = service.create(request)
    except ProjectAlreadyExistsError as error:
        raise HTTPException(status_code=409, detail="Project already exists") from error
    except ProjectOwnerNotFoundError as error:
        raise HTTPException(
            status_code=404, detail="Owner employee not found"
        ) from error
    except (
        ProjectRepositoryValidationError,
        ProjectTableUnavailableError,
        ProjectEmployeeTableUnavailableError,
        ProjectEmployeeValidationError,
    ) as error:
        handle_project_repository_error(error)
    logger.info("project_created", extra={"project_id": project.project_id})
    return project


@router.get(
    "/api/v1/management/projects/{project_id}",
    response_model=ProjectResponse,
)
def get_project(
    project_id: str,
    service: ProjectService = Depends(get_project_service),
):
    try:
        return service.get(project_id)
    except ProjectNotFoundError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except (ProjectRepositoryValidationError, ProjectTableUnavailableError) as error:
        handle_project_repository_error(error)


@router.get("/api/v1/management/projects", response_model=ProjectPage)
def list_projects(
    limit: int = Query(default=25, ge=1, le=100),
    next_token: str | None = None,
    service: ProjectService = Depends(get_project_service),
):
    try:
        return service.list(limit, next_token)
    except (ProjectRepositoryValidationError, ProjectTableUnavailableError) as error:
        handle_project_repository_error(error)


@router.patch(
    "/api/v1/management/projects/{project_id}",
    response_model=ProjectResponse,
)
def update_project(
    project_id: str,
    request: ProjectUpdateRequest,
    service: ProjectService = Depends(get_project_service),
):
    try:
        return service.update(project_id, request)
    except ProjectNotFoundError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except ProjectOwnerNotFoundError as error:
        raise HTTPException(
            status_code=404, detail="Owner employee not found"
        ) from error
    except (
        ProjectRepositoryValidationError,
        ProjectTableUnavailableError,
        ProjectEmployeeTableUnavailableError,
        ProjectEmployeeValidationError,
    ) as error:
        handle_project_repository_error(error)
