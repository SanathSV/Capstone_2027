# Astra Backend

FastAPI + Pydantic v2 + SQLAlchemy 2.0 (async, asyncpg). Runs on port 8000.

## Setup

```bash
cp .env.example .env
python -m venv .venv && source .venv/Scripts/activate   # PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
psql "$DATABASE_URL" -f migrations/schema.sql -f migrations/seed.sql
uvicorn app.main:app --reload --port 8000
```

Interactive docs: http://localhost:8000/docs

## Layering

`api/` handles HTTP and nothing else, `services/` holds the logic, `models/` the
ORM tables, `schemas/` the Pydantic contracts. Routes never touch the ORM directly.

## Tenancy

Every table is protected by PostgreSQL row-level security keyed on `team_id`.
Each request opens a transaction with `SET LOCAL app.current_team_id`, so a
query that forgets its `WHERE team_id = ...` returns nothing instead of another
team's rows. Routes without a team in the path take an `X-Team-Id` header.

**The database role must not have `BYPASSRLS`** — with it, the policies are
inert and isolation is silently gone.

## Seeded team

`migrations/seed.sql` creates two tenants. The dashboard reads the first:

| Team          | UUID                                   |
| ------------- | -------------------------------------- |
| Capstone Core | `a1b2c3d4-0001-4000-8000-000000000001` |

```bash
curl localhost:8000/api/v1/teams/a1b2c3d4-0001-4000-8000-000000000001
curl -H "X-Team-Id: a1b2c3d4-0001-4000-8000-000000000001" \
     localhost:8000/api/v1/sessions/active
```
