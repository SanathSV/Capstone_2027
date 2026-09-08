"""Integration endpoints."""

from fastapi import APIRouter, status

from app.schemas.common import ErrorResponse
from app.schemas.integration import IntegrationTestRequest, IntegrationTestResponse
from app.services import integration_service

router = APIRouter(prefix="/integrations", tags=["integrations"])


@router.post(
    "/test",
    response_model=IntegrationTestResponse,
    status_code=status.HTTP_200_OK,
    summary="Validate integration credentials",
    responses={422: {"model": ErrorResponse, "description": "Malformed request body"}},
)
async def test_integration(payload: IntegrationTestRequest) -> IntegrationTestResponse:
    """Check a Jira, GitHub or Google Workspace credential.

    Nothing is persisted: the token lives only for the duration of this request
    and is never written to the database or echoed back. A failed check returns
    **200** with `ok: false` — the request itself succeeded, the credential did
    not — so callers branch on `ok`, not on the status code.
    """
    return await integration_service.test_connection(payload)
