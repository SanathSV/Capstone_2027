import boto3
from boto3.resources.base import ServiceResource

from app.core.config import get_settings


def get_dynamodb_resource() -> ServiceResource:
    settings = get_settings()
    if settings.aws_region:
        return boto3.resource("dynamodb", region_name=settings.aws_region)
    return boto3.resource("dynamodb")


def get_employees_table():
    settings = get_settings()
    return get_dynamodb_resource().Table(settings.dynamodb_employees_table)


def get_projects_table():
    settings = get_settings()
    if not settings.dynamodb_projects_table:
        raise RuntimeError("DYNAMODB_PROJECTS_TABLE must be configured")
    return get_dynamodb_resource().Table(settings.dynamodb_projects_table)
