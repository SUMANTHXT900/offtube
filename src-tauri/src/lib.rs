//! Offtube backend — a thin orchestrator over yt-dlp / ffmpeg / deno sidecars.
//!
//! All download intelligence lives in the sidecars; this crate resolves the
//! binaries, parses yt-dlp's JSON/progress output, relays typed events to the
//! UI, and keeps the engine fresh via the silent updater.

mod downloads;
mod net;
mod settings;
mod sidecar;
mod updater;

use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

pub struct AppState {
    pub downloads: Arc<downloads::ActiveMap>,
}

// ---------------------------------------------------------------------------
// Settings commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_settings(app: AppHandle) -> settings::Settings {
    settings::load_settings(&app)
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    patch: settings::SettingsPatch,
) -> Result<settings::Settings, String> {
    let mut current = settings::load_settings(&app);
    if let Some(v) = patch.download_dir {
        current.download_dir = v;
    }
    if let Some(v) = patch.prefer_nightly {
        current.prefer_nightly = v;
    }
    if let Some(v) = patch.extra_args {
        current.extra_args = v;
    }
    if let Some(v) = patch.last_engine_check {
        current.last_engine_check = v;
    }
    if let Some(v) = patch.concurrent_fragments {
        current.concurrent_fragments = v;
    }
    if let Some(v) = patch.autofetch {
        current.autofetch = v;
    }
    if let Some(v) = patch.last_speed_mbps {
        current.last_speed_mbps = v;
    }
    if let Some(v) = patch.last_speed_check {
        current.last_speed_check = v;
    }
    settings::save_settings(&app, &current)?;
    Ok(current)
}

#[tauri::command]
fn get_download_dir(app: AppHandle) -> Result<String, String> {
    settings::effective_download_dir(&app)
}

#[tauri::command]
fn pick_download_dir(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked.map(|p| p.to_string()))
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("open: {e}"))
}

// ---------------------------------------------------------------------------
// Engine commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn engine_status(app: AppHandle) -> updater::EngineStatus {
    updater::engine_status(&app).await
}

#[tauri::command]
async fn check_engine_update(
    app: AppHandle,
    prefer_nightly: Option<bool>,
) -> Result<updater::UpdateCheck, String> {
    let prefer = prefer_nightly.unwrap_or_else(|| settings::load_settings(&app).prefer_nightly);
    updater::check_for_update(&app, prefer).await
}

#[tauri::command]
async fn update_engine(
    app: AppHandle,
    prefer_nightly: Option<bool>,
) -> Result<updater::UpdateResult, String> {
    let prefer = prefer_nightly.unwrap_or_else(|| settings::load_settings(&app).prefer_nightly);
    updater::update_engine(&app, prefer).await
}

// ---------------------------------------------------------------------------
// Download commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn fetch_metadata(
    app: AppHandle,
    url: String,
    extra_args: Option<String>,
    fetch_id: Option<String>,
) -> Result<downloads::VideoMetadata, String> {
    downloads::fetch_metadata_impl(&app, url.trim(), extra_args, fetch_id).await
}

#[tauri::command]
async fn bandwidth_status(app: AppHandle) -> net::BandwidthStatus {
    net::bandwidth_status(&app)
}

#[tauri::command]
async fn start_download(
    app: AppHandle,
    state: State<'_, AppState>,
    req: downloads::StartRequest,
) -> Result<(), String> {
    downloads::start_download_impl(app, state.downloads.clone(), req).await
}

#[tauri::command]
async fn cancel_download(
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let killed = downloads::cancel_download_impl(&state.downloads, &id).await?;
    // The streaming task emits `download-cancelled` and drops its map entry.
    Ok(killed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState {
            downloads: Arc::new(Mutex::new(std::collections::HashMap::new())),
        })
        .setup(|app| {
            // Silent engine check (max once/24h, offline-tolerant) — never
            // blocks window creation.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                updater::auto_check_and_update(handle).await;
            });
            // Bandwidth probe for Auto fragment parallelism, same deal.
            let net_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                net::ensure_probed(&net_handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            get_download_dir,
            pick_download_dir,
            open_path,
            engine_status,
            check_engine_update,
            update_engine,
            fetch_metadata,
            start_download,
            cancel_download,
            bandwidth_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
