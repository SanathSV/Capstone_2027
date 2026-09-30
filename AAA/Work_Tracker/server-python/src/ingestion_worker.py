import json
import os
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key


def float_to_decimal(value):
    if value is None:
        return Decimal("0")
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def get_table():
    table_name = os.environ.get("CDI_TABLE_NAME")
    if not table_name:
        raise RuntimeError("CDI_TABLE_NAME is not configured")
    return boto3.resource("dynamodb").Table(table_name)


def normalize_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("Payload must be an object")

    required = [
        "org_id",
        "user_id",
        "session_id",
        "project_id",
        "task",
        "started_at",
        "ended_at",
        "active_hours",
        "idle_hours",
        "cdi_score",
    ]
    missing = [field for field in required if field not in payload]
    if missing:
        raise ValueError(f"Missing required fields: {', '.join(missing)}")

    return payload


def session_date_key(started_at):
    try:
        dt = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
    except ValueError:
        dt = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d")


def write_session_record(table, payload):
    org_id = str(payload["org_id"]).strip()
    user_id = str(payload["user_id"]).strip()
    session_id = str(payload["session_id"]).strip()
    date_key = session_date_key(str(payload["started_at"]))
    ttl_seconds = 30 * 24 * 60 * 60

    item = {
        "PK": f"ORG#{org_id}",
        "SK": f"USER#{user_id}#SESSION#{session_id}",
        "GSI1_PK": f"USER#{org_id}#{user_id}",
        "GSI1_SK": f"{date_key}#SESSION#{session_id}",
        "type": "session",
        "org_id": org_id,
        "user_id": user_id,
        "session_id": session_id,
        "project_id": str(payload.get("project_id", "default"))[:120],
        "task": str(payload.get("task", ""))[:500],
        "started_at": str(payload.get("started_at")),
        "ended_at": str(payload.get("ended_at")),
        "active_hours": float_to_decimal(payload.get("active_hours", 0)),
        "idle_hours": float_to_decimal(payload.get("idle_hours", 0)),
        "cdi_score": float_to_decimal(payload.get("cdi_score", 0)),
        "commit_count": int(payload.get("commit_count", 0) or 0),
        "additions": int(payload.get("additions", 0) or 0),
        "deletions": int(payload.get("deletions", 0) or 0),
        "commits": payload.get("commits") or [],
        "ttl_timestamp": int(datetime.now(timezone.utc).timestamp()) + ttl_seconds,
    }
    table.put_item(Item=item)


