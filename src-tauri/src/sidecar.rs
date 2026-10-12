//! Sidecar resolution + spawning.
//!
//! Lookup order for every engine binary (yt-dlp, ffmpeg, deno):
//!   1. per-user updated copy — `<app_data>/offtube/bin/<name>` (written by
//!      the engine updater, always preferred so updates take effect without
//!      touching the read-only install dir),
//!   2. bundled Tauri sidecar — `resource_dir/binaries/<tool>[-<triple>].exe`,
//!      plus the dev layout `src-tauri/binaries/...`,
//!   3. system PATH fallback — plain `yt-dlp` / `ffmpeg` / `deno`
//!      (lets `cargo tauri dev` work on a fresh clone before binaries exist).
//!
//! Spawning goes through `tokio::process` (via `tauri-plugin-shell`'s
//! sidecar-aware resolution order) so the backend owns streaming stdout,
//! progress parsing and killing outright. The updater only ever writes to
//! (1), so Program Files stays untouched.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const TOOL_YTDLP: &str = "yt-dlp";
pub const TOOL_FFMPEG: &str = "ffmpeg";
pub const TOOL_DENO: &str = "deno";

pub fn exe_name(tool: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{tool}.exe")
    } else {
        tool.to_string()
    }
}

/// Writable per-user bin dir: `<app_data>/offtube/bin`.
pub fn user_bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    Ok(dir.join("offtube").join("bin"))
}

pub fn user_tool_path(app: &AppHandle, tool: &str) -> Result<PathBuf, String> {
    Ok(user_bin_dir(app)?.join(exe_name(tool)))
}

