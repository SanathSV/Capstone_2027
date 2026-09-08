"""Astra backend entrypoint."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from app.api.v1.router import api_router
from app.core.config import settings
from app.core.openapi import (
    API_DESCRIPTION,
    API_TITLE,
    API_VERSION,
    CONTACT,
    LICENSE_INFO,
    TAGS_METADATA,
)
from app.db.session import engine


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Dispose the connection pool on shutdown so reloads do not leak sockets."""
    yield
    await engine.dispose()


app = FastAPI(
    title=API_TITLE,
    version=API_VERSION,
    description=API_DESCRIPTION,
    openapi_tags=TAGS_METADATA,
    contact=CONTACT,
    license_info=LICENSE_INFO,
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    # Extension ids are unknown until the unpacked build is loaded, so allow any
    # chrome-extension:// origin in development only.
    allow_origin_regex=r"chrome-extension://.*" if settings.is_development else None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Team-Id"],
)


@app.exception_handler(SQLAlchemyError)
async def database_error_handler(_: Request, exc: SQLAlchemyError) -> JSONResponse:
    """Return a clean 503 rather than leaking a driver traceback.

    A dashboard hitting this API before Postgres is up should see a readable
    message, not an asyncpg stack trace.
    """
    detail = (
        f"Database unavailable: {exc.__class__.__name__}"
        if settings.is_development
        else "Database unavailable."
    )
    return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"detail": detail})


app.include_router(api_router, prefix=settings.api_v1_prefix)


@app.get("/", include_in_schema=False)
async def root() -> dict[str, str]:
    return {"service": "astra-backend", "version": API_VERSION, "docs": "/docs"}
