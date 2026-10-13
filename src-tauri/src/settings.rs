//! Shared settings load/save (JSON in the app-data dir).
//!
//! Persisted shape:
//! ```json
//! {
//!   "download_dir": "D:/Videos/Offtube",
//!   "prefer_nightly": false,
//!   "extra_args": "",
//!   "last_engine_check": 1728000000
//! }
//! ```

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "offtube-settings.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub download_dir: Option<String>,
    #[serde(default)]
    pub prefer_nightly: bool,
    #[serde(default)]
    pub extra_args: String,
    #[serde(default)]
    pub last_engine_check: Option<i64>,
    /// DASH/HLS fragments downloaded at once. None = 4 (app default).
    #[serde(default)]
    pub concurrent_fragments: Option<u32>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            download_dir: None,
            prefer_nightly: false,
            extra_args: String::new(),
            last_engine_check: None,
            concurrent_fragments: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SettingsPatch {
    pub download_dir: Option<Option<String>>,
    pub prefer_nightly: Option<bool>,
    pub extra_args: Option<String>,
    pub last_engine_check: Option<Option<i64>>,
    pub concurrent_fragments: Option<Option<u32>>,
}

pub fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    Ok(dir.join(SETTINGS_FILE))
}

pub fn load_settings(app: &AppHandle) -> Settings {
    let path = match settings_path(app) {
        Ok(p) => p,
        Err(_) => return Settings::default(),
    };
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Settings::default(),
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir settings: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_string_pretty(settings).map_err(|e| format!("encode: {e}"))?;
    std::fs::write(&tmp, data).map_err(|e| format!("write tmp: {e}"))?;
    // Atomic-ish swap on the same volume.
    match std::fs::rename(&tmp, &path) {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = std::fs::remove_file(&path);
            std::fs::rename(&tmp, &path).map_err(|e| format!("swap settings: {e}"))
        }
    }
}

/// Effective fragment parallelism: user setting clamped to 1..=16, else 4.
pub fn effective_fragments(app: &AppHandle) -> u32 {
    load_settings(app)
        .concurrent_fragments
        .unwrap_or(4)
        .clamp(1, 16)
}
/// Default download location: ~/Videos/Offtube, falling back to ~/Downloads/Offtube.
pub fn default_download_dir() -> String {
    let base = dirs::video_dir()
        .or_else(dirs::download_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Offtube").to_string_lossy().to_string()
}

/// Resolve the effective download dir (setting override, else default),
/// creating it if missing.
pub fn effective_download_dir(app: &AppHandle) -> Result<String, String> {
    let settings = load_settings(app);
    let dir = settings
        .download_dir
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(default_download_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir download dir: {e}"))?;
    Ok(dir)
}
