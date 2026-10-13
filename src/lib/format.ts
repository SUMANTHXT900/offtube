/** Format seconds → H:MM:SS / M:SS */
export function fmtDuration(totalSeconds?: number | null): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return "—";
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Format bytes → 12.4 MiB (binary units, matching yt-dlp's display).
 *  Pass approx=true for estimated sizes → "~12.4 MiB" (yt-dlp -F convention). */
export function fmtBytes(bytes?: number | null, approx = false): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const prefix = approx ? "~" : "";
  if (bytes < 1024) return `${prefix}${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${prefix}${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

/** Short codec labels for dense rows: avc1.640028 → avc, vp9.2 → vp9, av01 → av1. */
export function shortCodec(codec?: string | null): string {
  if (!codec || codec === "none") return "—";
  const c = codec.toLowerCase();
  if (c.startsWith("avc") || c.startsWith("h264")) return "avc";
  if (c.startsWith("hev") || c.startsWith("h265") || c.startsWith("hvc")) return "hevc";
  if (c.startsWith("av01") || c === "av1") return "av1";
  if (c.startsWith("vp09") || c.startsWith("vp9")) return "vp9";
  if (c.startsWith("mp4a") || c.startsWith("aac")) return "aac";
  if (c.startsWith("opus")) return "opus";
  if (c.startsWith("mp3")) return "mp3";
  if (c.startsWith("vorbis")) return "vorbis";
  if (c.startsWith("ec-3") || c.startsWith("ac-3")) return "dolby";
  if (c.startsWith("dts")) return "dts";
  if (c.startsWith("flac")) return "flac";
  if (c.startsWith("alac")) return "alac";
  return c.split(".")[0].slice(0, 8);
}

export function fmtCount(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

/** yyyymmdd → 2026-10-12 */
export function fmtUploadDate(raw?: string | null): string {
  if (!raw || raw.length !== 8) return raw ?? "—";
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

export function timeAgo(unixSecs?: number | null): string {
  if (!unixSecs) return "never";
  const delta = Date.now() / 1000 - unixSecs;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}
