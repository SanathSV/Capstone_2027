"""Privacy-first offline session agent.

Raw activity stays in local_tracker.db. Only aggregated daily metrics and
sanitized commit metadata are submitted after an explicit user action.
"""
import datetime as dt
import json
import os
import platform
import queue
import sqlite3
import subprocess
import threading
import time
import urllib.request
import tkinter as tk
from tkinter import messagebox, ttk
from urllib.parse import urlparse

import psutil

SYSTEM = platform.system()
if SYSTEM == "Windows":
    import win32api
    import win32gui
    import win32process
else:
    import Quartz

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "local_tracker.db")
API_URL = "http://localhost:5000/api/daily-submit"
POLL_SECONDS = 5
IDLE_LIMIT_SECONDS = 180
BROWSERS = {"Safari", "Google Chrome", "Microsoft Edge", "Brave Browser", "Firefox"}


def connect_db():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    with connect_db() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT,
            task TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT 'default', synced INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, recorded_at TEXT NOT NULL,
            process_name TEXT NOT NULL, window_title TEXT NOT NULL, domain TEXT NOT NULL,
            status TEXT NOT NULL, reason TEXT NOT NULL, idle INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY(session_id) REFERENCES sessions(id)
        );
        CREATE TABLE IF NOT EXISTS git_commits (
            id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, commit_hash TEXT NOT NULL,
            message TEXT NOT NULL, additions INTEGER NOT NULL DEFAULT 0, deletions INTEGER NOT NULL DEFAULT 0,
            UNIQUE(session_id, commit_hash), FOREIGN KEY(session_id) REFERENCES sessions(id)
        );
        """)


def active_window():
    try:
        if SYSTEM == "Windows":
            hwnd = win32gui.GetForegroundWindow()
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            return psutil.Process(pid).name(), win32gui.GetWindowText(hwnd) or "(no title)", hwnd
        windows = Quartz.CGWindowListCopyWindowInfo(
            Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
            Quartz.kCGNullWindowID) or []
        for window in windows:
            if window.get(Quartz.kCGWindowLayer, 1) == 0 and window.get(Quartz.kCGWindowOwnerPID):
                return (window.get(Quartz.kCGWindowOwnerName, "unknown"),
                        window.get(Quartz.kCGWindowName) or "(no title)",
                        window.get(Quartz.kCGWindowNumber))
    except Exception:
        pass
    return "unknown", "unknown", None


def idle_seconds():
    try:
        if SYSTEM == "Windows":
            return (win32api.GetTickCount() - win32api.GetLastInputInfo()) / 1000
        event_types = (Quartz.kCGEventSourceStateHIDSystemState,
                       Quartz.kCGAnyInputEventType)
        return Quartz.CGEventSourceSecondsSinceLastEventType(*event_types)
    except Exception:
        return 0


def browser_domain(app_name):
    scripts = {
        "Safari": 'tell application "Safari" to get URL of front document',
        "Google Chrome": 'tell application "Google Chrome" to get URL of active tab of front window',
        "Microsoft Edge": 'tell application "Microsoft Edge" to get URL of active tab of front window',
        "Brave Browser": 'tell application "Brave Browser" to get URL of active tab of front window',
        "Firefox": 'tell application "Firefox" to get URL of active tab of front window',
    }
    if SYSTEM == "Windows" or app_name not in BROWSERS:
        return ""
    try:
        result = subprocess.run(["osascript", "-e", scripts[app_name]], capture_output=True,
                                text=True, timeout=3, check=False).stdout.strip()
        parsed = urlparse(result if "://" in result else "http://" + result)
        domain = parsed.netloc.lower()
        return domain[4:] if domain.startswith("www.") else domain
    except (OSError, subprocess.SubprocessError):
        return ""


def git_commits(session_id):
    """Capture only recent commit ids, subjects, and line churn; no source files."""
    try:
        output = subprocess.run(
            ["git", "log", "--since=24.hours", "--pretty=format:%H%x1f%s%x1f%aI", "--numstat"],
            capture_output=True, text=True, timeout=10, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return
    current = None
    additions = deletions = 0
    with connect_db() as db:
        for line in output.splitlines() + [""]:
            if "\x1f" in line:
                if current:
                    db.execute("INSERT OR IGNORE INTO git_commits(session_id,commit_hash,message,additions,deletions) VALUES(?,?,?,?,?)",
                               (session_id, current[0], current[1][:240], additions, deletions))
                parts = line.split("\x1f", 2)
                current, additions, deletions = parts, 0, 0
            elif current and line and line.split("\t")[:2] and len(line.split("\t")) >= 2:
                fields = line.split("\t")
                if fields[0].isdigit(): additions += int(fields[0])
                if fields[1].isdigit(): deletions += int(fields[1])
        db.commit()


def classify(task, process, title, domain, model):
    haystack = f"{process} {title} {domain}".lower()
    if any(word.strip().lower() in haystack for word in task.split() if len(word.strip()) > 3):
        return "on_track", "task keyword match"
    payload = {"model": model, "stream": False, "format": "json", "options": {"temperature": 0},
               "prompt": f'Classify activity for task "{task}". Activity: app={process}, title={title}, domain={domain}. '
                         'Return JSON status on_track, drifting, or unclear and a short reason.'}
    try:
        request = urllib.request.Request("http://localhost:11434/api/generate",
            data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=25) as response:
            data = json.loads(response.read().decode())
        result = json.loads(data.get("response", "{}"))
        status = result.get("status", "unclear")
        return (status if status in {"on_track", "drifting", "unclear"} else "unclear",
                str(result.get("reason", "no reason given"))[:160])
    except Exception:
        return "unclear", "LLM unavailable"


def build_payload():
    with connect_db() as db:
        sessions = db.execute("SELECT * FROM sessions WHERE synced=0 ORDER BY id").fetchall()
        reports = []
        for session in sessions:
            rows = db.execute("SELECT * FROM activity_log WHERE session_id=?", (session["id"],)).fetchall()
            commits = db.execute("SELECT commit_hash,message,additions,deletions FROM git_commits WHERE session_id=?",
                                 (session["id"],)).fetchall()
            active = sum(not row["idle"] for row in rows) * POLL_SECONDS / 3600
            idle = sum(bool(row["idle"]) for row in rows) * POLL_SECONDS / 3600
            reports.append({"session_id": session["id"], "project_id": session["project_id"],
                "task": session["task"][:500], "started_at": session["started_at"], "ended_at": session["ended_at"],
                "active_man_hours": round(active, 4), "idle_hours": round(idle, 4),
                "activity": [{"recorded_at": r["recorded_at"], "process": r["process_name"],
                              "window_title": r["window_title"][:300], "domain": r["domain"],
                              "status": r["status"], "reason": r["reason"][:160], "idle": bool(r["idle"])} for r in rows],
                "commits": [dict(c) for c in commits]})
    return {"employee_id": os.getenv("TRACKER_EMPLOYEE_ID", os.getenv("USER", "unknown")), "reports": reports}


def submit_logs():
    payload = build_payload()
    if not payload["reports"]:
        return False, "No unsynced sessions."
    request = urllib.request.Request(API_URL, data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status != 200:
                return False, f"Server returned HTTP {response.status}"
        ids = [item["session_id"] for item in payload["reports"]]
        with connect_db() as db:
            db.executemany("UPDATE sessions SET synced=1 WHERE id=?", [(item,) for item in ids])
        return True, f"Submitted {len(ids)} session(s)."
    except Exception as error:
        return False, f"Offline: {error}"


class AgentApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Focus Alignment Tracker")
        self.root.geometry("600x430")
        self.running = False
        self.session_id = None
        self.lock = threading.Lock()
        tk.Label(root, text="Assigned task").pack(anchor="w", padx=12, pady=(12, 2))
        self.task = tk.Text(root, height=3, width=70)
        self.task.pack(padx=12)
        self.task.insert("1.0", "Describe the task being performed.")
        row = tk.Frame(root); row.pack(fill="x", padx=12, pady=8)
        tk.Label(row, text="Project ID").pack(side="left")
        self.project = tk.Entry(row, width=18); self.project.pack(side="left", padx=6); self.project.insert(0, "default")
        tk.Label(row, text="Ollama model").pack(side="left")
        self.model = tk.Entry(row, width=18); self.model.pack(side="left", padx=6); self.model.insert(0, "llama3.2")
        self.consent = tk.BooleanVar()
        tk.Checkbutton(root, text="I have been informed and consent to this metadata tracking.", variable=self.consent).pack(anchor="w", padx=12)
        buttons = tk.Frame(root); buttons.pack(pady=12)
        self.start = tk.Button(buttons, text="Start Session", command=self.start_session, width=18); self.start.grid(row=0, column=0, padx=4)
        self.stop = tk.Button(buttons, text="Stop Session", command=self.stop_session, state="disabled", width=18); self.stop.grid(row=0, column=1, padx=4)
        self.sync = tk.Button(buttons, text="Sync / Submit Daily Log", command=self.sync_logs, width=22); self.sync.grid(row=0, column=2, padx=4)
        self.status = tk.StringVar(value="Idle. Raw logs remain local."); tk.Label(root, textvariable=self.status).pack(pady=8)

    def start_session(self):
        task = self.task.get("1.0", "end").strip()
        if not task or task == "Describe the task being performed.":
            messagebox.showwarning("Task needed", "Describe the assigned task."); return
        if not self.consent.get():
            messagebox.showwarning("Consent required", "Confirm informed consent before starting."); return
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        with connect_db() as db:
            cursor = db.execute("INSERT INTO sessions(started_at,task,project_id) VALUES(?,?,?)", (now, task, self.project.get().strip() or "default"))
            self.session_id = cursor.lastrowid
        self.running = True; self.start.config(state="disabled"); self.stop.config(state="normal")
        threading.Thread(target=self.track_loop, daemon=True).start()

    def stop_session(self):
        self.running = False; self.start.config(state="normal"); self.stop.config(state="disabled")
        if self.session_id:
            with connect_db() as db:
                db.execute("UPDATE sessions SET ended_at=? WHERE id=?", (dt.datetime.now(dt.timezone.utc).isoformat(), self.session_id))
            threading.Thread(target=git_commits, args=(self.session_id,), daemon=True).start()
        self.status.set("Stopped. Log remains local until you submit it.")

    def track_loop(self):
        while self.running:
            process, title, hwnd = active_window(); idle = idle_seconds() >= IDLE_LIMIT_SECONDS
            domain = browser_domain(process) if hwnd is not None else ""
            status, reason = ("unclear", "idle") if idle else classify(self.task.get("1.0", "end").strip(), process, title, domain, self.model.get().strip())
            with connect_db() as db:
                db.execute("INSERT INTO activity_log(session_id,recorded_at,process_name,window_title,domain,status,reason,idle) VALUES(?,?,?,?,?,?,?,?)",
                           (self.session_id, dt.datetime.now(dt.timezone.utc).isoformat(), process, title, domain, status, reason, int(idle)))
            self.root.after(0, self.status.set, f"{process} | {status.upper()} | {'IDLE' if idle else 'ACTIVE'}")
            time.sleep(POLL_SECONDS)

    def sync_logs(self):
        def work():
            success, message = submit_logs()
            self.root.after(0, lambda: messagebox.showinfo("Daily log", message) if success else messagebox.showwarning("Daily log", message))
        threading.Thread(target=work, daemon=True).start()


if __name__ == "__main__":
    init_db()
    root = tk.Tk(); AgentApp(root); root.mainloop()
