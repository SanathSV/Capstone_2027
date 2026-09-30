#!/usr/bin/env python3
"""Exercise the ASTRA Employee, Project, Team, and Membership APIs."""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class ApiLogger:
    def __init__(self, log_path: Path):
        self.log_path = log_path
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self.file = log_path.open("w", encoding="utf-8")

    def write(self, message: str = "") -> None:
        print(message)
        self.file.write(f"{message}\n")
        self.file.flush()

    def close(self) -> None:
        self.file.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:8003",
        help="API base URL, for example the local URL or API Gateway Prod URL",
    )
    parser.add_argument(
        "--log-file",
        type=Path,
        help="Output log path; defaults to logs/api_test_<timestamp>.log",
    )
    return parser.parse_args()


def compact_body(body: object) -> str:
    return json.dumps(body, ensure_ascii=True, sort_keys=True, default=str)


def call_api(
    logger: ApiLogger,
    base_url: str,
    method: str,
    path: str,
    payload: dict | None = None,
) -> tuple[int | None, object | None]:
    url = f"{base_url.rstrip('/')}{path}"
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = Request(url, data=body, headers=headers, method=method)
    started = time.perf_counter()
    try:
        with urlopen(request, timeout=30) as response:
            status_code = response.status
            raw_body = response.read().decode("utf-8")
    except HTTPError as error:
        status_code = error.code
        raw_body = error.read().decode("utf-8", errors="replace")
    except (URLError, TimeoutError, OSError) as error:
        elapsed_ms = (time.perf_counter() - started) * 1000
        logger.write(f"{method} {url}")
        logger.write(f"STATUS: CONNECTION_ERROR | TIME_MS: {elapsed_ms:.1f}")
        logger.write(f"ERROR: {error}")
        logger.write()
        return None, None

    elapsed_ms = (time.perf_counter() - started) * 1000
    try:
        response_body: object = json.loads(raw_body) if raw_body else None
    except json.JSONDecodeError:
        response_body = raw_body

    logger.write(f"{method} {url}")
    logger.write(f"STATUS: {status_code} | TIME_MS: {elapsed_ms:.1f}")
    logger.write(f"RESPONSE: {compact_body(response_body)}")
    logger.write()
    return status_code, response_body


