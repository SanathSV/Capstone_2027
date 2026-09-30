use chrono::{DateTime, Utc};
use eframe::egui;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

mod config;
mod platform;

use config::ClientConfig;
use platform::ActiveWindow;

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const STATUSES: [&str; 3] = ["on_track", "drifting", "unclear"];

#[derive(Debug, Clone, Serialize)]
struct ActivityRow {
    timestamp: DateTime<Utc>,
    process: String,
    title: String,
    domain: String,
    status: String,
    reason: String,
}

struct ClassificationJob {
    signature: String,
    task: String,
    process: String,
    title: String,
    domain: String,
    model: String,
}

struct ClassificationResult {
    signature: String,
    status: String,
    reason: String,
}

#[derive(Debug, Serialize)]
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

#[derive(Debug, Serialize)]
struct CommitEntry {
    commit_hash: String,
    message: String,
    additions: u32,
    deletions: u32,
}

struct TrackerApp {
    config: ClientConfig,
    task: String,
    keywords: String,
    model: String,
    consent: bool,
    running: bool,
    status: String,
    live: String,
    rows: Vec<ActivityRow>,
    cache: HashMap<String, (String, String)>,
    stop: Option<Arc<AtomicBool>>,
    sample_rx: Option<Receiver<ActivityRow>>,
    result_rx: Option<Receiver<ClassificationResult>>,
    job_tx: Option<Sender<ClassificationJob>>,
    session_start: Option<DateTime<Utc>>,
    last_log: Option<PathBuf>,
}

impl TrackerApp {
    fn new(config: ClientConfig) -> Self {
        Self {
            task: "e.g. Implement the login flow in myrepo backend".into(),
            keywords: "myrepo, github.com, VS Code, Terminal, Safari, documentation, localhost"
                .into(),
            model: config.ollama_model.clone(),
            config,
            consent: false,
            running: false,
            status: "Idle. Fill task, tick consent, start.".into(),
            live: String::new(),
            rows: Vec::new(),
            cache: HashMap::new(),
            stop: None,
            sample_rx: None,
            result_rx: None,
            job_tx: None,
            session_start: None,
            last_log: None,
        }
    }

