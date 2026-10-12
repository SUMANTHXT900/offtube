//! Silent yt-dlp engine updater.
//!
//! Design (from spec, built on day one):
//! - On launch, at most once per 24h, check
//!   `api.github.com/repos/yt-dlp/yt-dlp/releases/latest` (or the nightly
//!   repo when `prefer_nightly` is set) and compare the tag against the
//!   bundled `yt-dlp --version`.
//! - If newer: download the platform asset + `SHA2-256SUMS` to temp, verify
//!   the checksum (mandatory), then atomic swap
//!   (`.new` → `.old` → live) into the per-user bin dir and confirm with
//!   `--version`.
//! - Offline / failed check → quietly keep serving the existing sidecar.
//! - Settings exposes an "Update engine" button, a "prefer nightly" toggle,
//!   and the extra-args passthrough (config-driven so future yt-dlp flags
//!   never need a rebuild).

use crate::settings::{load_settings, save_settings};
use crate::sidecar::{self, TOOL_YTDLP};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const STABLE_REPO: &str = "yt-dlp/yt-dlp";
const NIGHTLY_REPO: &str = "yt-dlp/yt-dlp-nightly-builds";
const CHECK_INTERVAL_SECS: i64 = 24 * 60 * 60;

fn repo(prefer_nightly: bool) -> &'static str {
    if prefer_nightly {
        NIGHTLY_REPO
    } else {
        STABLE_REPO
    }
}

fn platform_asset_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else {
        "yt-dlp_linux"
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub installed_version: Option<String>,
    pub source: String,
    pub engine_path: String,
    pub ffmpeg_ok: bool,
    pub ffmpeg_path: Option<String>,
    pub deno_ok: bool,
    pub last_checked: Option<i64>,
    pub prefer_nightly: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub current: Option<String>,
    pub latest: String,
    pub update_available: bool,
    pub asset_name: String,
    pub repo: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub updated: bool,
    pub previous: Option<String>,
    pub current: String,
    pub repo: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProgress {
    pub stage: String,
    pub percent: Option<f64>,
    pub detail: String,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Offtube/0.1 (engine-updater)")
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

fn norm_tag(tag: &str) -> String {
    tag.trim().trim_start_matches('v').trim().to_string()
}

pub async fn engine_status(app: &AppHandle) -> EngineStatus {
    let settings = load_settings(app);
    let resolved = sidecar::resolve_tool(app, TOOL_YTDLP);
    let installed = sidecar::tool_version(app, TOOL_YTDLP).await;
    let ffmpeg_resolved = sidecar::resolve_tool(app, sidecar::TOOL_FFMPEG);
    let ffmpeg_ok = sidecar::tool_version(app, sidecar::TOOL_FFMPEG)
        .await
        .is_some()
        || sidecar::on_path("ffmpeg");
    let deno_ok = sidecar::tool_version(app, sidecar::TOOL_DENO)
        .await
        .is_some()
        || sidecar::on_path("deno");
    EngineStatus {
        installed_version: installed,
        source: resolved.source.to_string(),
        engine_path: resolved.path.to_string_lossy().to_string(),
        ffmpeg_ok: ffmpeg_ok || ffmpeg_resolved.source != "system",
        ffmpeg_path: if ffmpeg_resolved.source == "system" {
            None
        } else {
            Some(ffmpeg_resolved.path.to_string_lossy().to_string())
        },
        deno_ok,
        last_checked: settings.last_engine_check,
        prefer_nightly: settings.prefer_nightly,
    }
}

async fn fetch_latest_release(prefer_nightly: bool) -> Result<GithubRelease, String> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo(prefer_nightly));
    let client = http_client()?;
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("release check failed (offline?): {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("release check: HTTP {}", resp.status()));
    }
    resp.json::<GithubRelease>()
        .await
        .map_err(|e| format!("release parse: {e}"))
}

