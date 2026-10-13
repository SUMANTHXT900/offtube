import { create } from "zustand";
import { buildLadder, selectorForKey } from "../lib/ladder";
import { api, type FormatInfo, type VideoMetadata } from "../lib/tauri";

export type ItemStatus =
  | "fetching"
  | "ready"
  | "downloading"
  | "merging"
  | "completed"
  | "error"
  | "cancelled";

/**
 * Selection keys (see lib/ladder.ts):
 *  'best' | 'h:1080' | 'audio:original' | 'audio:mp3' | 'custom:<formatId>'
 */
export type SelKey = string;

export interface QueueItem {
  id: string;
  url: string;
  status: ItemStatus;
  title?: string;
  thumbnail?: string | null;
  uploader?: string | null;
  duration?: number | null;
  viewCount?: number | null;
  formats: FormatInfo[];
  selKey: SelKey;
  audioOnly: boolean;
  progress: number | null;
  speed?: string | null;
  eta?: string | null;
  total?: string | null;
  detail?: string | null;
  outputPath?: string | null;
  error?: string | null;
  createdAt: number;
}

interface QueueState {
  items: QueueItem[];
  fetchUrl: (url: string) => Promise<void>;
  setSelKey: (id: string, key: SelKey) => void;
  enqueue: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  remove: (id: string) => void;
  clearFinished: () => void;
  applyProgress: (
    id: string,
    p: { percent?: number | null; speed?: string | null; eta?: string | null; total?: string | null; status?: string; detail?: string | null },
  ) => void;
  markDone: (id: string, path?: string | null) => void;
  markFailed: (id: string, error: string) => void;
  markCancelled: (id: string) => void;
}

let seq = 0;
const nextId = () =>
  `q_${Date.now().toString(36)}_${(seq++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** Default key: best ladder row, else first available video row, else audio. */
export function defaultSelKey(meta: Pick<VideoMetadata, "formats" | "duration">): SelKey {
  const ladder = buildLadder(meta.formats, meta.duration);
  if (ladder.videoRows.length > 0) return "best";
  if (ladder.audioRows.length > 0) return "audio:original";
  return "best";
}

function metaToItem(id: string, url: string, meta: VideoMetadata): QueueItem {
  return {
    id,
    url: meta.webpageUrl || url,
    status: "ready",
    title: meta.title,
    thumbnail: meta.thumbnail,
    uploader: meta.uploader ?? meta.channel,
    duration: meta.duration,
    viewCount: meta.viewCount,
    formats: meta.formats,
    selKey: defaultSelKey(meta),
    audioOnly: false,
    progress: null,
    createdAt: Date.now(),
  };
}

export const useQueue = create<QueueState>()((set, get) => ({
  items: [],

  fetchUrl: async (rawUrl: string) => {
    const url = rawUrl.trim();
    if (!url) return;
    const id = nextId();
    set((s) => ({
      items: [
        {
          id,
          url,
          status: "fetching",
          formats: [],
          selKey: "best",
          audioOnly: false,
          progress: null,
          createdAt: Date.now(),
        },
        ...s.items,
      ],
    }));
    try {
      const meta = await api.fetchMetadata(url);
      set((s) => ({
        items: s.items.map((it) => (it.id === id ? metaToItem(id, url, meta) : it)),
      }));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set((s) => ({
        items: s.items.map((it) =>
          it.id === id ? { ...it, status: "error" as const, error } : it,
        ),
      }));
    }
  },

  setSelKey: (id, selKey) =>
    set((s) => ({
      items: s.items.map((it) =>
        it.id === id ? { ...it, selKey, audioOnly: selKey === "audio:mp3" } : it,
      ),
    })),

  enqueue: async (id: string) => {
    const item = get().items.find((i) => i.id === id);
    if (!item || item.status === "downloading" || item.status === "merging") return;
    const { selector, audioOnly } = selectorForKey(item.selKey, item.formats);
    set((s) => ({
      items: s.items.map((it) =>
        it.id === id
          ? { ...it, status: "downloading" as const, progress: 0, error: null, outputPath: null, audioOnly }
          : it,
      ),
    }));
    try {
      await api.startDownload({
        id,
        url: item.url,
        formatSelector: selector,
        audioOnly,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      get().markFailed(id, error);
    }
  },

  cancel: async (id: string) => {
    try {
      await api.cancelDownload(id);
    } catch {
      // The task may already have exited; the terminal event still lands.
    }
  },

  remove: (id: string) =>
    set((s) => ({ items: s.items.filter((it) => it.id !== id) })),

  clearFinished: () =>
    set((s) => ({
      items: s.items.filter(
        (it) => it.status !== "completed" && it.status !== "cancelled" && it.status !== "error",
      ),
    })),

  applyProgress: (id, p) =>
    set((s) => ({
      items: s.items.map((it) => {
        if (it.id !== id) return it;
        if (it.status !== "downloading" && it.status !== "merging") return it;
        return {
          ...it,
          status: p.status === "merging" ? ("merging" as const) : it.status,
          progress: p.percent ?? it.progress,
          speed: p.speed ?? it.speed,
          eta: p.eta ?? it.eta,
          total: p.total ?? it.total,
          detail: p.detail ?? it.detail,
        };
      }),
    })),

  markDone: (id, path) =>
    set((s) => ({
      items: s.items.map((it) =>
        it.id === id
          ? { ...it, status: "completed" as const, progress: 100, outputPath: path ?? null, speed: null, eta: null }
          : it,
      ),
    })),

  markFailed: (id, error) =>
    set((s) => ({
      items: s.items.map((it) =>
        it.id === id ? { ...it, status: "error" as const, error } : it,
      ),
    })),

  markCancelled: (id) =>
    set((s) => ({
      items: s.items.map((it) =>
        it.id === id ? { ...it, status: "cancelled" as const, speed: null, eta: null } : it,
      ),
    })),
}));
