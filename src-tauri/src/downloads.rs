//! Download orchestration: metadata preview (`-J`), quality-selected downloads
//! with progress events, and cancellation.
//!
//! The Rust side never implements fetching itself — it spawns the yt-dlp
//! sidecar, parses its machine-readable output, and relays typed events:
//! `download-progress`, `download-complete`, `download-error`,
//! `download-cancelled`. The queue lives in the frontend (zustand).

use crate::settings::{effective_download_dir, load_settings};
use crate::sidecar::{self, TOOL_YTDLP};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatInfo {
    pub format_id: String,
    pub ext: String,
    pub resolution: Option<String>,
    pub height: Option<u64>,
    pub width: Option<u64>,
    pub fps: Option<f64>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    /// Best-known size in bytes: exact `filesize` when present, else
    /// `filesize_approx`, else estimated from `tbr * duration`.
    pub filesize: Option<u64>,
    /// True when `filesize` is approximated (yt-dlp estimate or ours),
    /// so the UI can render `~12.4 MiB` instead of faking precision.
    pub filesize_approx: bool,
    pub tbr: Option<f64>,
    pub vbr: Option<f64>,
    pub abr: Option<f64>,
    pub asr: Option<f64>,
    pub audio_channels: Option<u64>,
    pub dynamic_range: Option<String>,
    pub language: Option<String>,
    pub format_note: Option<String>,
    pub protocol: Option<String>,
    pub is_video: bool,
    pub is_audio: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMetadata {
    pub id: String,
    pub title: String,
    pub uploader: Option<String>,
    pub channel: Option<String>,
    pub duration: Option<u64>,
    pub view_count: Option<u64>,
    pub upload_date: Option<String>,
    pub description: Option<String>,
    pub thumbnail: Option<String>,
    pub webpage_url: String,
    pub formats: Vec<FormatInfo>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub id: String,
    pub url: String,
    pub format_selector: String,
    pub audio_only: bool,
    pub output_dir: Option<String>,
    pub extra_args: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub id: String,
    pub percent: Option<f64>,
    pub total: Option<String>,
    pub speed: Option<String>,
    pub eta: Option<String>,
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoneEvent {
    pub id: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailEvent {
    pub id: String,
    pub error: String,
}

/// Live download handles for cancellation.
pub struct ActiveDownload {
    pub child: Arc<tokio::sync::Mutex<tokio::process::Child>>,
    pub cancelled: Arc<AtomicBool>,
}

pub type ActiveMap = Mutex<HashMap<String, ActiveDownload>>;

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

fn u64_field(v: &serde_json::Value, key: &str) -> Option<u64> {
    v.get(key).and_then(|x| {
        x.as_u64().or_else(|| {
            x.as_f64()
                .filter(|f| f.is_finite() && *f >= 0.0)
                .map(|f| f as u64)
        })
    })
}

fn f64_field(v: &serde_json::Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| {
        x.as_f64().or_else(|| x.as_u64().map(|n| n as f64))
    })
}

fn pick_thumbnail(v: &serde_json::Value) -> Option<String> {
    let mut best: Option<(u64, String)> = None;
    if let Some(arr) = v.get("thumbnails").and_then(|t| t.as_array()) {
        for t in arr {
            let url = match t.get("url").and_then(|u| u.as_str()) {
                Some(u) => u.to_string(),
                None => continue,
            };
            let w = t.get("width").and_then(|x| x.as_u64()).unwrap_or(0);
            let h = t.get("height").and_then(|x| x.as_u64()).unwrap_or(0);
            let score = w.saturating_mul(h);
            let better = match &best {
                None => true,
                Some((s, _)) => score > *s,
            };
            if better {
                best = Some((score, url));
            }
        }
    }
    best.map(|(_, u)| u).or_else(|| str_field(v, "thumbnail"))
}

/// Storyboard / image-sprite pseudo-formats are not downloadable videos.
/// They ride along in `-J` (ext/protocol `mhtml`, ids `sb0..sbN`) and must be
/// dropped explicitly — codec flags alone are too fragile to key on.
fn is_junk_format(format_id: &str, ext: &str, protocol: Option<&str>, note: Option<&str>) -> bool {
    if ext == "mhtml" || ext == "jpg" || ext == "png" || ext == "webp" {
        return true;
    }
    if matches!(protocol, Some("mhtml")) {
        return true;
    }
    if matches!(note, Some("storyboard")) {
        return true;
    }
    // sb0, sb1, ... storyboard sprites
    if format_id.len() > 2 && format_id.starts_with("sb") && format_id[2..].chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    false
}

fn map_format(f: &serde_json::Value, duration: Option<u64>) -> Option<FormatInfo> {
    let format_id = f
        .get("format_id")
        .and_then(|x| x.as_str())?
        .to_string();
    let ext = f
        .get("ext")
        .and_then(|x| x.as_str())
        .unwrap_or("?")
        .to_string();
    let protocol = f.get("protocol").and_then(|x| x.as_str());
    let format_note = str_field(f, "format_note");
    if is_junk_format(&format_id, &ext, protocol, format_note.as_deref()) {
        return None;
    }
    let vcodec = f
        .get("vcodec")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let acodec = f
        .get("acodec")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let is_video = matches!(&vcodec, Some(c) if c != "none");
    let is_audio = matches!(&acodec, Some(c) if c != "none");

    // Size: exact first, yt-dlp's approx second, tbr*duration estimate last.
    // tbr/vbr/abr are kbps = 1000 bits/s, so bytes = tbr * duration * 125.
    let tbr = f64_field(f, "tbr");
    let (filesize, filesize_approx) = match (
        u64_field(f, "filesize"),
        u64_field(f, "filesize_approx"),
    ) {
        (Some(b), _) => (Some(b), false),
        (None, Some(b)) => (Some(b), true),
        (None, None) => match (tbr, duration) {
            (Some(t), Some(d)) if t.is_finite() && t > 0.0 && d > 0 => {
                let est = (t * d as f64 * 125.0) as u64;
                (Some(est), true)
            }
            _ => (None, false),
        },
    };

    Some(FormatInfo {
        format_id,
        ext,
        resolution: str_field(f, "resolution"),
        height: u64_field(f, "height"),
        width: u64_field(f, "width"),
        fps: f64_field(f, "fps"),
        vcodec,
        acodec,
        filesize,
        filesize_approx,
        tbr,
        vbr: f64_field(f, "vbr"),
        abr: f64_field(f, "abr"),
        asr: f64_field(f, "asr"),
        audio_channels: u64_field(f, "audio_channels"),
        dynamic_range: str_field(f, "dynamic_range"),
        language: str_field(f, "language"),
        format_note,
        protocol: protocol.map(|s| s.to_string()),
        is_video,
        is_audio,
    })
}

/// Selection flags (`-f`, `--match-filter`, …) must never leak into the
/// metadata fetch: they would silently filter the dumped format list, so the
/// picker would show a subset as if it were everything. Strip them (and their
/// values) from user passthrough args on the `-J` path only.
/// Human stage text for yt-dlp status lines, so the UI stays alive during
/// the extraction phase when no percent exists yet (webpage + player API
/// reads can take 5–15s of apparent "0%").
fn friendly_stage(line: &str) -> Option<String> {
    let t = line.trim();
    let body = t
        .strip_prefix("[youtube]")
        .map(str::trim)
        .or_else(|| t.strip_prefix("[info]").map(str::trim))
        .or_else(|| t.strip_prefix("[generic]").map(str::trim))?;
    if body.contains("Downloading webpage") {
        Some("Contacting YouTube…".to_string())
    } else if body.contains("player API JSON") {
        Some("Reading player…".to_string())
    } else if body.contains("m3u8") {
        Some("Reading streams…".to_string())
    } else if body.contains("format(s)") {
        Some("Starting download…".to_string())
    } else if body.contains("Downloading") && body.len() < 160 {
        Some(body.to_string())
    } else {
        None
    }
}

fn strip_selection_args(args: &[String]) -> Vec<String> {
    const WITH_VALUE: &[&str] = &[
        "-f", "--format",
        "--match-filter", "--match-filter-range",
        "-I", "--playlist-items",
        "--min-filesize", "--max-filesize",
        "--min-views", "--max-views",
    ];
    let mut out = Vec::with_capacity(args.len());
    let mut skip_next = false;
    for a in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        // --flag=value form
        if a.starts_with("--") && a.contains('=') {
            let key = a.split('=').next().unwrap_or("");
            if WITH_VALUE.contains(&key) {
                continue;
            }
            out.push(a.clone());
            continue;
        }
        if WITH_VALUE.contains(&a.as_str()) {
            skip_next = true;
            continue;
        }
        out.push(a.clone());
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchProgress {
    pub id: String,
    pub stage: String,
}

pub async fn fetch_metadata_impl(
    app: &AppHandle,
    url: &str,
    extra_args: Option<String>,
    fetch_id: Option<String>,
) -> Result<VideoMetadata, String> {
    let mut args = vec![
        "--no-playlist".to_string(),
        "--dump-single-json".to_string(),
        "--no-warnings".to_string(),
        "--no-progress".to_string(),
        "--socket-timeout".to_string(),
        "20".to_string(),
        // Verbose keeps stdout pure JSON (verified) while stderr carries the
        // extraction chatter we stream as live stages.
        "--verbose".to_string(),
    ];
    let extra = extra_args
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| load_settings(app).extra_args);
    args.extend(strip_selection_args(&sidecar::split_extra_args(&extra)));
    args.extend(sidecar::engine_wiring_args(app));
    args.push(url.to_string());

    let mut child = sidecar::spawn_tool(app, TOOL_YTDLP, &args)?;
    let pid = child.id();
    let stdout = child.stdout.take().map(BufReader::new);
    let stderr = child.stderr.take();

    // Drain stderr: stream extraction stages, keep a tail for error reports.
    let app_err = app.clone();
    let fid_err = fetch_id.clone();
    let err_task = tokio::spawn(async move {
        let mut tail: Vec<String> = Vec::new();
        if let Some(s) = stderr {
            let mut r = BufReader::new(s).lines();
            while let Ok(Some(line)) = r.next_line().await {
                let t = line.trim();
                if t.is_empty() {
                    continue;
                }
                if let (Some(fid), Some(stage)) =
                    (fid_err.as_ref(), friendly_stage(t))
                {
                    let _ = app_err.emit(
                        "fetch-progress",
                        FetchProgress {
                            id: fid.clone(),
                            stage,
                        },
                    );
                }
                tail.push(t.to_string());
                if tail.len() > 30 {
                    tail.remove(0);
                }
            }
        }
        tail
    });

    // Accumulate stdout (the JSON document).
    let out_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        if let Some(s) = stdout {
            let mut r = BufReader::new(s);
            let _ = r.read_to_end(&mut buf).await;
        }
        buf
    });

    let joined = tokio::time::timeout(
        std::time::Duration::from_secs(90),
        async {
            let buf = out_task.await.unwrap_or_default();
            let tail = err_task.await.unwrap_or_default();
            let status = child.wait().await.map_err(|e| format!("wait: {e}"))?;
            Ok::<_, String>((buf, tail, status))
        },
    )
    .await;
    let (buf, tail, status) = match joined {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            // Timed out: tear the tree down so nothing lingers.
            #[cfg(windows)]
            if let Some(pid) = pid {
                let _ = tokio::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .await;
            }
            return Err("metadata fetch timed out (network slow?)".to_string());
        }
    };

    if !status.success() {
        let msg = tail
            .iter()
            .rev()
            .find(|l| !l.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| format!("yt-dlp exited with {status}"));
        // Surface the last meaningful line (yt-dlp prefixes with ERROR:).
        return Err(msg);
    }

    let text = String::from_utf8_lossy(&buf);
    let doc = text.trim();
    let json = &doc[doc.find('{').unwrap_or(0)..];
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("metadata parse: {e}"))?;

    if v.get("_type").and_then(|t| t.as_str()) == Some("playlist") {
        return Err("playlists land in v0.2 — paste a single video URL for now".to_string());
    }

    let duration = u64_field(&v, "duration");
    let formats = v
        .get("formats")
        .and_then(|f| f.as_array())
        .map(|arr| arr.iter().filter_map(|f| map_format(f, duration)).collect())
        .unwrap_or_default();

    let description = str_field(&v, "description").map(|d| {
        const MAX: usize = 2000;
        if d.len() > MAX {
            format!("{}…", &d[..MAX])
        } else {
            d
        }
    });

    Ok(VideoMetadata {
        id: str_field(&v, "id").unwrap_or_else(|| "unknown".to_string()),
        title: str_field(&v, "title").unwrap_or_else(|| url.to_string()),
        uploader: str_field(&v, "uploader"),
        channel: str_field(&v, "channel"),
        duration,
        view_count: u64_field(&v, "view_count"),
        upload_date: str_field(&v, "upload_date"),
        description,
        thumbnail: pick_thumbnail(&v),
        webpage_url: str_field(&v, "webpage_url").unwrap_or_else(|| url.to_string()),
        formats,
    })
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

