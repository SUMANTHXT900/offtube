import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types mirrored from the Rust backend (camelCase serde renames)
// ---------------------------------------------------------------------------

export interface FormatInfo {
  formatId: string;
  ext: string;
  resolution?: string | null;
  height?: number | null;
  width?: number | null;
  fps?: number | null;
  vcodec?: string | null;
  acodec?: string | null;
  /** Best-known size in bytes (exact preferred, else estimate). */
  filesize?: number | null;
  /** True when filesize is approximated — render with `~`. */
  filesizeApprox: boolean;
  tbr?: number | null;
  vbr?: number | null;
  abr?: number | null;
  asr?: number | null;
  audioChannels?: number | null;
  dynamicRange?: string | null;
  language?: string | null;
  formatNote?: string | null;
  protocol?: string | null;
  isVideo: boolean;
  isAudio: boolean;
}

export interface VideoMetadata {
  id: string;
  title: string;
  uploader?: string | null;
  channel?: string | null;
  duration?: number | null;
  viewCount?: number | null;
  uploadDate?: string | null;
  description?: string | null;
  thumbnail?: string | null;
  webpageUrl: string;
  formats: FormatInfo[];
}

export interface EngineStatus {
  installedVersion?: string | null;
  source: string;
  enginePath: string;
  ffmpegOk: boolean;
  ffmpegPath?: string | null;
  denoOk: boolean;
  lastChecked?: number | null;
  preferNightly: boolean;
}

export interface UpdateCheck {
  current?: string | null;
  latest: string;
  updateAvailable: boolean;
  assetName: string;
  repo: string;
}

export interface UpdateResult {
  updated: boolean;
  previous?: string | null;
  current: string;
  repo: string;
}

export interface Settings {
  download_dir?: string | null;
  prefer_nightly: boolean;
  extra_args: string;
  last_engine_check?: number | null;
  concurrent_fragments?: number | null;
  autofetch?: boolean | null;
}

export interface SettingsPatch {
  download_dir?: string | null;
  prefer_nightly?: boolean;
  extra_args?: string;
  last_engine_check?: number | null;
  concurrent_fragments?: number | null;
  autofetch?: boolean | null;
}

export interface EngineProgress {
  stage: string;
  percent?: number | null;
  detail: string;
}

export interface StartRequest {
  id: string;
  url: string;
  formatSelector: string;
  audioOnly: boolean;
  outputDir?: string | null;
  extraArgs?: string | null;
}

export interface ProgressEvent {
  id: string;
  percent?: number | null;
  total?: string | null;
  speed?: string | null;
  eta?: string | null;
  status: string;
  detail?: string | null;
}

export interface DoneEvent {
  id: string;
  path?: string | null;
}

export interface FetchProgress {
  id: string;
  stage: string;
}

export interface BandwidthStatus {
  manual: boolean;
  fragments: number;
  mbps?: number | null;
  lastChecked?: number | null;
}

export interface FailEvent {
  id: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Invoke wrappers
// ---------------------------------------------------------------------------

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (patch: SettingsPatch) =>
    invoke<Settings>("save_settings", { patch }),
  getDownloadDir: () => invoke<string>("get_download_dir"),
  pickDownloadDir: () => invoke<string | null>("pick_download_dir"),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  engineStatus: () => invoke<EngineStatus>("engine_status"),
  checkEngineUpdate: (preferNightly?: boolean) =>
    invoke<UpdateCheck>("check_engine_update", { preferNightly }),
  updateEngine: (preferNightly?: boolean) =>
    invoke<UpdateResult>("update_engine", { preferNightly }),
  fetchMetadata: (url: string, extraArgs?: string | null, fetchId?: string | null) =>
    invoke<VideoMetadata>("fetch_metadata", { url, extraArgs, fetchId }),
  bandwidthStatus: () => invoke<BandwidthStatus>("bandwidth_status"),
  startDownload: (req: StartRequest) =>
    invoke<void>("start_download", { req }),
  cancelDownload: (id: string) => invoke<boolean>("cancel_download", { id }),
};
