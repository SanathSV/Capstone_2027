use std::env;
use std::time::Duration;

mod config;

use config::ClientConfig;

#[derive(Debug, serde::Serialize)]
struct TelemetryPayload {
    org_id: String,
    user_id: String,
    session_id: String,
    project_id: String,
    task: String,
    started_at: String,
    ended_at: String,
    active_hours: f64,
    idle_hours: f64,
    cdi_score: f64,
    commit_count: u32,
    additions: u32,
    deletions: u32,
    commits: Vec<CommitEntry>,
}

#[derive(Debug, serde::Serialize)]
struct CommitEntry {
    commit_hash: String,
    message: String,
    additions: u32,
    deletions: u32,
}

fn main() {
    let config = resolve_config();
    println!("CDI client configured for {}", config.api_base_url);

    let payload = TelemetryPayload {
        org_id: config.org_id.clone(),
        user_id: config.user_id.clone(),
        session_id: "session-demo-001".to_string(),
        project_id: "proj-capstone-2027".to_string(),
        task: "Build production CDI backend".to_string(),
        started_at: "2026-08-26T09:00:00Z".to_string(),
        ended_at: "2026-08-26T10:00:00Z".to_string(),
        active_hours: 1.0,
        idle_hours: 0.1,
        cdi_score: 83.5,
        commit_count: 1,
        additions: 120,
        deletions: 15,
        commits: vec![CommitEntry {
            commit_hash: "abc123".to_string(),
            message: "feat: add AWS telemetry ingestion".to_string(),
            additions: 120,
            deletions: 15,
        }],
    };

    match send_telemetry(&config, &payload) {
        Ok(response) => println!("Telemetry accepted: {}", response),
        Err(err) => eprintln!("Telemetry upload failed: {}", err),
    }
}

fn resolve_config() -> ClientConfig {
    if let Ok(path) = env::var("CDI_CONFIG_FILE") {
        if let Ok(cfg) = ClientConfig::from_file(path) {
            return cfg;
        }
    }

    let default_path = ClientConfig::config_file_path();
    if let Ok(cfg) = ClientConfig::from_file(&default_path) {
        return cfg;
    }

    ClientConfig::from_env_or_default()
}

fn send_telemetry(config: &ClientConfig, payload: &TelemetryPayload) -> Result<String, String> {
    let client = reqwest::blocking::Client::new();
    let endpoint = format!("{}/v1/telemetry/sync", config.api_base_url.trim_end_matches('/'));

    let response = client
        .post(endpoint)
        .header("x-api-key", &config.api_key)
        .header("Content-Type", "application/json")
        .json(payload)
        .timeout(Duration::from_secs(config.timeout_seconds))
        .send()
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    if !status.is_success() {
        return Err(format!("Status {}: {}", status, body));
    }

    Ok(body)
}