    fn start(&mut self) {
        if self.task.trim().is_empty() || self.task.starts_with("e.g.") {
            self.status = "Describe the assigned task first.".into();
            return;
        }
        if !self.consent {
            self.status = "Consent is required before tracking.".into();
            return;
        }
        let (sample_tx, sample_rx) = mpsc::channel();
        let (job_tx, job_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let poll_stop = Arc::clone(&stop);
        let task = self.task.clone();
        let model = self.model.clone();
        let keywords = parse_keywords(&self.keywords);
        let ollama_url = self.config.ollama_url.clone();
        thread::spawn(move || poll_loop(poll_stop, sample_tx, job_tx, task, model, keywords));
        thread::spawn(move || classifier_loop(job_rx, result_tx, ollama_url));
        self.rows.clear();
        self.cache.clear();
        self.session_start = Some(Utc::now());
        self.stop = Some(stop);
        self.sample_rx = Some(sample_rx);
        self.result_rx = Some(result_rx);
        self.job_tx = None;
        self.running = true;
        self.status = "Session running. Active-window metadata only.".into();
    }

    fn stop_session(&mut self) {
        if !self.running {
            return;
        }
        if let Some(stop) = &self.stop {
            stop.store(true, Ordering::Relaxed);
        }
        self.running = false;
        while let Some(rx) = &self.sample_rx {
            match rx.try_recv() {
                Ok(row) => self.rows.push(row),
                Err(_) => break,
            }
        }
        self.apply_results();
        match save_json(&self.rows, &self.config.log_dir) {
            Ok(path) => self.last_log = Some(path),
            Err(error) => {
                self.status = format!("Could not save CSV: {error}");
                return;
            }
        }
        if let Some(start) = self.session_start {
            self.status = match upload_session(&self.config, &self.task, start, &self.rows) {
                Ok(_) => "Done. CSV saved and telemetry accepted.".into(),
                Err(error) => format!("CSV saved; telemetry upload failed: {error}"),
            };
        }
        self.stop = None;
        self.sample_rx = None;
        self.result_rx = None;
    }

    fn apply_results(&mut self) {
        let mut results = Vec::new();
        if let Some(rx) = &self.result_rx {
            while let Ok(result) = rx.try_recv() {
                results.push(result);
            }
        }
        for result in results {
            self.cache.insert(
                result.signature.clone(),
                (result.status.clone(), result.reason.clone()),
            );
            for row in &mut self.rows {
                let window = ActiveWindow {
                    process: row.process.clone(),
                    title: row.title.clone(),
                    domain: row.domain.clone(),
                };
                if row.status == "pending" && signature(&window) == result.signature {
                    row.status = result.status.clone();
                    row.reason = result.reason.clone();
                }
            }
        }
    }
}

impl eframe::App for TrackerApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if let Some(rx) = &self.sample_rx {
            while let Ok(row) = rx.try_recv() {
                self.live = format!(
                    "[{}] {}{} | {}",
                    row.timestamp.format("%H:%M:%S"),
                    row.process,
                    if row.domain.is_empty() {
                        String::new()
                    } else {
                        format!(" | {}", row.domain)
                    },
                    row.status.to_uppercase()
                );
                self.rows.push(row);
            }
        }
        self.apply_results();
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("Focus Alignment Tracker");
            ui.label("Only process, window title, and browser domain are recorded.");
            ui.label("Assigned task");
            ui.text_edit_multiline(&mut self.task);
            ui.label("Optional fast-path keywords, comma separated");
            ui.text_edit_singleline(&mut self.keywords);
            ui.horizontal(|ui| {
                ui.label("Ollama model");
                ui.text_edit_singleline(&mut self.model);
            });
            ui.checkbox(
                &mut self.consent,
                "The monitored person has been informed and consents where required.",
            );
            ui.horizontal(|ui| {
                if ui
                    .add_enabled(!self.running, egui::Button::new("Start Session"))
                    .clicked()
                {
                    self.start();
                }
                if ui
                    .add_enabled(self.running, egui::Button::new("Stop Session"))
                    .clicked()
                {
                    self.stop_session();
                }
            });
            ui.label(&self.status);
            ui.label(&self.live);
            if let Some(path) = &self.last_log {
                ui.small(format!("Log: {}", path.display()));
            }
            ui.separator();
            egui::ScrollArea::vertical()
                .max_height(260.0)
                .show(ui, |ui| {
                    egui::Grid::new("activity").striped(true).show(ui, |ui| {
                        for heading in ["Time", "Process", "Title", "Domain", "Status", "Reason"] {
                            ui.strong(heading);
                        }
                        ui.end_row();
                        for row in self.rows.iter().rev().take(100) {
                            ui.label(row.timestamp.format("%H:%M:%S").to_string());
                            ui.label(&row.process);
                            ui.label(&row.title);
                            ui.label(&row.domain);
                            ui.label(&row.status);
                            ui.label(&row.reason);
                            ui.end_row();
                        }
                    });
                });
        });
        ctx.request_repaint_after(Duration::from_millis(250));
    }
}

