# Astra

AI meeting assistant for Google Meet.

| Path                  | Stack                                  | Port |
| --------------------- | -------------------------------------- | ---- |
| `apps/web/`           | Next.js 14, Tailwind, TypeScript        | 3000 |
| `services/backend/`   | FastAPI, Pydantic v2, SQLAlchemy async  | 8000 |
| `services/bot/`       | Playwright (Python), headless Chromium  | —    |
| `packages/extension/` | Chrome Manifest V3                      | —    |

Data: PostgreSQL (Supabase) + Redis (Upstash).

See [CLAUDE.md](CLAUDE.md) for the stack rules and per-directory READMEs for setup.
