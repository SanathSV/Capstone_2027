import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.dynamodb import get_employees_table
from app.models.employee import (
    AgentHeartbeatRequest,
    AgentRegisterRequest,
    Employee,
    EmployeeCreate,
    EmployeePage,
    EmployeePatch,
)
from app.repositories.employee_repository import (
    EmployeeAlreadyExistsError,
    EmployeeRepository,
    EmployeeRepositoryValidationError,
    EmployeeTableUnavailableError,
)
from app.services.employee_service import EmployeeNotFoundError, EmployeeService

logger = logging.getLogger(__name__)
router = APIRouter()


def get_employee_service() -> EmployeeService:
    return EmployeeService(EmployeeRepository(get_employees_table()))


def handle_repository_error(error: Exception) -> None:
    if isinstance(error, EmployeeRepositoryValidationError):
        raise HTTPException(status_code=400, detail=str(error)) from error
    if isinstance(error, EmployeeTableUnavailableError):
        raise HTTPException(
            status_code=503, detail="Employee database is unavailable"
        ) from error
    raise error


@router.post(
    "/api/v1/management/employees",
    response_model=Employee,
    status_code=status.HTTP_201_CREATED,
)
def create_employee(
    request: EmployeeCreate,
    service: EmployeeService = Depends(get_employee_service),
):
    try:
        employee = service.create(request)
    except EmployeeAlreadyExistsError as error:
        raise HTTPException(status_code=409, detail="Employee already exists") from error
    except (EmployeeRepositoryValidationError, EmployeeTableUnavailableError) as error:
        handle_repository_error(error)
    logger.info("employee_created", extra={"employee_id": employee.employee_id})
    return employee


@router.get(
    "/api/v1/management/employees/{employee_id}",
    response_model=Employee,
)
def get_employee(
    employee_id: str,
    service: EmployeeService = Depends(get_employee_service),
):
    try:
        return service.get(employee_id)
    except EmployeeNotFoundError as error:
        raise HTTPException(status_code=404, detail="Employee not found") from error
    except (EmployeeRepositoryValidationError, EmployeeTableUnavailableError) as error:
        handle_repository_error(error)


@router.get("/api/v1/management/employees", response_model=EmployeePage)
def list_employees(
    limit: int = Query(default=25, ge=1, le=100),
    next_token: str | None = None,
    service: EmployeeService = Depends(get_employee_service),
):
    try:
        return service.list(limit, next_token)
    except (EmployeeRepositoryValidationError, EmployeeTableUnavailableError) as error:
        handle_repository_error(error)


@router.patch(
    "/api/v1/management/employees/{employee_id}",
    response_model=Employee,
)
def update_employee(
    employee_id: str,
    request: EmployeePatch,
    service: EmployeeService = Depends(get_employee_service),
):
    try:
        return service.update(employee_id, request)
    except EmployeeNotFoundError as error:
        raise HTTPException(status_code=404, detail="Employee not found") from error
    except (EmployeeRepositoryValidationError, EmployeeTableUnavailableError) as error:
        handle_repository_error(error)


@router.post("/api/v1/agent/register", response_model=Employee)
def register_agent(
    request: AgentRegisterRequest,
    service: EmployeeService = Depends(get_employee_service),
):
    try:
        employee = service.register_agent(request)
    except EmployeeNotFoundError as error:
        raise HTTPException(status_code=404, detail="Employee not found") from error
    except (EmployeeRepositoryValidationError, EmployeeTableUnavailableError) as error:
        handle_repository_error(error)
    logger.info("agent_registered", extra={"employee_id": request.employee_id})
    return employee


@router.post("/api/v1/agent/heartbeat", response_model=Employee)
def heartbeat(
    request: AgentHeartbeatRequest,
    service: EmployeeService = Depends(get_employee_service),
):
    try:
        employee = service.heartbeat(request)
    except EmployeeNotFoundError as error:
        raise HTTPException(status_code=404, detail="Agent device not registered") from error
    except (EmployeeRepositoryValidationError, EmployeeTableUnavailableError) as error:
        handle_repository_error(error)
    logger.info("agent_heartbeat", extra={"device_id": request.device_id})
    return employee
