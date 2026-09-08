"""Pre-flight check for the Astra database connection.

Run this before starting the API. It verifies the things that fail silently:
a role that bypasses row-level security, a missing schema, or an unseeded
database. Every check prints PASS / FAIL / WARN and the script exits non-zero
if anything is broken.

    cd services/backend
    .venv/Scripts/python.exe scripts/check_db.py
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import settings

EXPECTED_TABLES = {
    "teams",
    "team_members",
    "integrations",
    "meeting_sessions",
    "action_items",
}

SEEDED_TEAM_ID = "a1b2c3d4-0001-4000-8000-000000000001"

failures: list[str] = []
warnings: list[str] = []


def report(ok: bool, label: str, detail: str = "") -> None:
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {label}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def warn(label: str, detail: str) -> None:
    print(f"  [WARN] {label} — {detail}")
    warnings.append(label)


async def main() -> int:
    if "REPLACE_WITH_DB_PASSWORD" in settings.database_url:
        print("DATABASE_URL still contains the placeholder password.")
        print("Edit services/backend/.env line 14 with your Supabase database password.")
        return 1

    # Hide the password when echoing the target back to the user.
    safe_url = settings.database_url
    if "@" in safe_url:
        scheme, rest = safe_url.split("://", 1)
        creds, host = rest.split("@", 1)
        user = creds.split(":", 1)[0]
        safe_url = f"{scheme}://{user}:***@{host}"

    print(f"\nConnecting to {safe_url}\n")

    engine = create_async_engine(settings.database_url, pool_pre_ping=True)

    try:
        async with engine.connect() as conn:
            print("Connection")
            version = (await conn.execute(text("SHOW server_version"))).scalar_one()
            report(True, "Connected", f"PostgreSQL {version}")

            print("\nRow-level security")
            # The single most dangerous misconfiguration: a BYPASSRLS role makes
            # every policy in schema.sql inert, with no error anywhere.
            bypasses = (
                await conn.execute(
                    text("SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user")
                )
            ).scalar_one()
            report(
                not bypasses,
                "Role does not bypass RLS",
                "THIS ROLE BYPASSES RLS — tenant isolation is disabled" if bypasses else "",
            )

            print("\nSchema")
            rows = (
                await conn.execute(
                    text(
                        "SELECT tablename FROM pg_tables "
                        "WHERE schemaname = 'public' AND tablename = ANY(:names)"
                    ),
                    {"names": sorted(EXPECTED_TABLES)},
                )
            ).scalars()
            found = set(rows)
            missing = EXPECTED_TABLES - found

            report(
                not missing,
                f"All {len(EXPECTED_TABLES)} tables present",
                f"missing: {', '.join(sorted(missing))}" if missing else "",
            )

            if missing:
                print("\n  Apply migrations/schema.sql in the Supabase SQL Editor.")
                return 1

            policy_count = (
                await conn.execute(
                    text("SELECT count(*) FROM pg_policies WHERE schemaname = 'public'")
                )
            ).scalar_one()
            report(
                policy_count >= len(EXPECTED_TABLES),
                f"{policy_count} RLS policies installed",
            )

            print("\nSeed data")
            # Scope the transaction the way the API does, then count what is visible.
            await conn.execute(
                text("SELECT set_config('app.current_team_id', :tid, false)"),
                {"tid": SEEDED_TEAM_ID},
            )
            team = (
                await conn.execute(
                    text("SELECT name FROM teams WHERE id = :tid"), {"tid": SEEDED_TEAM_ID}
                )
            ).scalar_one_or_none()

            if team is None:
                warn("Seed team not found", "run migrations/seed.sql for demo data")
            else:
                report(True, "Seed team visible", team)

                members = (
                    await conn.execute(text("SELECT count(*) FROM team_members"))
                ).scalar_one()
                sessions = (
                    await conn.execute(text("SELECT count(*) FROM meeting_sessions"))
                ).scalar_one()
                report(members > 0, f"{members} roster members")
                report(sessions > 0, f"{sessions} meeting sessions")

                print("\nTenant isolation")
                # Scope to a team that does not exist; every table must read empty.
                await conn.execute(
                    text(
                        "SELECT set_config('app.current_team_id', "
                        "'00000000-0000-4000-8000-000000000000', false)"
                    )
                )
                leaked = (
                    await conn.execute(text("SELECT count(*) FROM meeting_sessions"))
                ).scalar_one()
                report(
                    leaked == 0,
                    "Foreign tenant sees no rows",
                    f"LEAKED {leaked} rows" if leaked else "",
                )

    except Exception as exc:  # noqa: BLE001 - surface any driver error readably
        print(f"  [FAIL] {exc.__class__.__name__}: {exc}")
        print(
            "\n  If this timed out: Supabase direct connections are IPv6-only on newer\n"
            "  projects. Use the Session pooler string (port 5432) from the same page."
        )
        return 1
    finally:
        await engine.dispose()

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: {', '.join(failures)}")
        return 1

    print("All checks passed." + (f" {len(warnings)} warning(s)." if warnings else ""))
    print("Start the API with:  uvicorn app.main:app --reload --port 8000")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
