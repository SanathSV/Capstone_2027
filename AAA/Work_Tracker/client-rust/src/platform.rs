use std::process::Command;
use url::Url;

#[derive(Debug, Clone)]
pub struct ActiveWindow {
    pub process: String,
    pub title: String,
    pub domain: String,
}

pub fn active_window() -> ActiveWindow {
    // =========================
    // macOS implementation
    // =========================
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

    // =========================
    // Windows implementation
    // =========================
    #[cfg(target_os = "windows")]
    {
        return windows_active_window();
    }

    // =========================
    // Other operating systems
    // =========================
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        ActiveWindow {
            process: "unknown".to_string(),
            title: "unknown".to_string(),
            domain: String::new(),
        }
    }
}

// ============================================================
// WINDOWS
// ============================================================

#[cfg(target_os = "windows")]
fn windows_active_window() -> ActiveWindow {
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd = GetForegroundWindow();

        if hwnd == HWND::default() {
            return ActiveWindow {
                process: "unknown".to_string(),
                title: "unknown".to_string(),
                domain: String::new(),
            };
        }

        // -------------------------
        // Get active window title
        // -------------------------
        let title_len = GetWindowTextLengthW(hwnd);

        let title = if title_len > 0 {
            let mut buffer = vec![0u16; (title_len + 1) as usize];

            let written = GetWindowTextW(hwnd, &mut buffer);

            String::from_utf16_lossy(&buffer[..written as usize])
        } else {
            String::new()
        };

        // -------------------------
        // Get process ID
        // -------------------------
        let mut process_id = 0u32;

        GetWindowThreadProcessId(hwnd, Some(&mut process_id));

        // -------------------------
        // Get process executable name
        // -------------------------
        let process = match OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            process_id,
        ) {
            Ok(handle) => {
                let mut buffer = vec![0u16; 1024];
                let mut size = buffer.len() as u32;

                let result = QueryFullProcessImageNameW(
                    handle,
                    PROCESS_NAME_WIN32,
                    windows::core::PWSTR(buffer.as_mut_ptr()),
                    &mut size,
                );

                let process_name = if result.is_ok() {
                    let path = String::from_utf16_lossy(&buffer[..size as usize]);

                    std::path::Path::new(&path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("unknown")
                        .to_string()
                } else {
                    "unknown".to_string()
                };

                let _ = CloseHandle(handle);

                process_name
            }

            Err(_) => "unknown".to_string(),
        };

        ActiveWindow {
            process,
            title,
            domain: String::new(),
        }
    }
}

// ============================================================
// macOS
// ============================================================

#[cfg(target_os = "macos")]
fn run_script(script: &str) -> Option<String> {
    let output = Command::new("osascript")
        .args(["-e", script])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let value = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_string();

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

        "Firefox" => {
            "tell application \"Firefox\" to get URL of active tab of front window"
        }

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