def main() -> int:
    args = parse_args()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    log_path = args.log_file or Path("logs") / f"api_test_{timestamp}.log"
    logger = ApiLogger(log_path)
    suffix = timestamp[-10:]
    employee_id = f"EMP_TEST_{suffix}"
    second_employee_id = f"EMP_TEST_2_{suffix}"
    project_id = f"PROJ_TEST_{suffix}"
    team_one_id = f"TEAM_TEST_1_{suffix}"
    team_two_id = f"TEAM_TEST_2_{suffix}"
    device_id = f"DEVICE_TEST_{suffix}"
    base_url = args.base_url.rstrip("/")

    logger.write(f"ASTRA API endpoint test started: {timestamp}")
    logger.write(f"BASE_URL: {base_url}")
    logger.write(f"LOG_FILE: {log_path}")
    logger.write(f"TEST_IDS: {employee_id}, {project_id}, {team_one_id}, {team_two_id}")
    logger.write()

    try:
        employee_payload = {
            "employee_id": employee_id,
            "name": "ASTRA Test Employee",
            "email": f"{employee_id.lower()}@example.com",
            "role": "Software Engineer",
            "department": "Engineering",
            "manager_id": None,
        }
        second_employee_payload = {
            **employee_payload,
            "employee_id": second_employee_id,
            "email": f"{second_employee_id.lower()}@example.com",
        }

        call_api(logger, base_url, "POST", "/api/v1/management/employees", employee_payload)
        call_api(logger, base_url, "POST", "/api/v1/management/employees", second_employee_payload)
        call_api(logger, base_url, "GET", f"/api/v1/management/employees/{employee_id}")
        call_api(logger, base_url, "GET", "/api/v1/management/employees?limit=10")
        call_api(
            logger,
            base_url,
            "PATCH",
            f"/api/v1/management/employees/{employee_id}",
            {"name": "ASTRA Updated Test Employee", "employment_status": "ACTIVE"},
        )
        call_api(
            logger,
            base_url,
            "POST",
            "/api/v1/agent/register",
            {
                "employee_id": employee_id,
                "device_id": device_id,
                "agent_version": "1.0.0-test",
                "os": "macos",
            },
        )
        call_api(
            logger,
            base_url,
            "POST",
            "/api/v1/agent/heartbeat",
            {
                "device_id": device_id,
                "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "agent_version": "1.0.1-test",
            },
        )

        call_api(
            logger,
            base_url,
            "POST",
            "/api/v1/management/projects",
            {
                "project_id": project_id,
                "name": "ASTRA Endpoint Test Project",
                "description": "Created by the API smoke-test script",
                "status": "ACTIVE",
                "owner_employee_id": employee_id,
                "department": "Engineering",
            },
        )
        call_api(logger, base_url, "GET", f"/api/v1/management/projects/{project_id}")
        call_api(logger, base_url, "GET", "/api/v1/management/projects?limit=10")
        call_api(
            logger,
            base_url,
            "PATCH",
            f"/api/v1/management/projects/{project_id}",
            {"description": "Updated by the API smoke-test script"},
        )

        team_payload = {
            "team_id": team_one_id,
            "name": "ASTRA Test Backend Team",
            "description": "Created by the API smoke-test script",
            "team_lead_id": employee_id,
        }
        call_api(
            logger,
            base_url,
            "POST",
            f"/api/v1/management/projects/{project_id}/teams",
            team_payload,
        )
        call_api(
            logger,
            base_url,
            "POST",
            f"/api/v1/management/projects/{project_id}/teams",
            {**team_payload, "team_id": team_two_id, "name": "ASTRA Test Platform Team"},
        )
        call_api(logger, base_url, "GET", f"/api/v1/management/projects/{project_id}/teams")
        call_api(
            logger,
            base_url,
            "GET",
            f"/api/v1/management/projects/{project_id}/teams/{team_one_id}",
        )
        call_api(
            logger,
            base_url,
            "PATCH",
            f"/api/v1/management/projects/{project_id}/teams/{team_one_id}",
            {"name": "ASTRA Updated Backend Team", "status": "ACTIVE"},
        )

        call_api(
            logger,
            base_url,
            "POST",
            f"/api/v1/management/projects/{project_id}/employees",
            {
                "employee_id": employee_id,
                "team_id": team_one_id,
                "role": "Software Engineer",
                "allocation_percentage": 100,
            },
        )
        call_api(
            logger,
            base_url,
            "POST",
            f"/api/v1/management/projects/{project_id}/employees",
            {
                "employee_id": second_employee_id,
                "team_id": None,
                "role": "Product Engineer",
                "allocation_percentage": 50,
            },
        )
        call_api(logger, base_url, "GET", f"/api/v1/management/projects/{project_id}/employees")
        call_api(
            logger,
            base_url,
            "GET",
            f"/api/v1/management/employees/{employee_id}/projects",
        )
        call_api(
            logger,
            base_url,
            "PATCH",
            f"/api/v1/management/projects/{project_id}/employees/{employee_id}",
            {"team_id": team_two_id, "allocation_percentage": 80},
        )
        call_api(
            logger,
            base_url,
            "POST",
            f"/api/v1/management/projects/{project_id}/teams/{team_two_id}/employees",
            {"employee_id": second_employee_id},
        )
        call_api(
            logger,
            base_url,
            "GET",
            f"/api/v1/management/projects/{project_id}/teams/{team_two_id}/employees",
        )
        call_api(
            logger,
            base_url,
            "DELETE",
            f"/api/v1/management/projects/{project_id}/teams/{team_two_id}/employees/{employee_id}",
        )
        call_api(
            logger,
            base_url,
            "DELETE",
            f"/api/v1/management/projects/{project_id}/employees/{employee_id}",
        )

        logger.write("TEST COMPLETE")
        logger.write(f"Full output saved to: {log_path}")
        return 0
    finally:
        logger.close()


if __name__ == "__main__":
    sys.exit(main())
