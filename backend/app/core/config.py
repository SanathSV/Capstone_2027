import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    dynamodb_employees_table: str
    dynamodb_projects_table: str | None = None
    aws_region: str | None = None


def get_settings() -> Settings:
    table_name = os.getenv("DYNAMODB_EMPLOYEES_TABLE")
    if not table_name:
        raise RuntimeError("DYNAMODB_EMPLOYEES_TABLE must be configured")
    return Settings(
        dynamodb_employees_table=table_name,
        dynamodb_projects_table=os.getenv("DYNAMODB_PROJECTS_TABLE"),
        aws_region=os.getenv("AWS_REGION"),
    )
