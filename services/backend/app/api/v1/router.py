"""Aggregates every v1 route module."""

from fastapi import APIRouter

from app.api.v1 import health, integrations, sessions, teams

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(teams.router)
api_router.include_router(integrations.router)
api_router.include_router(sessions.router)
