use std::process::Command;
use url::Url;

#[derive(Debug, Clone)]
pub struct ActiveWindow {
    pub process: String,
    pub title: String,
    pub domain: String,
}

pub fn active_window() -> ActiveWindow {
    #[cfg(target_os = "macos")]
    {
        let process = run_script(
            "tell application \"System Events\" to get name of first process whose frontmost is true",
        )
        .unwrap_or_else(|| "unknown".to_string());
        let title = run_script(&format!(
            "tell application \"System Events\" to get name of front window of process \"{}\"",
            process.replace('"', "")
        ))
        .unwrap_or_else(|| "(no title)".to_string());
        let domain = browser_domain(&process);
        return ActiveWindow {
            process,
            title,
            domain,
        };
    }

    #[cfg(not(target_os = "macos"))]
    {
        ActiveWindow {
            process: "unknown".to_string(),
            title: "unknown".to_string(),
            domain: String::new(),
        }
    }
}

#[cfg(target_os = "macos")]
fn run_script(script: &str) -> Option<String> {
    let output = Command::new("osascript")
        .args(["-e", script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(target_os = "macos")]
fn browser_domain(process: &str) -> String {
    let script = match process {
        "Safari" => "tell application \"Safari\" to get URL of front document",
        "Google Chrome" => {
            "tell application \"Google Chrome\" to get URL of active tab of front window"
        }
        "Microsoft Edge" => {
            "tell application \"Microsoft Edge\" to get URL of active tab of front window"
        }
        "Brave Browser" => {
            "tell application \"Brave Browser\" to get URL of active tab of front window"
        }
        "Firefox" => "tell application \"Firefox\" to get URL of active tab of front window",
        _ => return String::new(),
    };

    let raw = match run_script(script) {
        Some(value) => value,
        None => return String::new(),
    };
    let normalized = if raw.contains("://") {
        raw
    } else {
        format!("http://{raw}")
    };
    Url::parse(&normalized)
        .ok()
        .and_then(|url| url.host_str().map(str::to_lowercase))
        .map(|host| host.strip_prefix("www.").unwrap_or(&host).to_string())
        .unwrap_or_default()
}
