//! Bandwidth probe for Auto fragment parallelism.
//!
//! yt-dlp downloads DASH/HLS fragments sequentially unless `-N` is raised.
//! Rather than a fixed default, Auto mode measures the line with a small CDN
//! fetch and maps the result to a fragment count. A light 1 MB probe runs on
//! every download press (fast on any line); if the line looks fast the result
//! is confirmed with a 10 MB fetch, since 1 MB alone under-reads gigabit
//! links (TCP slow-start dominates sub-second transfers). A daily background
//! probe keeps the Settings display fresh between downloads.

use crate::settings::{load_settings, save_settings};
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const QUICK_BYTES: u64 = 1_000_000;
const QUICK_URL: &str = "https://speed.cloudflare.com/__down?bytes=1000000";
const CONFIRM_BYTES: u64 = 10_000_000;
const CONFIRM_URL: &str = "https://speed.cloudflare.com/__down?bytes=10000000";
/// Above this, the 1 MB result is slow-start noise — confirm before trusting.
const CONFIRM_ABOVE_MBPS: f64 = 80.0;
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

async fn fetch_mbps(client: &reqwest::Client, url: &str, expect: u64, timeout: Duration) -> Option<f64> {
    let start = Instant::now();
    let resp = client
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?.len() as u64;
    if bytes < expect / 2 {
        return None; // truncated — don't trust it
    }
    let secs = start.elapsed().as_secs_f64();
    if secs <= 0.0 {
        return None;
    }
    Some(bytes as f64 * 8.0 / secs / 1_000_000.0)
}

fn probe_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent("Offtube/0.1 (bandwidth-probe)")
        .build()
        .ok()
}

/// One measurement round: 1 MB always, 10 MB confirm on fast lines.
async fn run_probe() -> Option<f64> {
    let client = probe_client()?;
    let quick = fetch_mbps(&client, QUICK_URL, QUICK_BYTES, Duration::from_secs(15)).await?;
    if quick < CONFIRM_ABOVE_MBPS {
        return Some(quick);
    }
    // Fast line — the sub-second result is mostly slow-start. Confirm.
    fetch_mbps(&client, CONFIRM_URL, CONFIRM_BYTES, Duration::from_secs(25))
        .await
        .or(Some(quick))
}

fn stamp(app: &AppHandle, mbps: f64) {
    let mut next = load_settings(app);
    next.last_speed_mbps = Some((mbps * 10.0).round() / 10.0);
    next.last_speed_check = Some(chrono::Utc::now().timestamp());
    let _ = save_settings(app, &next);
}

/// Fresh measurement for the download hot path. Returns Mbps and caches it;
/// None means "probe failed, caller falls back to cache/default".
pub async fn probe_now(app: &AppHandle) -> Option<f64> {
    let mbps = run_probe().await?;
    stamp(app, mbps);
    load_settings(app).last_speed_mbps
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
        stamp(app, mbps);
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