fn asset_url(release: &GithubRelease, name: &str) -> Result<String, String> {
    release
        .assets
        .iter()
        .find(|a| a.name == name)
        .map(|a| a.browser_download_url.clone())
        .ok_or_else(|| format!("asset {name} missing in {}", release.tag_name))
}

pub async fn check_for_update(
    app: &AppHandle,
    prefer_nightly: bool,
) -> Result<UpdateCheck, String> {
    let current = sidecar::tool_version(app, TOOL_YTDLP).await;
    let release = fetch_latest_release(prefer_nightly).await?;
    let latest = norm_tag(&release.tag_name);
    let asset_name = platform_asset_name().to_string();
    // Ensure the platform asset actually exists before advertising an update.
    asset_url(&release, &asset_name)?;
    let update_available = match &current {
        None => true, // no working engine at all — download required
        Some(cur) => norm_tag(cur) != latest && latest > norm_tag(cur),
    };
    Ok(UpdateCheck {
        current,
        latest,
        update_available,
        asset_name,
        repo: repo(prefer_nightly).to_string(),
    })
}

async fn download_to(
    client: &reqwest::Client,
    url: &str,
    dest: &PathBuf,
    app: &AppHandle,
    stage: &str,
) -> Result<(), String> {
    use futures_util::StreamExt;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {}: {url}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut stream = resp.bytes_stream();
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut done: u64 = 0;
    {
        use tokio::io::AsyncWriteExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("stream: {e}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("write: {e}"))?;
            done += chunk.len() as u64;
            if total > 0 {
                let pct = (done as f64 / total as f64 * 100.0).min(100.0);
                let _ = app.emit(
                    "engine-progress",
                    EngineProgress {
                        stage: stage.to_string(),
                        percent: Some((pct * 10.0).round() / 10.0),
                        detail: format!("{done}/{total} bytes"),
                    },
                );
            }
        }
        file.flush().await.map_err(|e| format!("flush: {e}"))?;
    }
    Ok(())
}

fn sha256_file(path: &PathBuf) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read for hash: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn expected_hash(sums_text: &str, asset_name: &str) -> Result<String, String> {
    for line in sums_text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Formats: "<hash>  <filename>" or "<hash> *<filename>"
        let mut parts = line.split_whitespace();
        let hash = parts.next().unwrap_or("");
        let file = parts.next().unwrap_or("").trim_start_matches('*');
        // Sums list bare filenames; match exact or suffix (some are ./ prefixed).
        if file == asset_name || file.ends_with(&format!("/{asset_name}")) {
            if hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
                return Ok(hash.to_lowercase());
            }
        }
    }
    Err(format!("checksum for {asset_name} not in SHA2-256SUMS"))
}