fn parse_keywords(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn poll_loop(
    stop: Arc<AtomicBool>,
    sample_tx: Sender<ActivityRow>,
    job_tx: Sender<ClassificationJob>,
    task: String,
    model: String,
    keywords: Vec<String>,
) {
    let mut cache: HashMap<String, (String, String)> = HashMap::new();
    while !stop.load(Ordering::Relaxed) {
        let window = platform::active_window();
        let haystack =
            format!("{} {} {}", window.process, window.title, window.domain).to_lowercase();
        let key = signature(&window);
        let (status, reason) = if keywords.iter().any(|keyword| haystack.contains(keyword)) {
            ("on_track".into(), "keyword match".into())
        } else if let Some(value) = cache.get(&key) {
            value.clone()
        } else {
            let _ = job_tx.send(ClassificationJob {
                signature: key.clone(),
                task: task.clone(),
                process: window.process.clone(),
                title: window.title.clone(),
                domain: window.domain.clone(),
                model: model.clone(),
            });
            ("pending".into(), String::new())
        };
        if status != "pending" {
            cache.insert(key, (status.clone(), reason.clone()));
        }
        let _ = sample_tx.send(ActivityRow {
            timestamp: Utc::now(),
            process: window.process,
            title: window.title,
            domain: window.domain,
            status,
            reason,
        });
        thread::sleep(POLL_INTERVAL);
    }
}

fn classifier_loop(
    job_rx: Receiver<ClassificationJob>,
    result_tx: Sender<ClassificationResult>,
    ollama_url: String,
) {
    while let Ok(job) = job_rx.recv() {
        let (status, reason) = classify_with_ollama(&job, &ollama_url)
            .unwrap_or_else(|| ("unclear".into(), "LLM unavailable".into()));
        let _ = result_tx.send(ClassificationResult {
            signature: job.signature,
            status,
            reason,
        });
    }
}

fn classify_with_ollama(job: &ClassificationJob, base_url: &str) -> Option<(String, String)> {
    let domain = if job.domain.is_empty() {
        "(unknown)"
    } else {
        &job.domain
    };
    let prompt = format!("You are a workplace focus classifier. Assigned task: \"{}\"\nCurrent activity:\n- Application: {}\n- Window title: {}\n- Website domain: {}\nRespond ONLY with JSON: {{\"status\":\"on_track|drifting|unclear\",\"reason\":\"<max 12 words>\"}}", job.task, job.process, job.title, domain);
    let response = reqwest::blocking::Client::new().post(format!("{}/api/generate", base_url.trim_end_matches('/'))).json(&serde_json::json!({"model": job.model, "prompt": prompt, "stream": false, "format": "json", "options": {"temperature": 0}})).timeout(Duration::from_secs(25)).send().ok()?;
    let body: Value = response.json().ok()?;
    let inner: Value = serde_json::from_str(body.get("response")?.as_str()?).ok()?;
    let raw_status = inner.get("status")?.as_str()?.to_lowercase();
    let status = if STATUSES.contains(&raw_status.as_str()) {
        raw_status
    } else {
        "unclear".into()
    };
    let reason = inner
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("no reason given")
        .chars()
        .take(80)
        .collect();
    Some((status, reason))
}

fn signature(window: &ActiveWindow) -> String {
    if !window.domain.is_empty() {
        format!("web:{}", window.domain)
    } else {
        format!(
            "app:{}:{}",
            window.process.to_lowercase(),
            window.title.to_lowercase()
        )
    }
}

fn save_json(rows: &[ActivityRow], log_dir: &PathBuf) -> Result<PathBuf, String> {
    fs::create_dir_all(log_dir).map_err(|error| error.to_string())?;
    let path = log_dir.join(format!(
        "session_{}.json",
        Utc::now().format("%Y%m%d_%H%M%S")
    ));
    let file = File::create(&path).map_err(|error| error.to_string())?;
    serde_json::to_writer_pretty(file, rows).map_err(|error| error.to_string())?;
    Ok(path)
}

fn upload_session(
    config: &ClientConfig,
    task: &str,
    start: DateTime<Utc>,
    rows: &[ActivityRow],
) -> Result<String, String> {
    let on_track = rows.iter().filter(|row| row.status == "on_track").count();
    let cdi_score = if rows.is_empty() {
        0.0
    } else {
        100.0 * on_track as f64 / rows.len() as f64
    };
    let payload = TelemetryPayload {
        org_id: config.org_id.clone(),
        user_id: config.user_id.clone(),
        session_id: format!("session-{}", start.format("%Y%m%d%H%M%S")),
        project_id: config.project_id.clone(),
        task: task.to_string(),
        started_at: start.to_rfc3339(),
        ended_at: Utc::now().to_rfc3339(),
        active_hours: rows.len() as f64 * 5.0 / 3600.0,
        idle_hours: 0.0,
        cdi_score,
        commit_count: 0,
        additions: 0,
        deletions: 0,
        commits: Vec::new(),
    };
    let response = reqwest::blocking::Client::new()
        .post(format!(
            "{}/v1/telemetry/sync",
            config.api_base_url.trim_end_matches('/')
        ))
        .header("x-api-key", &config.api_key)
        .json(&payload)
        .send()
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, body));
    }
    Ok(body)
}

fn main() -> eframe::Result {
    let config = std::env::var("CDI_CONFIG_FILE")
        .ok()
        .and_then(|path| ClientConfig::from_file(path).ok())
        .or_else(|| ClientConfig::from_file(ClientConfig::config_file_path()).ok())
        .unwrap_or_else(ClientConfig::from_env_or_default);
    eframe::run_native(
        "Focus Alignment Tracker",
        eframe::NativeOptions::default(),
        Box::new(move |_cc| Ok(Box::new(TrackerApp::new(config)))),
    )
}
