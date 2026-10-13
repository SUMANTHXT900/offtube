import type { FormatInfo } from "./tauri";

/**
 * Quality-ladder builder — the core of the resolution/size picker.
 *
 * Raw yt-dlp format lists are long, unsorted, and full of duplicates
 * (DASH + HLS variants of the same quality). The ladder collapses them to
 * one row per height, best-first, so 1080p/4K can never be truncated away,
 * and every row carries an honest size (exact, `~` estimate, or unknown).
 * The full format list stays available behind an "all formats" expander.
 */

export interface LadderVideoRow {
  key: string; // 'best' | `h:1080`
  label: string; // 'Best' | '1080p' | '1080p60'
  height: number | null; // null = Best (uncapped)
  fps: number | null;
  hdr: boolean;
  size: number | null;
  approx: boolean;
  vcodec: string | null;
  acodec: string | null;
  merged: boolean; // false = single progressive file
  selector: string; // yt-dlp -f selector (height-capped, expiry-proof)
  videoId: string | null; // representative video format
  audioId: string | null; // representative audio format
}

export interface LadderAudioRow {
  key: "audio:original" | "audio:mp3";
  label: string;
  size: number | null;
  approx: boolean;
  detail: string; // codec/bitrate note
}

export interface Ladder {
  videoRows: LadderVideoRow[];
  audioRows: LadderAudioRow[];
  /** Every real format, sorted for the "all formats" expander. */
  allSorted: FormatInfo[];
  maxHeight: number | null;
}

const JUNK_EXT = new Set(["mhtml", "jpg", "jpeg", "png", "webp", "vtt", "srt", "ttml"]);
const JUNK_PROTO = new Set(["mhtml"]);

export function isJunk(f: FormatInfo): boolean {
  if (JUNK_EXT.has((f.ext || "").toLowerCase())) return true;
  if (f.protocol && JUNK_PROTO.has(f.protocol.toLowerCase())) return true;
  if ((f.formatNote || "").toLowerCase() === "storyboard") return true;
  if (/^sb\d+$/i.test(f.formatId)) return true;
  return false;
}

function num(v?: number | null): number {
  return typeof v === "number" && Number.isFinite(v) ? v : -1;
}

/** Best-first comparator: height → bitrate → fps → size. */
export function compareFormats(a: FormatInfo, b: FormatInfo): number {
  const ha = a.height ?? (a.isVideo ? -1 : -2);
  const hb = b.height ?? (b.isVideo ? -1 : -2);
  if (hb !== ha) return hb - ha;
  const ta = num(a.tbr ?? a.vbr);
  const tb = num(b.tbr ?? b.vbr);
  if (tb !== ta) return tb - ta;
  const fa = num(a.fps);
  const fb = num(b.fps);
  if (fb !== fa) return fb - fa;
  const sa = num(a.filesize);
  const sb = num(b.filesize);
  if (sb !== sa) return sb - sa;
  return a.formatId < b.formatId ? -1 : 1;
}

function isHdr(f: FormatInfo): boolean {
  const dr = (f.dynamicRange || "").toUpperCase();
  return dr !== "" && dr !== "SDR";
}