/// Download + verify + atomically swap the engine. Emits `engine-progress`.
pub async fn update_engine(
    app: &AppHandle,
    prefer_nightly: bool,
) -> Result<UpdateResult, String> {
    let check = check_for_update(app, prefer_nightly).await?;
    if !check.update_available {
        let cur = check.current.clone().unwrap_or_else(|| "unknown".to_string());
        return Ok(UpdateResult {
            updated: false,
            previous: check.current,
            current: cur,
            repo: check.repo,
        });
    }

    let release = fetch_latest_release(prefer_nightly).await?;
    let bin_url = asset_url(&release, &check.asset_name)?;
    let sums_url = asset_url(&release, "SHA2-256SUMS")?;

    let bin_dir = sidecar::user_bin_dir(app)?;
    std::fs::create_dir_all(&bin_dir).map_err(|e| format!("mkdir bin: {e}"))?;
    let live = bin_dir.join(sidecar::exe_name(TOOL_YTDLP));
    let tmp_bin = bin_dir.join(format!("{}.new", sidecar::exe_name(TOOL_YTDLP)));
    let tmp_sums = bin_dir.join("SHA2-256SUMS.new");
    let _ = std::fs::remove_file(&tmp_bin);
    let _ = std::fs::remove_file(&tmp_sums);

    let client = http_client()?;
    let _ = app.emit(
        "engine-progress",
        EngineProgress {
            stage: "download".to_string(),
            percent: Some(0.0),
            detail: format!("downloading {} {}", check.repo, check.latest),
        },
    );
    download_to(&client, &bin_url, &tmp_bin, app, "download").await?;
    download_to(&client, &sums_url, &tmp_sums, app, "checksums").await?;

    // Mandatory checksum verification.
    let sums_text =
        std::fs::read_to_string(&tmp_sums).map_err(|e| format!("read sums: {e}"))?;
    let expected = expected_hash(&sums_text, &check.asset_name)?;
    let actual = sha256_file(&tmp_bin)?;
    if expected != actual {
        let _ = std::fs::remove_file(&tmp_bin);
        let _ = std::fs::remove_file(&tmp_sums);
        return Err("checksum mismatch — download discarded, engine untouched".to_string());
    }

    let previous = sidecar::tool_version(app, TOOL_YTDLP).await;

    // Atomic swap: .new → .old → live (same volume, so renames are atomic).
    let backup = bin_dir.join(format!("{}.old", sidecar::exe_name(TOOL_YTDLP)));
    if live.exists() {
        let _ = std::fs::remove_file(&backup);
        std::fs::rename(&live, &backup).map_err(|e| format!("backup live: {e}"))?;
    }
    if let Err(e) = std::fs::rename(&tmp_bin, &live) {
        // Roll back: restore backup.
        if backup.exists() {
            let _ = std::fs::rename(&backup, &live);
        }
        return Err(format!("activate new engine: {e}"));
    }
    let _ = std::fs::remove_file(&tmp_sums);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&live) {
            let mut p = meta.permissions();
            p.set_mode(0o755);
            let _ = std::fs::set_permissions(&live, p);
        }
    }

    // Confirm the swapped binary actually runs.
    let confirmed = sidecar::tool_version(app, TOOL_YTDLP).await.ok_or_else(|| {
        if backup.exists() {
            let _ = std::fs::remove_file(&live);
            let _ = std::fs::rename(&backup, &live);
        }
        "new engine failed --version — rolled back".to_string()
    })?;

    stamp_check(app);
    let _ = app.emit(
        "engine-progress",
        EngineProgress {
            stage: "done".to_string(),
            percent: Some(100.0),
            detail: format!("engine {confirmed}"),
        },
    );
    Ok(UpdateResult {
        updated: true,
        previous,
        current: confirmed,
        repo: check.repo,
    })
}

fn stamp_check(app: &AppHandle) {
    let mut settings = load_settings(app);
    settings.last_engine_check = Some(chrono::Utc::now().timestamp());
    let _ = save_settings(app, &settings);
}

/// Launch-time entry: max once/24h, silent, offline-tolerant.
/// Emits `engine-status` when finished (quiet success or quiet keep-existing).
pub async fn auto_check_and_update(app: AppHandle) {
    let settings = load_settings(&app);
    let now = chrono::Utc::now().timestamp();
    if let Some(last) = settings.last_engine_check {
        if now - last < CHECK_INTERVAL_SECS {
            return; // checked recently — stay quiet
        }
    }
    // Mark the attempt first so a crash/offline doesn't spin every launch.
    stamp_check(&app);

    let prefer = settings.prefer_nightly;
    let status_before = engine_status(&app).await;
    match check_for_update(&app, prefer).await {
        Ok(check) if check.update_available => {
            match update_engine(&app, prefer).await {
                Ok(_) => {
                    let _ = app.emit("engine-status", engine_status(&app).await);
                }
                Err(e) => {
                    // Failed update → serve existing sidecar with quiet status.
                    let _ = app.emit(
                        "engine-status",
                        serde_json::json!({
                            "ok": false,
                            "error": e,
                            "engine": status_before,
                        }),
                    );
                }
            }
        }
        Ok(_) => {
            let _ = app.emit("engine-status", engine_status(&app).await);
        }
        Err(_) => {
            // Offline / API failure → quiet: existing engine keeps serving.
        }
    }
}
