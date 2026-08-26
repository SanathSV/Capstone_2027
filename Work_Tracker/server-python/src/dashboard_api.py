import json
import os
from datetime import datetime, timezone
from typing import Any

try:
    import boto3
    from boto3.dynamodb.conditions import Key
except ImportError:  # pragma: no cover - local dev fallback without AWS libs
    boto3 = None
    Key = None
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

try:
    from mangum import Mangum
except ImportError:  # pragma: no cover - local dev fallback without AWS libs
    Mangum = None

app = FastAPI(title="CDI Dashboard API", version="1.0.0")

LOCAL_DATA = {"sessions": [], "summaries": []}


def local_mode_enabled() -> bool:
    return os.environ.get("CDI_LOCAL_MODE", "1") == "1" or not os.environ.get("AWS_ACCESS_KEY_ID")


def get_table():
    if local_mode_enabled() or boto3 is None:
        return None
    table_name = os.environ.get("CDI_TABLE_NAME")
    if not table_name:
        raise RuntimeError("CDI_TABLE_NAME is not configured")
    return boto3.resource("dynamodb").Table(table_name)


def require_api_key(x_api_key: str | None):
    expected = os.environ.get("API_KEY_VALUE", "local-dev-key")
    if x_api_key is None or x_api_key != expected:
        raise HTTPException(status_code=401, detail="Invalid API key")


def parse_decimal(value):
    if isinstance(value, float):
        return round(value, 4)
    if isinstance(value, str):
        try:
            return round(float(value), 4)
        except ValueError:
            return value
    return value


def local_store_session(payload: dict):
    payload = dict(payload)
    payload.setdefault("commits", payload.get("commits", []))
    payload.setdefault("commit_count", len(payload.get("commits", [])))
    payload.setdefault("additions", 0)
    payload.setdefault("deletions", 0)
    LOCAL_DATA["sessions"].append(payload)

    date_key = payload.get("started_at", "2026-01-01T00:00:00Z")[:10]
    summary = {
        "type": "daily_summary",
        "org_id": payload.get("org_id", "default-org"),
        "user_id": payload.get("user_id", "default-user"),
        "date_key": date_key,
        "session_count": 1,
        "avg_cdi_score": float(payload.get("cdi_score", 0.0) or 0.0),
        "total_active_hours": float(payload.get("active_hours", 0.0) or 0.0),
        "total_commits": int(payload.get("commit_count", 0) or 0),
    }
    LOCAL_DATA["summaries"].append(summary)


def local_user_dashboard(org_id: str, user_id: str, date_str: str):
    sessions = [
        item for item in LOCAL_DATA["sessions"]
        if item.get("org_id") == org_id and item.get("user_id") == user_id and str(item.get("started_at", ""))[:10] == date_str
    ]
    summary = {
        "session_count": len(sessions),
        "avg_cdi_score": round(sum(float(item.get("cdi_score", 0.0) or 0.0) for item in sessions) / len(sessions), 4) if sessions else 0,
        "total_active_hours": round(sum(float(item.get("active_hours", 0.0) or 0.0) for item in sessions), 4),
        "total_commits": sum(int(item.get("commit_count", 0) or 0) for item in sessions),
    }
    return {"org_id": org_id, "user_id": user_id, "date_str": date_str, "summary": summary, "sessions": sessions}


def local_org_dashboard(org_id: str, date_str: str):
    sessions = [
        item for item in LOCAL_DATA["sessions"]
        if item.get("org_id") == org_id and str(item.get("started_at", ""))[:10] == date_str
    ]
    users = {}
    for item in sessions:
        user_id = item.get("user_id", "default-user")
        users.setdefault(user_id, {"session_count": 0, "avg_cdi_score_total": 0.0, "total_active_hours": 0.0, "total_commits": 0})
        users[user_id]["session_count"] += 1
        users[user_id]["avg_cdi_score_total"] += float(item.get("cdi_score", 0.0) or 0.0)
        users[user_id]["total_active_hours"] += float(item.get("active_hours", 0.0) or 0.0)
        users[user_id]["total_commits"] += int(item.get("commit_count", 0) or 0)

    org_summary = {
        "session_count": len(sessions),
        "avg_cdi_score": round(sum(float(item.get("cdi_score", 0.0) or 0.0) for item in sessions) / len(sessions), 4) if sessions else 0,
        "total_active_hours": round(sum(float(item.get("active_hours", 0.0) or 0.0) for item in sessions), 4),
        "total_commits": sum(int(item.get("commit_count", 0) or 0) for item in sessions),
    }

    user_rollups = [
        {
            "user_id": user_id,
            "date_str": date_str,
            "session_count": values["session_count"],
            "avg_cdi_score": round(values["avg_cdi_score_total"] / values["session_count"], 4) if values["session_count"] else 0,
            "total_active_hours": round(values["total_active_hours"], 4),
            "total_commits": values["total_commits"],
        }
        for user_id, values in users.items()
    ]
    return {"org_id": org_id, "date_str": date_str, "org_summary": org_summary, "user_rollups": user_rollups}


