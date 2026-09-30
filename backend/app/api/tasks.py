from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.dynamodb import (
    get_employees_table,
    get_project_memberships_table,
    get_project_state_table,
    get_projects_table,
)
from app.models.task import CreateTaskRequest, TaskListResponse, TaskResponse, UpdateTaskRequest
from app.repositories.employee_repository import EmployeeRepository
from app.repositories.membership_repository import MembershipRepository
from app.repositories.project_repository import ProjectRepository
from app.repositories.task_repository import (
    TaskAlreadyExistsError,
    TaskRepositoryValidationError,
    TaskRepository,
    TaskTableUnavailableError,
)
from app.services.task_service import (
    TaskAssigneeNotInTeamError,
    TaskDependencyUnavailableError,
    TaskEmployeeNotFoundError,
    TaskMembershipNotFoundError,
    TaskNotFoundError,
    TaskProjectNotFoundError,
    TaskProtectedFieldError,
    TaskService,
    TaskTeamNotFoundError,
)

router = APIRouter()


def get_task_service() -> TaskService:
    return TaskService(
        task_repository=TaskRepository(get_project_state_table()),
        project_repository=ProjectRepository(get_projects_table()),
        employee_repository=EmployeeRepository(get_employees_table()),
        membership_repository=MembershipRepository(get_project_memberships_table()),
    )


def handle_task_error(error: Exception) -> None:
    if isinstance(error, TaskDependencyUnavailableError):
        raise HTTPException(status_code=503, detail="A required Astra database is unavailable") from error
    if isinstance(error, TaskRepositoryValidationError):
        raise HTTPException(status_code=400, detail=str(error)) from error
    if isinstance(error, TaskTableUnavailableError):
        raise HTTPException(status_code=503, detail="Task database is unavailable") from error
    raise error


def run_task_operation(operation):
    try:
        return operation()
    except TaskProjectNotFoundError as error:
        raise HTTPException(status_code=404, detail="Project not found") from error
    except TaskEmployeeNotFoundError as error:
        raise HTTPException(status_code=404, detail="Employee not found") from error
    except TaskTeamNotFoundError as error:
        raise HTTPException(status_code=404, detail="Team not found") from error
    except TaskMembershipNotFoundError as error:
        raise HTTPException(status_code=400, detail="Employee is not a member of this project") from error
    except TaskAssigneeNotInTeamError as error:
        raise HTTPException(status_code=400, detail="Assignee is not a member of this team") from error
    except TaskNotFoundError as error:
        raise HTTPException(status_code=404, detail="Task not found") from error
    except TaskProtectedFieldError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except TaskAlreadyExistsError as error:
        raise HTTPException(status_code=409, detail="Task already exists") from error
    except (TaskDependencyUnavailableError, TaskRepositoryValidationError, TaskTableUnavailableError) as error:
        handle_task_error(error)


@router.post(
    "/api/v1/management/projects/{project_id}/tasks",
    response_model=TaskResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_task(project_id: str, request: CreateTaskRequest, service: TaskService = Depends(get_task_service)):
    return run_task_operation(lambda: service.create(project_id, request))


@router.get(
    "/api/v1/management/projects/{project_id}/tasks",
    response_model=TaskListResponse,
)
def list_project_tasks(
    project_id: str,
    limit: int = Query(default=25, ge=1, le=100),
    next_token: str | None = None,
    service: TaskService = Depends(get_task_service),
):
    return run_task_operation(lambda: service.list_project_tasks(project_id, limit, next_token))


@router.get(
    "/api/v1/management/projects/{project_id}/tasks/{task_id}",
    response_model=TaskResponse,
)
def get_task(project_id: str, task_id: str, service: TaskService = Depends(get_task_service)):
    return run_task_operation(lambda: service.get(project_id, task_id))


@router.patch(
    "/api/v1/management/projects/{project_id}/tasks/{task_id}",
    response_model=TaskResponse,
)
def update_task(
    project_id: str,
    task_id: str,
    request: UpdateTaskRequest,
    service: TaskService = Depends(get_task_service),
):
    return run_task_operation(lambda: service.update(project_id, task_id, request))


@router.get(
    "/api/v1/management/employees/{employee_id}/tasks",
    response_model=TaskListResponse,
)
def list_employee_tasks(
    employee_id: str,
    limit: int = Query(default=25, ge=1, le=100),
    next_token: str | None = None,
    project_id: str | None = None,
    task_status: str | None = Query(default=None, alias="status"),
    priority: str | None = None,
    service: TaskService = Depends(get_task_service),
):
    return run_task_operation(
        lambda: service.list_employee_tasks(
            employee_id, limit, next_token, project_id, task_status, priority
        )
    )


@router.get(
    "/api/v1/management/projects/{project_id}/teams/{team_id}/tasks",
    response_model=TaskListResponse,
)
def list_team_tasks(
    project_id: str,
    team_id: str,
    limit: int = Query(default=25, ge=1, le=100),
    next_token: str | None = None,
    service: TaskService = Depends(get_task_service),
):
    return run_task_operation(
        lambda: service.list_team_tasks(project_id, team_id, limit, next_token)
    )
