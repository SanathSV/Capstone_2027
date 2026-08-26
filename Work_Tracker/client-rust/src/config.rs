use std::env;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct ClientConfig {
    pub api_base_url: String,
    pub api_key: String,
    pub org_id: String,
    pub user_id: String,
    pub timeout_seconds: u64,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            api_base_url: "http://localhost:8000".to_string(),
            api_key: "local-dev-key".to_string(),
            org_id: "default-org".to_string(),
            user_id: "default-user".to_string(),
            timeout_seconds: 15,
        }
    }
}

impl ClientConfig {
    pub fn from_env_or_default() -> Self {
        let default = Self::default();

        let api_base_url = env::var("CDI_API_BASE_URL")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or(default.api_base_url.clone());

        let api_key = env::var("CDI_API_KEY")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or(default.api_key.clone());

        let org_id = env::var("CDI_ORG_ID")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or(default.org_id.clone());

        let user_id = env::var("CDI_USER_ID")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or(default.user_id.clone());

        let timeout_seconds = env::var("CDI_TIMEOUT_SECONDS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default.timeout_seconds);

        Self {
            api_base_url,
            api_key,
            org_id,
            user_id,
            timeout_seconds,
        }
    }

    pub fn from_file(path: impl AsRef<std::path::Path>) -> Result<Self, String> {
        let file_path = path.as_ref();
        let contents = fs::read_to_string(file_path)
            .map_err(|e| format!("Unable to read config file '{}': {}", file_path.display(), e))?;

        let mut config = Self::from_env_or_default();
        for line in contents.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            let mut parts = trimmed.splitn(2, '=');
            let key = parts.next().unwrap_or("").trim();
            let value = parts.next().unwrap_or("").trim();
            if key.is_empty() {
                continue;
            }

            match key {
                "CDI_API_BASE_URL" => config.api_base_url = value.to_string(),
                "CDI_API_KEY" => config.api_key = value.to_string(),
                "CDI_ORG_ID" => config.org_id = value.to_string(),
                "CDI_USER_ID" => config.user_id = value.to_string(),
                "CDI_TIMEOUT_SECONDS" => {
                    if let Ok(parsed) = value.parse::<u64>() {
                        config.timeout_seconds = parsed;
                    }
                }
                _ => {}
            }
        }

        Ok(config)
    }

    pub fn config_file_path() -> PathBuf {
        let home = dirs::home_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        home.join(".cdi-agent.conf")
    }
}

#[cfg(test)]
mod tests {
    use super::ClientConfig;

    #[test]
    fn defaults_are_valid() {
        let cfg = ClientConfig::default();
        assert!(!cfg.api_base_url.is_empty());
        assert!(!cfg.api_key.is_empty());
    }
}
