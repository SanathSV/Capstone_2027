use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize)]
struct SessionInput {
    employee_id: String,
    role: String,
    project_id: String,
    task: String,
    consent: bool,
    model: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ActivityRow {
    session_id: i64,
    recorded_at: String,
    process_name: String,
    window_title: String,
    domain: String,
    status: String,
    reason: String,
    idle: i32,
}

#[derive(Debug, Serialize, Deserialize)]
struct SessionRecord {
    id: i64,
    started_at: String,
    task: String,
    project_id: String,
    synced: i32,
}

fn main() {
    println!("Rust local tracker initialized");

    let db_path = current_dir_db();
    println!("Using local DB at: {}", db_path.display());

    let info = SessionInput {
        employee_id: "emp_001".to_string(),
        role: "Software Engineer".to_string(),
        project_id: "proj_capstone_2027".to_string(),
        task: "Implement local telemetry agent and backend server API in Python".to_string(),
        consent: true,
        model: "llama3.2".to_string(),
    };

    println!("Session payload ready: {:?}", info);
    let _ = initialize_db(&db_path);
    println!("Local tracking loop should now run in Rust in place of Python polling.");
}

fn current_dir_db() -> PathBuf {
    let mut p = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    p.push("local_tracker.db");
    p
}

fn initialize_db(db_path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let conn = rusqlite::Connection::open(db_path)?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            task TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT 'default',
            synced INTEGER NOT NULL DEFAULT 0
        )",
        (),
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            recorded_at TEXT NOT NULL,
            process_name TEXT NOT NULL,
            window_title TEXT NOT NULL,
            domain TEXT NOT NULL,
            status TEXT NOT NULL,
            reason TEXT NOT NULL,
            idle INTEGER NOT NULL DEFAULT 0
        )",
        (),
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS git_commits (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            commit_hash TEXT NOT NULL,
            message TEXT NOT NULL,
            additions INTEGER NOT NULL DEFAULT 0,
            deletions INTEGER NOT NULL DEFAULT 0
        )",
        (),
    )?;

    Ok(())
}