@app.post("/v1/telemetry/sync")
async def telemetry_sync(request: Request, x_api_key: str | None = Header(default=None, alias="x-api-key")):
    require_api_key(x_api_key)
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload must be an object")

    if not payload.get("session_id"):
        raise HTTPException(status_code=400, detail="session_id is required")

    if local_mode_enabled():
        local_store_session(payload)
        return JSONResponse(status_code=202, content={"accepted": True, "session_id": payload.get("session_id"), "mode": "local"})

    if boto3 is None:
        raise HTTPException(status_code=503, detail="AWS dependencies are unavailable in local mode")

    queue_url = os.environ.get("TELEMETRY_QUEUE_URL")
    if not queue_url:
        raise HTTPException(status_code=500, detail="TELEMETRY_QUEUE_URL is not configured")

    client = boto3.client("sqs")
    try:
        client.send_message(
            QueueUrl=queue_url,
            MessageBody=json.dumps(payload),
            MessageGroupId=f"{payload.get('org_id', 'default')}:{payload.get('user_id', 'default')}",
            MessageDeduplicationId=f"{payload.get('org_id', 'default')}:{payload.get('user_id', 'default')}:{payload.get('session_id', 'default')}"
        )
        return JSONResponse(status_code=202, content={"accepted": True, "session_id": payload.get("session_id"), "mode": "aws"})
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=f"Failed to enqueue telemetry: {str(exc)}") from exc


@app.get("/v1/dashboard/user/{org_id}/{user_id}/{date_str}")
async def user_dashboard(org_id: str, user_id: str, date_str: str, x_api_key: str | None = Header(default=None, alias="x-api-key")):
    require_api_key(x_api_key)
    if local_mode_enabled():
        return local_user_dashboard(org_id, user_id, date_str)

    if boto3 is None:
        raise HTTPException(status_code=503, detail="AWS dependencies are unavailable in local mode")

    table = get_table()
    response = table.query(
        KeyConditionExpression=(
            Key("PK").eq(f"ORG#{org_id}") &
            Key("SK").begins_with(f"USER#{user_id}#DAY#{date_str}")
        )
    )
    items = response.get("Items", [])
    summary = items[0] if items else {}
    return {
        "org_id": org_id,
        "user_id": user_id,
        "date_str": date_str,
        "summary": {
            "session_count": summary.get("session_count"),
            "avg_cdi_score": parse_decimal(summary.get("avg_cdi_score")),
            "total_active_hours": parse_decimal(summary.get("total_active_hours")),
            "total_commits": summary.get("total_commits"),
        },
        "sessions": [
            {
                "session_id": item.get("session_id"),
                "project_id": item.get("project_id"),
                "task": item.get("task"),
                "started_at": item.get("started_at"),
                "ended_at": item.get("ended_at"),
                "active_hours": parse_decimal(item.get("active_hours")),
                "idle_hours": parse_decimal(item.get("idle_hours")),
                "cdi_score": parse_decimal(item.get("cdi_score")),
                "commit_count": item.get("commit_count"),
            }
            for item in table.query(
                KeyConditionExpression=(
                    Key("PK").eq(f"ORG#{org_id}") &
                    Key("SK").begins_with(f"USER#{user_id}#SESSION#")
                )
            ).get("Items", [])
        ],
    }


@app.get("/v1/dashboard/org/{org_id}/{date_str}")
async def org_dashboard(org_id: str, date_str: str, x_api_key: str | None = Header(default=None, alias="x-api-key")):
    require_api_key(x_api_key)
    if local_mode_enabled():
        return local_org_dashboard(org_id, date_str)

    if boto3 is None:
        raise HTTPException(status_code=503, detail="AWS dependencies are unavailable in local mode")

    table = get_table()
    response = table.query(
        IndexName="GSI1",
        KeyConditionExpression=(
            Key("GSI1_PK").eq(f"ORG#{org_id}") &
            Key("GSI1_SK").begins_with(f"{date_str}#")
        )
    )

    items = response.get("Items", [])
    summary_items = [item for item in items if item.get("type") == "org_summary"]
    user_items = [item for item in items if item.get("type") == "daily_summary"]

    return {
        "org_id": org_id,
        "date_str": date_str,
        "org_summary": {
            "session_count": sum(int(item.get("session_count", 0) or 0) for item in summary_items),
            "avg_cdi_score": round(sum(float(item.get("avg_cdi_score", 0) or 0) for item in summary_items) / len(summary_items), 4) if summary_items else 0,
            "total_active_hours": sum(float(item.get("total_active_hours", 0) or 0) for item in summary_items),
            "total_commits": sum(int(item.get("total_commits", 0) or 0) for item in summary_items),
        },
        "user_rollups": [
            {
                "user_id": item.get("user_id"),
                "date_str": item.get("date_key"),
                "session_count": item.get("session_count"),
                "avg_cdi_score": parse_decimal(item.get("avg_cdi_score")),
                "total_active_hours": parse_decimal(item.get("total_active_hours")),
                "total_commits": item.get("total_commits"),
            }
            for item in user_items
        ],
    }


@app.get("/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat(), "mode": "local" if local_mode_enabled() else "aws"}


if Mangum is not None:
    handler = Mangum(app)
else:
    handler = app