export function buildLadder(formats: FormatInfo[], duration?: number | null): Ladder {
  const real = formats.filter((f) => !isJunk(f));
  const allSorted = [...real].sort(compareFormats);

  const video = allSorted.filter((f) => f.isVideo);
  const audioOnly = allSorted.filter((f) => !f.isVideo && f.isAudio);
  const bestAudio =
    [...audioOnly].sort((a, b) => num(b.abr ?? b.tbr) - num(a.abr ?? a.tbr))[0] ?? null;

  const heights = Array.from(
    new Set(video.map((f) => f.height).filter((h): h is number => typeof h === "number" && h > 0)),
  ).sort((a, b) => b - a);

  const videoRows: LadderVideoRow[] = [];
  if (video.length > 0) {
    const maxH = heights[0] ?? null;
    videoRows.push({
      key: "best",
      label: maxH ? `Best · up to ${maxH}p` : "Best",
      height: null,
      fps: null,
      hdr: video.some(isHdr),
      size: null,
      approx: false,
      vcodec: null,
      acodec: null,
      merged: true,
      selector: "bv*+ba/b",
      videoId: null,
      audioId: bestAudio?.formatId ?? null,
    });
  }

  for (const h of heights) {
    const group = video.filter((f) => f.height === h);
    // Best candidate in this height: highest bitrate wins; prefer a
    // progressive (V+A) file when bitrates tie — no merge, exact size.
    const cand =
      [...group].sort((a, b) => {
        const ta = num(a.tbr ?? a.vbr);
        const tb = num(b.tbr ?? b.vbr);
        if (tb !== ta) return tb - ta;
        const aProg = a.isVideo && a.isAudio ? 0 : 1;
        const bProg = b.isVideo && b.isAudio ? 0 : 1;
        if (aProg !== bProg) return aProg - bProg;
        return num(b.fps) - num(a.fps);
      })[0] ?? null;
    if (!cand) continue;

    const fps = group.reduce<number | null>((acc, f) => {
      const v = f.fps;
      if (typeof v === "number" && Number.isFinite(v)) return Math.max(acc ?? 0, v);
      return acc;
    }, null);
    const showFps = fps != null && fps >= 48 ? Math.round(fps) : null;

    // Displayed size = candidate video + best audio (what the merge costs).
    // Exact only if both sides are exact.
    let size: number | null = null;
    let approx = false;
    if (cand.isVideo && cand.isAudio) {
      size = cand.filesize ?? null;
      approx = (cand.filesize ?? null) != null && cand.filesizeApprox;
    } else if (cand.filesize != null || bestAudio?.filesize != null) {
      size = (cand.filesize ?? 0) + (bestAudio?.filesize ?? 0);
      approx = !!cand.filesizeApprox || !!bestAudio?.filesizeApprox;
    }

    videoRows.push({
      key: `h:${h}`,
      label: showFps ? `${h}p${showFps}` : `${h}p`,
      height: h,
      fps,
      hdr: group.some(isHdr),
      size,
      approx,
      vcodec: cand.vcodec ?? null,
      acodec: (cand.isVideo && cand.isAudio ? cand.acodec : bestAudio?.acodec) ?? null,
      merged: !(cand.isVideo && cand.isAudio),
      selector: `bv*[height<=${h}]+ba/b[height<=${h}]/b`,
      videoId: cand.formatId,
      audioId: bestAudio?.formatId ?? null,
    });
  }

  const audioRows: LadderAudioRow[] = [];
  if (bestAudio) {
    const abr = bestAudio.abr ?? bestAudio.tbr;
    audioRows.push({
      key: "audio:original",
      label: "Original audio",
      size: bestAudio.filesize ?? null,
      approx: (bestAudio.filesize ?? null) != null && bestAudio.filesizeApprox,
      detail: `${(bestAudio.acodec || bestAudio.ext || "").split(".")[0]}${abr ? ` · ${Math.round(abr)}k` : ""} · no conversion`,
    });
  }
  if (duration != null && duration > 0) {
    // MP3 extract path (-x, VBR ~245k): honest estimate, always approx.
    audioRows.push({
      key: "audio:mp3",
      label: "MP3",
      size: Math.round(duration * 245 * 125),
      approx: true,
      detail: "converted · VBR ~245k",
    });
  } else if (bestAudio) {
    audioRows.push({
      key: "audio:mp3",
      label: "MP3",
      size: null,
      approx: false,
      detail: "converted from best audio",
    });
  }

  return {
    videoRows,
    audioRows,
    allSorted,
    maxHeight: heights[0] ?? null,
  };
}

/** Map a ladder/custom selection key to a yt-dlp `-f` selector + audio flag. */
export function selectorForKey(
  key: string,
  formats: FormatInfo[],
): { selector: string; audioOnly: boolean } {
  if (key === "best") return { selector: "bv*+ba/b", audioOnly: false };
  if (key.startsWith("h:")) {
    const h = Number(key.slice(2));
    if (Number.isFinite(h)) {
      return { selector: `bv*[height<=${h}]+ba/b[height<=${h}]/b`, audioOnly: false };
    }
    return { selector: "bv*+ba/b", audioOnly: false };
  }
  if (key === "audio:original") return { selector: "bestaudio/best", audioOnly: false };
  if (key === "audio:mp3") return { selector: "bestaudio/best", audioOnly: true };
  if (key.startsWith("custom:")) {
    const id = key.slice("custom:".length);
    const f = formats.find((x) => x.formatId === id);
    if (!f) return { selector: "bv*+ba/b", audioOnly: false };
    // `/best`-style fallbacks so an expired/unplayable id degrades instead of erroring.
    if (f.isVideo && f.isAudio) return { selector: `${id}/best`, audioOnly: false };
    if (f.isVideo && !f.isAudio) return { selector: `${id}+bestaudio/best`, audioOnly: false };
    return { selector: `${id}/bestaudio`, audioOnly: false };
  }
  return { selector: "bv*+ba/b", audioOnly: false };
}
