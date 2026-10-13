import { create } from "zustand";
import { persist } from "zustand/middleware";
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
export type PickerMode = "video" | "audio";

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
  /** Picker mode. Each mode remembers its own key, so flipping
   *  Video ↔ Audio never loses the other side's choice. */
  mode: PickerMode;
  videoKey: SelKey;
  audioKey: SelKey;
  audioOnly: boolean;
  progress: number | null;
  speed?: string | null;
  eta?: string | null;
  total?: string | null;
  detail?: string | null;
  outputPath?: string | null;
  error?: string | null;
  /** Live extraction stage while fetching ("Reading player…"). */
  stage?: string | null;
  createdAt: number;
}

interface QueueState {
  items: QueueItem[];
  fetchUrl: (url: string) => Promise<void>;
  /** Write the key into the item's *active* mode bucket. */
  setSelKey: (id: string, key: SelKey) => void;
  /** Flip Video ↔ Audio. Each mode keeps its own key. */
  setMode: (id: string, mode: PickerMode) => void;
  enqueue: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  remove: (id: string) => void;
  clearFinished: () => void;
  applyProgress: (
    id: string,
    p: { percent?: number | null; speed?: string | null; eta?: string | null; total?: string | null; status?: string; detail?: string | null },
  ) => void;
  applyFetchStage: (id: string, stage: string) => void;
  markDone: (id: string, path?: string | null) => void;
  markFailed: (id: string, error: string) => void;
  markCancelled: (id: string) => void;
}

let seq = 0;
const nextId = () =>
  `q_${Date.now().toString(36)}_${(seq++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** Default keys: video starts at Best, audio at Original. */
export function defaultKeys(meta: Pick<VideoMetadata, "formats" | "duration">): {
  mode: PickerMode;
  videoKey: SelKey;
  audioKey: SelKey;
} {
  const ladder = buildLadder(meta.formats, meta.duration);
  return {
    mode: "video",
    videoKey: "best",
    audioKey:
      ladder.audioRows.find((r) => r.key === "audio:original")?.key ??
      ladder.audioRows[0]?.key ??
      "audio:original",
  };
}

/** The currently effective selection key for an item. */
export function activeKey(item: Pick<QueueItem, "mode" | "videoKey" | "audioKey">): SelKey {
  return item.mode === "video" ? item.videoKey : item.audioKey;
}

function metaToItem(id: string, url: string, meta: VideoMetadata): QueueItem {
  const keys = defaultKeys(meta);
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
    ...keys,
    audioOnly: false,
    progress: null,
    createdAt: Date.now(),
  };
}

export const useQueue = create<QueueState>()(
  persist(
    (set, get) => ({
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
          mode: "video",
          videoKey: "best",
          audioKey: "audio:original",
          audioOnly: false,
          progress: null,
          createdAt: Date.now(),
        },
        ...s.items,
      ],
    }));
    try {
      const meta = await api.fetchMetadata(url, null, id);
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

  setSelKey: (id, key) =>
    set((s) => ({
      items: s.items.map((it) => {
        if (it.id !== id) return it;
        const next = it.mode === "video" ? { videoKey: key } : { audioKey: key };
        return { ...it, ...next, audioOnly: key === "audio:mp3" };
      }),
    })),

  setMode: (id, mode) =>
    set((s) => ({
      items: s.items.map((it) => {
        if (it.id !== id) return it;
        const key = mode === "video" ? it.videoKey : it.audioKey;
        return { ...it, mode, audioOnly: key === "audio:mp3" };
      }),
    })),

  enqueue: async (id: string) => {
    const item = get().items.find((i) => i.id === id);
    if (!item || item.status === "downloading" || item.status === "merging") return;
    const { selector, audioOnly } = selectorForKey(activeKey(item), item.formats);
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
      // Optimistic: flip the row instantly so Stop always feels alive;
      // the download-cancelled event confirms (idempotent).
      const stopped = await api.cancelDownload(id);
      if (stopped) get().markCancelled(id);
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

  applyFetchStage: (id, stage) =>
    set((s) => ({
      items: s.items.map((it) =>
        it.id === id && it.status === "fetching" ? { ...it, stage } : it,
      ),
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
    }),
    {
      name: "offtube-queue",
      version: 1,
      // Persist the list only — actions stay in memory.
      partialize: (s) => ({ items: s.items }),
      merge: (persisted, current) => {
        const saved = (persisted as { items?: QueueItem[] } | undefined)?.items ?? [];
        // Anything mid-flight when the app closed goes back to ready, keeping
        // its URL + quality pick: pressing "get" resumes from the .part file.
        // Half-fetched rows (no metadata) are dropped.
        const items = saved
          .filter((it) => it.status !== "fetching")
          .map((it) =>
            it.status === "downloading" || it.status === "merging"
              ? {
                  ...it,
                  status: "ready" as const,
                  progress: null,
                  speed: null,
                  eta: null,
                  detail: "interrupted — press get to resume",
                }
              : it,
          );
        return { ...current, items };
      },
    },
  ),
);
