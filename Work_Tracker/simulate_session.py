"""
Simulation Test Harness for Work Drift Tracker
=============================================
Simulates a full 2-hour software engineering work session:
  - Phase 1 (00:00 - 00:45): Deep Coding (VS Code + Terminal) -> High Alignment
  - Phase 2 (00:45 - 01:10): Tech Research (StackOverflow + GitHub) -> Support Tool
  - Phase 3 (01:10 - 01:35): Slacking / Context Switching (YouTube + Reddit) -> Heavy Drift
  - Phase 4 (01:35 - 01:50): Idle Break (Away from Desk) -> Pruned
  - Phase 5 (01:50 - 02:00): Git Commit & Wrap-up -> Output Artifact Added
"""

import os
import sqlite3
import urllib.request
import json
from datetime import datetime, timedelta

# Import local drift calculation engine
from drift_engine import calculate_cdi
import agent

LOCAL_DB = "local_tracker.db"

def setup_simulated_db():
    """Initializes and clears previous test sessions in local_tracker.db."""
    conn = sqlite3.connect(LOCAL_DB)
    c = conn.cursor()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT,
            task TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT 'default', synced INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, recorded_at TEXT NOT NULL,
            process_name TEXT NOT NULL, window_title TEXT NOT NULL, domain TEXT NOT NULL,
            status TEXT NOT NULL, reason TEXT NOT NULL, idle INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS git_commits (
            id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, commit_hash TEXT NOT NULL,
            message TEXT NOT NULL, additions INTEGER NOT NULL DEFAULT 0, deletions INTEGER NOT NULL DEFAULT 0
        );
    """)
    conn.commit()
    conn.close()

def run_2hour_simulation():
    setup_simulated_db()
    
    task_desc = "Implement authentication API and JWT token validation in Python"
    project_id = "proj_sim_2hr"
    
    # 1. Create Simulated Session
    start_time = datetime.now() - timedelta(hours=2)
    end_time = datetime.now()
    
    conn = sqlite3.connect(LOCAL_DB)
    c = conn.cursor()
    c.execute("INSERT INTO sessions (started_at, ended_at, task, project_id) VALUES (?, ?, ?, ?)",
              (start_time.isoformat(), end_time.isoformat(), task_desc, project_id))
    session_id = c.lastrowid
    conn.commit()
    conn.close()

    print("=" * 70)
    print(f" SIMULATING 2-HOUR WORK SESSION (Session ID: {session_id}) ")
    print("=" * 70)

    # 2. Build 144 Activity Snapshots (5 seconds per sample = 12 minutes per phase block)
    activity_timeline = []

    # Phase 1: Deep Focused Work (45 mins = 54 samples)
    for _ in range(54):
        activity_timeline.append(("Code.exe", "agent.py - Work_Tracker", "", "on_track", "direct coding", 0))

    # Phase 2: Technical Research / Support Tools (25 mins = 30 samples)
    for _ in range(30):
        activity_timeline.append(("Chrome", "Stack Overflow - JWT Auth error", "stackoverflow.com", "support_tool", "technical research", 0))

    # Phase 3: Severe Slacking & Context Switching (25 mins = 30 samples)
    for _ in range(30):
        # Alternate between coding and slacking to force context-switch penalties
        activity_timeline.append(("Chrome", "YouTube - Best Coding Music", "youtube.com", "drifting", "entertainment", 0))
        activity_timeline.append(("Code.exe", "agent.py - Work_Tracker", "", "on_track", "direct coding", 0))

    # Phase 4: Idle / Away from Keyboard (15 mins = 18 samples)
    for _ in range(18):
        activity_timeline.append(("Code.exe", "agent.py - Work_Tracker", "", "unclear", "idle limit reached", 1))

    # Phase 5: Finalizing & Code Review (10 mins = 12 samples)
    for _ in range(12):
        activity_timeline.append(("Terminal", "git commit -m 'feat: auth pipeline'", "", "on_track", "direct terminal work", 0))

    # Save Timeline into local SQLite
    conn = sqlite3.connect(LOCAL_DB)
    c = conn.cursor()
    sim_time = start_time
    for proc, title, domain, status, reason, idle in activity_timeline:
        sim_time += timedelta(seconds=5)
        c.execute("""INSERT INTO activity_log 
                     (session_id, recorded_at, process_name, window_title, domain, status, reason, idle)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                  (session_id, sim_time.isoformat(), proc, title, domain, status, reason, idle))
    
    # 3. Add Simulated Git Commits
    c.execute("""INSERT INTO git_commits (session_id, commit_hash, message, additions, deletions)
                 VALUES (?, ?, ?, ?, ?)""",
              (session_id, "7f8a1bc", "feat: implement jwt auth and drift evaluation", 120, 15))
    conn.commit()

    # 4. Fetch Logs and Run Composite Drift Engine
    c.row_factory = sqlite3.Row
    rows = c.execute("SELECT * FROM activity_log WHERE session_id=?", (session_id,)).fetchall()
    commits = c.execute("SELECT commit_hash, message, additions, deletions FROM git_commits WHERE session_id=?", (session_id,)).fetchall()
    conn.close()

    activity_list = [dict(r) for r in rows]
    commit_list = [dict(c) for c in commits]

    # Calculate Engine Metrics
    cdi_results = calculate_cdi(activity_list, commit_list)

    # 5. Print Detailed Analytical Output
    print(f"\n[DRIFT ENGINE EVALUATION OUTPUT]")
    print(f"  Total Tracked Time   : 2 Hours (144 samples)")
    print(f"  Active Samples       : {cdi_results['active_samples']} (18 idle samples pruned)")
    print(f"  Context Switches     : {cdi_results['context_switches']} (Penalized via exponential decay)")
    print(f"  Git Artifacts        : {len(commit_list)} Commit (+{commit_list[0]['additions']}/-{commit_list[0]['deletions']}) -> Multiplier: {cdi_results['artifact_multiplier']}x")
    print("-" * 50)
    print(f"  Semantic Alignment (Sa) : {cdi_results['alignment_score']}%")
    print(f"  Flow Continuity (Sf)    : {cdi_results['flow_score']}%")
    print(f"  FINAL COMPOSITE DRIFT INDEX (CDI) : {cdi_results['cdi_score']}%\n")

    # 6. Test Payload Transmission to Backend API
    print("[BACKEND TRANSMISSION TEST]")
    try:
        payload = agent.build_payload()
        print(f"  Payload assembled successfully with {len(payload['reports'])} report(s).")
        
        req = urllib.request.Request(
            "http://localhost:5000/api/daily-submit",
            data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status == 200:
                print("  Successfully submitted simulated 2-hour payload to backend server!")
    except Exception as e:
        print(f"  Backend server submission skipped (Server offline: {e})")

if __name__ == "__main__":
    run_2hour_simulation()