def update_daily_rollup(table, payload):
    org_id = str(payload["org_id"]).strip()
    user_id = str(payload["user_id"]).strip()
    date_key = session_date_key(str(payload["started_at"]))
    session_count = 1
    active_hours = float_to_decimal(payload.get("active_hours", 0))
    cdi_score = float_to_decimal(payload.get("cdi_score", 0))
    commit_count = int(payload.get("commit_count", 0) or 0)
    additions = int(payload.get("additions", 0) or 0)
    deletions = int(payload.get("deletions", 0) or 0)

    key = {
        "PK": f"ORG#{org_id}",
        "SK": f"USER#{user_id}#DAY#{date_key}",
    }
    table.update_item(
        Key=key,
        UpdateExpression=(
            "SET "
            "#type = :type, "
            "#org_id = :org_id, "
            "#user_id = :user_id, "
            "#date_key = :date_key, "
            "#session_count = if_not_exists(#session_count, :zero) + :one, "
            "#total_active_hours = if_not_exists(#total_active_hours, :zero) + :active_hours, "
            "#total_cdi_score = if_not_exists(#total_cdi_score, :zero) + :cdi_score, "
            "#total_commits = if_not_exists(#total_commits, :zero) + :commit_count, "
            "#total_additions = if_not_exists(#total_additions, :zero) + :additions, "
            "#total_deletions = if_not_exists(#total_deletions, :zero) + :deletions, "
            "#avg_cdi_score = ((if_not_exists(#total_cdi_score, :zero) + :cdi_score) / (if_not_exists(#session_count, :zero) + :one)), "
            "GSI1_PK = :gsi1_pk, "
            "GSI1_SK = :gsi1_sk, "
            "ttl_timestamp = :ttl"
        ),
        ExpressionAttributeNames={
            "#type": "type",
            "#org_id": "org_id",
            "#user_id": "user_id",
            "#date_key": "date_key",
            "#session_count": "session_count",
            "#total_active_hours": "total_active_hours",
            "#total_cdi_score": "total_cdi_score",
            "#total_commits": "total_commits",
            "#total_additions": "total_additions",
            "#total_deletions": "total_deletions",
            "#avg_cdi_score": "avg_cdi_score",
        },
        ExpressionAttributeValues={
            ":type": "daily_summary",
            ":org_id": org_id,
            ":user_id": user_id,
            ":date_key": date_key,
            ":zero": Decimal("0"),
            ":one": Decimal(str(session_count)),
            ":active_hours": active_hours,
            ":cdi_score": cdi_score,
            ":commit_count": Decimal(str(commit_count)),
            ":additions": Decimal(str(additions)),
            ":deletions": Decimal(str(deletions)),
            ":gsi1_pk": f"ORG#{org_id}",
            ":gsi1_sk": f"{date_key}#USER#{user_id}",
            ":ttl": int(datetime.now(timezone.utc).timestamp()) + (30 * 24 * 60 * 60),
        },
        ReturnValues='UPDATED_NEW',
    )

    table.update_item(
        Key={
            "PK": f"ORG#{org_id}",
            "SK": f"DAY#{date_key}",
        },
        UpdateExpression=(
            "SET "
            "#type = :type, "
            "#org_id = :org_id, "
            "#date_key = :date_key, "
            "#session_count = if_not_exists(#session_count, :zero) + :one, "
            "#total_active_hours = if_not_exists(#total_active_hours, :zero) + :active_hours, "
            "#total_cdi_score = if_not_exists(#total_cdi_score, :zero) + :cdi_score, "
            "#total_commits = if_not_exists(#total_commits, :zero) + :commit_count, "
            "#avg_cdi_score = ((if_not_exists(#total_cdi_score, :zero) + :cdi_score) / (if_not_exists(#session_count, :zero) + :one)), "
            "GSI1_PK = :gsi1_pk, "
            "GSI1_SK = :gsi1_sk, "
            "ttl_timestamp = :ttl"
        ),
        ExpressionAttributeNames={
            "#type": "type",
            "#org_id": "org_id",
            "#date_key": "date_key",
            "#session_count": "session_count",
            "#total_active_hours": "total_active_hours",
            "#total_cdi_score": "total_cdi_score",
            "#total_commits": "total_commits",
            "#avg_cdi_score": "avg_cdi_score",
        },
        ExpressionAttributeValues={
            ":type": "org_summary",
            ":org_id": org_id,
            ":date_key": date_key,
            ":zero": Decimal("0"),
            ":one": Decimal(str(session_count)),
            ":active_hours": active_hours,
            ":cdi_score": cdi_score,
            ":commit_count": Decimal(str(commit_count)),
            ":gsi1_pk": f"ORG#{org_id}",
            ":gsi1_sk": f"{date_key}",
            ":ttl": int(datetime.now(timezone.utc).timestamp()) + (30 * 24 * 60 * 60),
        },
        ReturnValues='UPDATED_NEW',
    )


def lambda_handler(event, context):
    table = get_table()
    failures = []

    for record in event.get("Records", []):
        try:
            payload = json.loads(record.get("body", "{}"))
            normalized = normalize_payload(payload)
            write_session_record(table, normalized)
            update_daily_rollup(table, normalized)
        except Exception as exc:  # pragma: no cover
            print(f"Failed to process SQS message: {exc}")
            failures.append({"itemIdentifier": record.get("messageId", "unknown")})

    return {"batchItemFailures": failures}
