//! Bandwidth probe for Auto fragment parallelism.
//!
//! yt-dlp downloads DASH/HLS fragments sequentially unless `-N` is raised.
//! Rather than a fixed default, Auto mode measures the line once a day with
//! a small CDN fetch and maps the result to a fragment count. The probe runs
//! at startup in the background and refreshes on demand — never on the
//! download hot path.

use crate::settings::{load_settings, save_settings};
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const PROBE_BYTES: u64 = 10_000_000;
const PROBE_URL: &str = "https://speed.cloudflare.com/__down?bytes=10000000";
const PROBE_INTERVAL_SECS: i64 = 24 * 60 * 60;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BandwidthStatus {
    /// True when the user picked an explicit count (Auto off).
    pub manual: bool,
    /// Fragments the next download will use.
    pub fragments: u32,
    pub mbps: Option<f64>,
    pub last_checked: Option<i64>,
}

/// Mbps → fragment count. Conservative at the low end (weak lines and
/// busy servers fragment-thrash), generous once headroom is proven.
pub fn fragments_for_mbps(mbps: f64) -> u32 {
    if !mbps.is_finite() || mbps <= 0.0 {
        4
    } else if mbps < 10.0 {
        2
    } else if mbps < 50.0 {
        4
    } else if mbps < 150.0 {
        8
    } else {
        16
    }
}

async fn run_probe() -> Option<f64> {
    let client = reqwest::Client::builder()
        .user_agent("Offtube/0.1 (bandwidth-probe)")
        .timeout(Duration::from_secs(25))
        .build()
        .ok()?;
    let start = Instant::now();
    let resp = client.get(PROBE_URL).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?.len() as u64;
    if bytes < PROBE_BYTES / 2 {
        return None; // truncated — don't trust it
    }
    let secs = start.elapsed().as_secs_f64();
    if secs <= 0.0 {
        return None;
    }
    Some(bytes as f64 * 8.0 / secs / 1_000_000.0)
}

/// Refresh the cached measurement when older than 24h (or absent).
/// Silent on failure — the caller keeps serving the previous value.
pub async fn ensure_probed(app: &AppHandle) {
    let settings = load_settings(app);
    let now = chrono::Utc::now().timestamp();
    if let Some(last) = settings.last_speed_check {
        if now - last < PROBE_INTERVAL_SECS {
            return;
        }
    }
    if let Some(mbps) = run_probe().await {
        let mut next = load_settings(app);
        next.last_speed_mbps = Some((mbps * 10.0).round() / 10.0);
        next.last_speed_check = Some(now);
        let _ = save_settings(app, &next);
    } else if settings.last_speed_check.is_none() {
        // Never measured and probe failed (offline?) — stamp the attempt so
        // every launch doesn't retry in a tight loop; keeps default 4.
        let mut next = load_settings(app);
        next.last_speed_check = Some(now);
        let _ = save_settings(app, &next);
    }
}

pub fn bandwidth_status(app: &AppHandle) -> BandwidthStatus {
    let settings = load_settings(app);
    BandwidthStatus {
        manual: settings.concurrent_fragments.is_some(),
        fragments: crate::settings::effective_fragments(app),
        mbps: settings.last_speed_mbps,
        last_checked: settings.last_speed_check,
    }
}
