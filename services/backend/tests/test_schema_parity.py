"""Guards the ORM against drift from migrations/schema.sql.

The SQL file is the source of truth — it is what actually runs against Postgres.
These tests parse it and assert the declarative models describe the same tables
and columns, so a column added on one side and forgotten on the other fails here
rather than at runtime.
"""

import re
from pathlib import Path

import pytest

from app.models import Base

SCHEMA_SQL = Path(__file__).resolve().parents[1] / "migrations" / "schema.sql"

# Line noise inside a CREATE TABLE body that is not a column definition.
NON_COLUMN_KEYWORDS = {"CONSTRAINT", "CHECK", "PRIMARY", "FOREIGN", "UNIQUE", "EXCLUDE", "LIKE"}


def _strip_comments(sql: str) -> str:
    return "\n".join(line.split("--")[0] for line in sql.splitlines())


def _table_body(sql: str, table: str) -> str:
    """Return the text between the parentheses of a table's CREATE statement."""
    match = re.search(
        rf"CREATE TABLE IF NOT EXISTS {table}\s*\(", sql, flags=re.IGNORECASE
    )
    if match is None:
        pytest.fail(f"schema.sql declares no table named {table!r}")

    depth = 0
    start = match.end()
    for index in range(start - 1, len(sql)):
        if sql[index] == "(":
            depth += 1
        elif sql[index] == ")":
            depth -= 1
            if depth == 0:
                return sql[start:index]

    pytest.fail(f"Unbalanced parentheses in the {table!r} definition")


def _split_top_level(body: str) -> list[str]:
    """Split a table body on commas that are not nested inside parentheses."""
    parts: list[str] = []
    depth = 0
    current: list[str] = []

    for char in body:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1

        if char == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)

    parts.append("".join(current))
    return parts


def sql_columns(table: str) -> set[str]:
    sql = _strip_comments(SCHEMA_SQL.read_text(encoding="utf-8"))
    columns: set[str] = set()

    for part in _split_top_level(_table_body(sql, table)):
        tokens = part.split()
        if not tokens:
            continue
        if tokens[0].upper() in NON_COLUMN_KEYWORDS:
            continue
        columns.add(tokens[0])

    return columns


ORM_TABLES = sorted(Base.metadata.tables)


def test_schema_sql_is_present() -> None:
    assert SCHEMA_SQL.is_file()


def test_every_expected_table_is_modelled() -> None:
    assert set(ORM_TABLES) == {
        "teams",
        "team_members",
        "integrations",
        "meeting_sessions",
        "action_items",
    }


@pytest.mark.parametrize("table_name", ORM_TABLES)
def test_orm_columns_match_sql(table_name: str) -> None:
    """Every ORM column exists in the SQL, and vice versa."""
    orm = {column.name for column in Base.metadata.tables[table_name].columns}
    sql = sql_columns(table_name)

    assert orm - sql == set(), f"{table_name}: in the ORM but not in schema.sql"
    assert sql - orm == set(), f"{table_name}: in schema.sql but not in the ORM"


@pytest.mark.parametrize("table_name", ORM_TABLES)
def test_every_table_has_row_level_security(table_name: str) -> None:
    """A table without a policy would be readable across tenants."""
    sql = SCHEMA_SQL.read_text(encoding="utf-8")

    assert re.search(rf"ALTER TABLE {table_name}\s+ENABLE ROW LEVEL SECURITY", sql)
    assert re.search(rf"ALTER TABLE {table_name}\s+FORCE ROW LEVEL SECURITY", sql)
    assert re.search(rf"CREATE POLICY {table_name}_tenant_isolation ON {table_name}", sql)


def test_policies_scope_on_the_current_team() -> None:
    """Both USING and WITH CHECK must reference the tenant function.

    USING alone would filter reads while still allowing a write that plants a
    row under another team's id.
    """
    sql = _strip_comments(SCHEMA_SQL.read_text(encoding="utf-8"))
    policy_blocks = re.findall(r"CREATE POLICY .*?;", sql, flags=re.DOTALL)

    assert len(policy_blocks) == len(ORM_TABLES)
    for block in policy_blocks:
        assert "USING" in block
        assert "WITH CHECK" in block
        assert block.count("app_current_team_id()") == 2