fn emit_progress(app: &AppHandle, ev: &ProgressEvent) {
    let _ = app.emit("download-progress", ev);
}

fn parse_progress_line(re: &Regex, line: &str) -> Option<(f64, Option<String>, Option<String>, Option<String>)> {
    let caps = re.captures(line)?;
    let pct: f64 = caps.get(1)?.as_str().parse().ok()?;
    let total = caps.get(2).map(|m| m.as_str().to_string());
    let speed = caps.get(3).map(|m| m.as_str().to_string());
    let eta = caps.get(4).map(|m| m.as_str().to_string());
    Some((pct, total, speed, eta))
}

fn strip_quotes(s: &str) -> String {
    let t = s.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

/// yt-dlp downloads DASH/HLS fragments sequentially unless told otherwise
/// (`-N` defaults to 1). For an offline-first downloader pulling GB-scale
/// merges, fragment parallelism is the main bandwidth lever — single-file
/// progressive streams are the only case it can't help (those need an
/// external downloader like aria2c; future work, not a new sidecar today).
/// Returns the default flags unless the user already tuned `-N` themselves.
fn default_fragment_args(extra: &[String], fragments: u32) -> Vec<String> {
    let tuned = extra.iter().any(|a| {
        a == "-N"
            || a == "--concurrent-fragments"
            || a.starts_with("--concurrent-fragments=")
    });
    if tuned {
        Vec::new()
    } else {
        vec![
            "--concurrent-fragments".to_string(),
            fragments.to_string(),
        ]
    }
}

pub async fn start_download_impl(
    app: AppHandle,
    active: Arc<ActiveMap>,
    req: StartRequest,
) -> Result<(), String> {
    if req.id.trim().is_empty() {
        return Err("missing queue id".to_string());
    }
    {
        let map = active.lock().map_err(|e| format!("lock: {e}"))?;
        if map.contains_key(&req.id) {
            return Err("download already running for this item".to_string());
        }
    }

    let output_dir = match req.output_dir.filter(|s| !s.trim().is_empty()) {
        Some(d) => {
            std::fs::create_dir_all(&d).map_err(|e| format!("mkdir output: {e}"))?;
            d
        }
        None => effective_download_dir(&app)?,
    };

    let mut args = vec![
        "--no-playlist".to_string(),
        "--newline".to_string(),
        "--progress".to_string(),
        "--no-color".to_string(),
        "--no-warnings".to_string(),
        // Explicit even though it's yt-dlp's default: interrupted downloads
        // (cancel, crash, restart) continue from `.part` files instead of
        // starting over. Same output template => same resume point.
        "--continue".to_string(),
        "-f".to_string(),
        req.format_selector.clone(),
        "-o".to_string(),
        format!("{}/%(title)s [%(id)s].%(ext)s", output_dir.replace('\\', "/")),
    ];
    if req.audio_only {
        args.push("-x".to_string());
        args.push("--audio-format".to_string());
        args.push("mp3".to_string());
        args.push("--audio-quality".to_string());
        args.push("0".to_string());
    } else {
        args.push("--merge-output-format".to_string());
        args.push("mp4".to_string());
    }
    if let Some(loc) = sidecar::ffmpeg_location(&app) {
        args.push("--ffmpeg-location".to_string());
        args.push(loc);
    }
    if let Some(deno) = sidecar::deno_sidecar_path(&app) {
        args.push("--js-runtimes".to_string());
        args.push(format!("deno:{deno}"));
    }
    let extra = req
        .extra_args
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| load_settings(&app).extra_args);
    let extra_list = sidecar::split_extra_args(&extra);
    args.extend(extra_list.clone());
    // Fragment count: explicit user value wins; otherwise Auto measures the
    // line fresh on every press (1 MB, ~a second) so the count tracks the
    // network you're actually on — hotspot vs fibre, peak vs off-peak.
    let fragments = match load_settings(&app).concurrent_fragments {
        Some(n) => n.clamp(1, 16),
        None => match crate::net::probe_now(&app).await {
            Some(mbps) if mbps.is_finite() && mbps > 0.0 => {
                crate::net::fragments_for_mbps(mbps)
            }
            _ => crate::settings::effective_fragments(&app),
        },
    };
    args.extend(default_fragment_args(&extra_list, fragments));
    args.push(req.url.clone());

    let child = sidecar::spawn_tool(&app, TOOL_YTDLP, &args)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let handle = Arc::new(tokio::sync::Mutex::new(child));
    {
        let mut map = active.lock().map_err(|e| format!("lock: {e}"))?;
        map.insert(
            req.id.clone(),
            ActiveDownload {
                child: handle.clone(),
                cancelled: cancelled.clone(),
            },
        );
    }

    let app_task = app.clone();
    let id = req.id.clone();
    let active_task = active.clone();
    tokio::spawn(async move {
        let prog_re = Regex::new(
            r"^\[download\]\s+(\d+(?:\.\d+)?)% of\s+(\S+)(?:\s+at\s+(\S+))?(?:\s+ETA\s+(\S+))?",
        )
        .expect("progress regex");
        let dest_re =
            Regex::new(r"^\[download\] Destination: (.+)$").expect("dest regex");
        let merge_re = Regex::new(r#"^\[(?:Merger|ExtractAudio|VideoConvertor)\][^"]*"([^"]+)""#)
            .expect("merge regex");

        let mut final_path: Option<String> = None;
        let mut last_error_lines: Vec<String> = Vec::new();

        // Take stdout for the progress loop; drain stderr separately so a
        // chatty yt-dlp can never block on a full pipe.
        let (stdout_lines, stderr_handle) = {
            let mut guard = handle.lock().await;
            let stdout = guard.stdout.take().map(BufReader::new);
            let stderr = guard.stderr.take();
            let lines = stdout.map(|r| r.lines());
            let app_err = app_task.clone();
            let id_err = id.clone();
            let drain = tokio::spawn(async move {
                let mut tail: Vec<String> = Vec::new();
                if let Some(s) = stderr {
                    let mut r = BufReader::new(s).lines();
                    while let Ok(Some(line)) = r.next_line().await {
                        let t = line.trim().to_string();
                        if t.is_empty() {
                            continue;
                        }
                        if t.contains("ERROR") || t.contains("WARNING: ") {
                            // Surface warnings live as detail updates.
                            emit_progress(
                                &app_err,
                                &ProgressEvent {
                                    id: id_err.clone(),
                                    percent: None,
                                    total: None,
                                    speed: None,
                                    eta: None,
                                    status: "downloading".to_string(),
                                    detail: Some(t.clone()),
                                },
                            );
                        }
                        tail.push(t);
                        if tail.len() > 20 {
                            tail.remove(0);
                        }
                    }
                }
                tail
            });
            (lines, drain)
        };

        if let Some(mut lines) = stdout_lines {
            while let Ok(Some(line)) = lines.next_line().await {
                let t = line.trim();
                if t.is_empty() {
                    continue;
                }
                if let Some(caps) = dest_re.captures(t) {
                    if let Some(m) = caps.get(1) {
                        final_path = Some(strip_quotes(m.as_str()));
                    }
                    continue;
                }
                if let Some(caps) = merge_re.captures(t) {
                    if let Some(m) = caps.get(1) {
                        final_path = Some(strip_quotes(m.as_str()));
                    }
                    emit_progress(
                        &app_task,
                        &ProgressEvent {
                            id: id.clone(),
                            percent: Some(100.0),
                            total: None,
                            speed: None,
                            eta: None,
                            status: "merging".to_string(),
                            detail: Some(t.to_string()),
                        },
                    );
                    continue;
                }
                if let Some((pct, total, speed, eta)) = parse_progress_line(&prog_re, t) {
                    emit_progress(
                        &app_task,
                        &ProgressEvent {
                            id: id.clone(),
                            percent: Some((pct * 10.0).round() / 10.0),
                            total,
                            speed,
                            eta,
                            status: "downloading".to_string(),
                            detail: None,
                        },
                    );
                    continue;
                }
                // Extraction chatter ([youtube]/[info]) → live stage text.
                if let Some(stage) = friendly_stage(t) {
                    emit_progress(
                        &app_task,
                        &ProgressEvent {
                            id: id.clone(),
                            percent: None,
                            total: None,
                            speed: None,
                            eta: None,
                            status: "downloading".to_string(),
                            detail: Some(stage),
                        },
                    );
                    continue;
                }
                if t.starts_with("ERROR") {
                    last_error_lines.push(t.to_string());
                }
            }
        }

        let stderr_tail = stderr_handle.await.unwrap_or_default();
        if last_error_lines.is_empty() {
            last_error_lines = stderr_tail
                .into_iter()
                .filter(|l| l.contains("ERROR"))
                .collect();
        }

        let status = {
            let mut guard = handle.lock().await;
            guard.wait().await.ok()
        };
        let success = status.map(|s| s.success()).unwrap_or(false);
        let was_cancelled = cancelled.load(Ordering::SeqCst);

        // Release the slot so retries start clean — but only if the entry is
        // still ours. Cancel removes the entry up front; a retry racing the
        // old task's exit must not have its fresh entry deleted here.
        if let Ok(mut map) = active_task.lock() {
            let ours = map
                .get(&id)
                .map(|a| Arc::ptr_eq(&a.child, &handle))
                .unwrap_or(false);
            if ours {
                map.remove(&id);
            }
        }
        if was_cancelled {
            let _ = app_task.emit("download-cancelled", DoneEvent { id: id.clone(), path: None });
        } else if success {
            let _ = app_task.emit(
                "download-complete",
                DoneEvent {
                    id: id.clone(),
                    path: final_path,
                },
            );
        } else {
            let error = last_error_lines
                .last()
                .cloned()
                .unwrap_or_else(|| {
                    status
                        .map(|s| format!("yt-dlp exited with {s}"))
                        .unwrap_or_else(|| "download failed".to_string())
                });
            let _ = app_task.emit(
                "download-error",
                FailEvent {
                    id: id.clone(),
                    error,
                },
            );
        }
    });

    Ok(())
}

pub async fn cancel_download_impl(active: &ActiveMap, id: &str) -> Result<bool, String> {
    // Take the entry out of the map first so a retry can start immediately
    // even while the old process is still dying.
    let entry = {
        let mut map = active.lock().map_err(|e| format!("lock: {e}"))?;
        match map.remove(id) {
            Some(a) => (a.child.clone(), a.cancelled.clone()),
            None => return Ok(false),
        }
    };
    let (child, flag) = entry;
    flag.store(true, Ordering::SeqCst);
    let mut guard = child.lock().await;
    sidecar::kill_child(&mut guard).await;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fmt(id: &str) -> serde_json::Value {
        json!({"format_id": id, "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a"})
    }

    #[test]
    fn junk_storyboards_dropped() {
        assert!(map_format(&json!({"format_id": "sb3", "ext": "mhtml", "protocol": "mhtml",
            "format_note": "storyboard", "vcodec": "none", "acodec": "none"}), Some(60)).is_none());
        assert!(map_format(&json!({"format_id": "sb0", "ext": "mhtml", "vcodec": "none",
            "acodec": "none"}), Some(60)).is_none());
        assert!(map_format(&fmt("22"), Some(60)).is_some());
    }

    #[test]
    fn size_prefers_exact_then_approx_then_tbr_estimate() {
        // Exact.
        let f = map_format(&json!({"format_id": "22", "ext": "mp4", "vcodec": "avc1",
            "acodec": "mp4a", "filesize": 1000, "filesize_approx": 2000, "tbr": 500}), Some(60)).unwrap();
        assert_eq!((f.filesize, f.filesize_approx), (Some(1000), false));
        // yt-dlp approx.
        let f = map_format(&json!({"format_id": "248", "ext": "webm", "vcodec": "vp9",
            "acodec": "none", "filesize_approx": 2000, "tbr": 500}), Some(60)).unwrap();
        assert_eq!((f.filesize, f.filesize_approx), (Some(2000), true));
        // tbr * duration * 125 (tbr is kbps = 1000 bits/s).
        let f = map_format(&json!({"format_id": "313", "ext": "webm", "vcodec": "vp9",
            "acodec": "none", "tbr": 1000.0}), Some(60)).unwrap();
        assert_eq!((f.filesize, f.filesize_approx), (Some(1000 * 60 * 125), true));
        // Nothing known.
        let f = map_format(&json!({"format_id": "x", "ext": "mp4", "vcodec": "avc1",
            "acodec": "none"}), None).unwrap();
        assert_eq!((f.filesize, f.filesize_approx), (None, false));
    }

    #[test]
    fn keeps_height_and_separate_bitrates() {
        let f = map_format(&json!({"format_id": "137", "ext": "mp4", "vcodec": "avc1",
            "acodec": "none", "height": 1080, "width": 1920, "fps": 30,
            "vbr": 4500.5, "abr": null, "dynamic_range": "HDR10",
            "protocol": "https"}), Some(60)).unwrap();
        assert_eq!(f.height, Some(1080));
        assert_eq!(f.width, Some(1920));
        assert_eq!(f.vbr, Some(4500.5));
        assert_eq!(f.abr, None);
        assert_eq!(f.dynamic_range.as_deref(), Some("HDR10"));
        assert!(f.is_video && !f.is_audio);
    }

    #[test]
    fn fragment_parallelism_default_and_override() {
        let empty: Vec<String> = vec![];
        assert_eq!(
            default_fragment_args(&empty, 4),
            vec!["--concurrent-fragments".to_string(), "4".to_string()]
        );
        assert_eq!(
            default_fragment_args(&empty, 8),
            vec!["--concurrent-fragments".to_string(), "8".to_string()]
        );
        for tuned in [
            vec!["-N", "8"],
            vec!["--concurrent-fragments", "8"],
            vec!["--concurrent-fragments=8"],
        ] {
            let args: Vec<String> = tuned.iter().map(|s| s.to_string()).collect();
            assert!(default_fragment_args(&args, 4).is_empty(), "{tuned:?}");
        }
    }

    #[test]
    fn strips_selection_args_from_metadata_fetch() {
        let args: Vec<String> = ["--socket-timeout", "30", "-f", "bv[height<=720]",
            "--extractor-args", "youtube:player-client=default",
            "--match-filter", "duration>60", "--format-sort", "res",
            "--min-views", "1000", "--remux-video", "mkv"]
            .iter().map(|s| s.to_string()).collect();
        let got = strip_selection_args(&args);
        let want: Vec<String> = ["--socket-timeout", "30", "--extractor-args",
            "youtube:player-client=default", "--format-sort", "res", "--remux-video", "mkv"]
            .iter().map(|s| s.to_string()).collect();
        assert_eq!(got, want);
    }
}
