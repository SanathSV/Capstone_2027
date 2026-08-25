"""Central API for sanitized daily reports.

The server stores submitted aggregates and commit metadata. It never receives
raw keystrokes, screenshots, clipboard data, full URLs, or source files.
"""
import json
import os
import sqlite3
from datetime import datetime, timezone
from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import FileResponse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "backend_dashboard.db")
app = FastAPI(title="Focus Tracker API", version="1.0.0")


def db():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    with db() as connection:
        connection.executescript("""
        CREATE TABLE IF NOT EXISTS daily_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id TEXT NOT NULL, session_id INTEGER NOT NULL,
            project_id TEXT NOT NULL, task TEXT NOT NULL,
            started_at TEXT, ended_at TEXT, active_man_hours REAL NOT NULL,
            idle_hours REAL NOT NULL, commit_count INTEGER NOT NULL,
            additions INTEGER NOT NULL, deletions INTEGER NOT NULL,
            commits_json TEXT NOT NULL, received_at TEXT NOT NULL,
            UNIQUE(employee_id, session_id)
        );
        """)


def numeric(value, default=0.0):
    try:
        return max(float(value), 0.0)
    except (TypeError, ValueError):
        return default


@app.post("/api/daily-submit")
def daily_submit(body: dict = Body(...)):
    if not isinstance(body, dict) or not isinstance(body.get("reports"), list):
        raise HTTPException(status_code=400, detail="Expected JSON with a reports array")
    employee_id = str(body.get("employee_id", "unknown"))[:120]
    inserted = 0
    with db() as connection:
        for report in body["reports"]:
            if not isinstance(report, dict) or "session_id" not in report:
                raise HTTPException(status_code=400, detail="Each report needs session_id")
            commits = report.get("commits", [])
            if not isinstance(commits, list):
                commits = []
            commits = [{"commit_hash": str(item.get("commit_hash", ""))[:64],
                        "message": str(item.get("message", ""))[:240],
                        "additions": int(numeric(item.get("additions"))),
                        "deletions": int(numeric(item.get("deletions")))}
                       for item in commits if isinstance(item, dict)]
            try:
                connection.execute("""
                    INSERT OR IGNORE INTO daily_reports
                    (employee_id,session_id,project_id,task,started_at,ended_at,
                     active_man_hours,idle_hours,commit_count,additions,deletions,
                     commits_json,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (employee_id, int(report["session_id"]), str(report.get("project_id", "default"))[:120],
                      str(report.get("task", ""))[:500], report.get("started_at"), report.get("ended_at"),
                      numeric(report.get("active_man_hours")), numeric(report.get("idle_hours")), len(commits),
                      sum(item["additions"] for item in commits), sum(item["deletions"] for item in commits),
                      json.dumps(commits), datetime.now(timezone.utc).isoformat()))
                inserted += connection.execute("SELECT changes()").fetchone()[0]
            except (TypeError, ValueError, sqlite3.Error):
                raise HTTPException(status_code=400, detail="Invalid report data")
    return {"accepted": inserted}


@app.get("/api/reports")
def reports():
    with db() as connection:
        rows = connection.execute("SELECT * FROM daily_reports ORDER BY received_at DESC").fetchall()
        project_rows = connection.execute("""
            SELECT project_id, SUM(commit_count) commits, SUM(active_man_hours) active_hours,
                   SUM(additions) additions, SUM(deletions) deletions
            FROM daily_reports GROUP BY project_id ORDER BY project_id
        """).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["commits"] = json.loads(item.pop("commits_json"))
        result.append(item)
    projects = []
    for row in project_rows:
        item = dict(row)
        # Completion is based on observed commits; set a project goal with PROJECT_GOALS_JSON.
        goals = json.loads(os.getenv("PROJECT_GOALS_JSON", "{}"))
        goal = max(numeric(goals.get(item["project_id"], 1)), 1)
        item["completion_percent"] = round(min(item["commits"] / goal * 100, 100), 1)
        projects.append(item)
    return {"reports": result, "projects": projects}


@app.get("/")
def dashboard():
    return FileResponse(os.path.join(BASE_DIR, "dashboard.html"))


init_db()
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "5000")))