/// Directory that holds the bundled (read-only) sidecars, if resolvable.
pub fn bundled_tool_path(app: &AppHandle, tool: &str) -> Option<PathBuf> {
    let exe = exe_name(tool);

    // Release layout: <resource_dir>/binaries/...
    if let Ok(resource_dir) = app.path().resource_dir() {
        let direct = resource_dir.join("binaries").join(&exe);
        if direct.is_file() {
            return Some(direct);
        }
        if let Ok(entries) = std::fs::read_dir(resource_dir.join("binaries")) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    let lower = name.to_lowercase();
                    if lower.starts_with(&format!("{tool}-"))
                        || lower.starts_with(&format!("{tool}_"))
                    {
                        return Some(entry.path());
                    }
                }
            }
        }
    }

    // Dev layout: src-tauri/binaries/<tool>[-<triple>].exe
    let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    if let Ok(entries) = std::fs::read_dir(&dev_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                let lower = name.to_lowercase();
                if lower == exe.to_lowercase()
                    || lower.starts_with(&format!("{tool}-"))
                    || lower.starts_with(&format!("{tool}_"))
                {
                    return Some(entry.path());
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct ResolvedTool {
    /// Absolute path, or bare tool name for PATH fallback.
    pub path: PathBuf,
    /// "updated" | "bundled" | "system"
    pub source: &'static str,
}

pub fn resolve_tool(app: &AppHandle, tool: &str) -> ResolvedTool {
    if let Ok(p) = user_tool_path(app, tool) {
        if p.is_file() {
            return ResolvedTool {
                path: p,
                source: "updated",
            };
        }
    }
    if let Some(p) = bundled_tool_path(app, tool) {
        ensure_executable(&p);
        return ResolvedTool {
            path: p,
            source: "bundled",
        };
    }
    ResolvedTool {
        path: PathBuf::from(exe_name(tool)),
        source: "system",
    }
}

#[cfg(unix)]
fn ensure_executable(p: &PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(p) {
        let mut perm = meta.permissions();
        if perm.mode() & 0o111 == 0 {
            perm.set_mode(0o755);
            let _ = std::fs::set_permissions(p, perm);
        }
    }
}

#[cfg(not(unix))]
fn ensure_executable(_p: &PathBuf) {}

/// PATH with user-bin + bundled dirs prepended, so yt-dlp finds the deno
/// sidecar (signature challenges) and ffmpeg sidecar (merging) on its own.
pub fn augmented_path(app: &AppHandle) -> String {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(d) = user_bin_dir(app) {
        dirs.push(d);
    }
    if let Ok(res) = app.path().resource_dir() {
        dirs.push(res.join("binaries"));
    }
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));

    let sep = if cfg!(target_os = "windows") {
        ";"
    } else {
        ":"
    };
    let extra = dirs
        .iter()
        .map(|d| d.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(sep);
    let current = std::env::var("PATH").unwrap_or_default();
    format!("{extra}{sep}{current}")
}

fn base_command(program: &PathBuf) -> tokio::process::Command {
    let mut cmd = std::process::Command::new(program);
    // Don't flash a console window per spawn on Windows release builds.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    tokio::process::Command::from(cmd)
}

/// Spawn `tool` with piped stdio, PATH augmented for sidecar discovery.
pub fn spawn_tool(
    app: &AppHandle,
    tool: &str,
    args: &[String],
) -> Result<tokio::process::Child, String> {
    let resolved = resolve_tool(app, tool);
    let mut cmd = base_command(&resolved.path);
    cmd.args(args)
        .env("PATH", augmented_path(app))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(false);
    cmd.spawn()
        .map_err(|e| format!("spawn {} ({}): {e}", tool, resolved.path.display()))
}

/// Run to completion and capture output.
pub async fn run_tool_capture(
    app: &AppHandle,
    tool: &str,
    args: &[String],
) -> Result<std::process::Output, String> {
    let resolved = resolve_tool(app, tool);
    let mut cmd = base_command(&resolved.path);
    cmd.args(args).env("PATH", augmented_path(app));
    let child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn {} ({}): {e}", tool, resolved.path.display()))?;
    child
        .wait_with_output()
        .await
        .map_err(|e| format!("wait {tool}: {e}"))
}

/// Run `<tool> --version`, returning trimmed first line on success.
pub async fn tool_version(app: &AppHandle, tool: &str) -> Option<String> {
    let out = run_tool_capture(app, tool, &["--version".to_string()]).await.ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let first = v.lines().next().unwrap_or("").trim().to_string();
    if first.is_empty() {
        None
    } else {
        Some(first)
    }
}

/// Full path to a usable ffmpeg binary, for yt-dlp `--ffmpeg-location`
/// (which accepts the path to the binary itself — important because the
/// bundled sidecar carries a target-triple suffix, not the plain
/// `ffmpeg.exe` name yt-dlp would look up in a directory).
/// `None` means "let yt-dlp resolve ffmpeg from PATH itself".
pub fn ffmpeg_location(app: &AppHandle) -> Option<String> {
    let r = resolve_tool(app, TOOL_FFMPEG);
    if r.source == "system" {
        return None;
    }
    Some(r.path.to_string_lossy().to_string())
}

/// Full path to the deno sidecar for `--js-runtimes deno:<path>`
/// (same triple-suffix reasoning as ffmpeg). `None` → yt-dlp uses PATH.
pub fn deno_sidecar_path(app: &AppHandle) -> Option<String> {
    let r = resolve_tool(app, TOOL_DENO);
    if r.source == "system" {
        return None;
    }
    Some(r.path.to_string_lossy().to_string())
}

/// Extra argv that wires sidecar ffmpeg/deno into any yt-dlp invocation.
/// Must precede the URL; safe to include for metadata fetches too.
pub fn engine_wiring_args(app: &AppHandle) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(loc) = ffmpeg_location(app) {
        out.push("--ffmpeg-location".to_string());
        out.push(loc);
    }
    if let Some(deno) = deno_sidecar_path(app) {
        out.push("--js-runtimes".to_string());
        out.push(format!("deno:{deno}"));
    }
    out
}

/// Split free-form extra args (config-driven passthrough) on whitespace.
/// Quoting is intentionally not supported in v0.1 — keep flags simple.
pub fn split_extra_args(raw: &str) -> Vec<String> {
    raw.split_whitespace().map(|s| s.to_string()).collect()
}

/// Quick PATH probe used for status reporting.
pub fn on_path(program: &str) -> bool {
    let probe = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    std::process::Command::new(probe)
        .arg(program)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
