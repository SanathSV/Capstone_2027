from datetime import datetime, timezone
from typing import Any

from app.models.employee import (
    AgentHeartbeatRequest,
    AgentRegisterRequest,
    Employee,
    EmployeeCreate,
    EmployeePage,
    EmployeePatch,
)
from app.repositories.employee_repository import EmployeeRepository


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class EmployeeNotFoundError(Exception):
    pass


class EmployeeService:
    def __init__(self, repository: EmployeeRepository):
        self.repository = repository

    def create(self, request: EmployeeCreate) -> Employee:
        timestamp = iso_timestamp(utc_now())
        item = request.model_dump(mode="json")
        item.update(
            {
                "employment_status": "ACTIVE",
                "agent": {
                    "device_id": None,
                    "agent_version": None,
                    "os": None,
                    "status": "UNKNOWN",
                    "last_heartbeat": None,
                },
                "created_at": timestamp,
                "updated_at": timestamp,
            }
        )
        return Employee.model_validate(self.repository.create(item))

    def get(self, employee_id: str) -> Employee:
        item = self.repository.get(employee_id)
        if item is None:
            raise EmployeeNotFoundError
        return Employee.model_validate(item)

    def list(self, limit: int, next_token: str | None) -> EmployeePage:
        start_key = self.repository.decode_key(next_token)
        items, last_key = self.repository.list(limit, start_key)
        return EmployeePage(
            items=[Employee.model_validate(item) for item in items],
            next_token=self.repository.encode_key(last_key),
        )

    def update(self, employee_id: str, request: EmployeePatch) -> Employee:
        fields = request.model_dump(exclude_unset=True, mode="json")
        fields["updated_at"] = iso_timestamp(utc_now())
        item = self.repository.update(employee_id, fields)
        if item is None:
            raise EmployeeNotFoundError
        return Employee.model_validate(item)

    def register_agent(self, request: AgentRegisterRequest) -> Employee:
        employee = self.get(request.employee_id)
        agent = employee.agent.model_dump(mode="json")
        agent.update(
            {
                "device_id": request.device_id,
                "agent_version": request.agent_version,
                "os": request.os,
            }
        )
        item = self.repository.update(
            request.employee_id,
            {
                "agent": agent,
                "updated_at": iso_timestamp(utc_now()),
            },
        )
        if item is None:
            raise EmployeeNotFoundError
        return Employee.model_validate(item)

    def heartbeat(self, request: AgentHeartbeatRequest) -> Employee:
        current = self.repository.find_by_device_id(request.device_id)
        if current is None:
            raise EmployeeNotFoundError
        agent = current.get("agent", {})
        agent.update(
            {
                "device_id": request.device_id,
                "agent_version": request.agent_version,
                "status": "ONLINE",
                "last_heartbeat": iso_timestamp(request.timestamp),
            }
        )
        item = self.repository.update(
            current["employee_id"],
            {
                "agent": agent,
                "updated_at": iso_timestamp(utc_now()),
            },
        )
        if item is None:
            raise EmployeeNotFoundError
        return Employee.model_validate(item)
