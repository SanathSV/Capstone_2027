# Astra — AI Meeting Assistant for Google Meet

Monorepo. Four deployables, no shared runtime between them.

| Path                  | What it is                          | Port |
| --------------------- | ----------------------------------- | ---- |
| `apps/web/`           | Next.js 14 dashboard                | 3000 |
| `services/backend/`   | FastAPI API                         | 8000 |
| `packages/extension/` | Manifest V3 Chrome extension        | —    |
| `services/bot/`       | Playwright headless Chromium bot    | —    |

## Tech stack rules

1. **Web** — Next.js 14 (App Router only, no `pages/`), TypeScript strict, Tailwind CSS.
   Server Components by default; `"use client"` only where interactivity requires it.
   Talks to the backend via `NEXT_PUBLIC_API_URL`. Runs on port 3000.
2. **Backend** — FastAPI, Python 3.11+, Uvicorn, Pydantic v2, SQLAlchemy 2.0 async + asyncpg.
   Runs on port 8000. CORS allows `http://localhost:3000` and `chrome-extension://<id>` origins.
   Routes stay thin: `api/` handles HTTP, `services/` holds logic, `models/` holds ORM tables,
   `schemas/` holds Pydantic models. Never mix the layers.
3. **Bot** — Playwright for Python, headless Chromium. Joins Meet, captures audio/captions,
   posts results back to the backend. No business logic beyond capture and upload.
4. **DB & Cache** — PostgreSQL via Supabase (`DATABASE_URL`, asyncpg driver) and Redis via
   Upstash (`REDIS_URL`, TLS). All migrations live in `services/backend/migrations/`.
   Every tenant table is under row-level security keyed on `team_id`: requests run inside
   a transaction that sets `app.current_team_id`, and the DB role must not have `BYPASSRLS`.
5. **Extension** — Manifest V3 service worker. No remote code, no `eval`. Minimum permissions.

## Conventions

- Every sub-directory ships a `.env.example`. Never commit a real `.env`.
- Secrets are read from env only — never hardcoded, never sent to the browser unless
  prefixed `NEXT_PUBLIC_`.
- Small, modular files with a single responsibility. Prefer explicit over clever.
- Python: `snake_case`, full type hints, `ruff` formatting. TS: `camelCase` values,
  `PascalCase` components.
- Async everywhere on the backend — no blocking I/O inside request handlers.

## Common commands

```bash
cd apps/web         && npm install && npm run dev        # :3000
cd services/backend && uvicorn app.main:app --reload     # :8000
cd services/bot     && python -m app.main
cd packages/extension && npm install && npm run build    # load dist/ unpacked
```
