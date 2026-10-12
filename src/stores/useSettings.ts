import { create } from "zustand";
import { api, type EngineStatus, type UpdateCheck } from "../lib/tauri";

interface SettingsState {
  downloadDir: string;
  preferNightly: boolean;
  extraArgs: string;
  engine: EngineStatus | null;
  updateCheck: UpdateCheck | null;
  busy: string | null; // "load" | "check" | "update" | "pick"
  notice: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  setDownloadDir: (dir: string | null) => Promise<void>;
  pickDir: () => Promise<void>;
  setNightly: (v: boolean) => Promise<void>;
  setExtraArgs: (v: string) => Promise<void>;
  checkUpdate: () => Promise<void>;
  runUpdate: () => Promise<void>;
  dismissNotice: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useSettings = create<SettingsState>()((set, get) => ({
  downloadDir: "",
  preferNightly: false,
  extraArgs: "",
  engine: null,
  updateCheck: null,
  busy: null,
  notice: null,
  loaded: false,

  load: async () => {
    set({ busy: "load" });
    try {
      const [s, dir, engine] = await Promise.all([
        api.getSettings(),
        api.getDownloadDir(),
        api.engineStatus(),
      ]);
      set({
        downloadDir: s.download_dir ?? dir,
        preferNightly: s.prefer_nightly,
        extraArgs: s.extra_args ?? "",
        engine,
        loaded: true,
      });
    } catch (e) {
      set({ notice: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ busy: null });
    }
  },

  setDownloadDir: async (dir) => {
    const s = await api.saveSettings({ download_dir: dir });
    const effective = await api.getDownloadDir();
    set({ downloadDir: s.download_dir ?? effective });
  },

  pickDir: async () => {
    set({ busy: "pick" });
    try {
      const picked = await api.pickDownloadDir();
      if (picked) await get().setDownloadDir(picked);
    } finally {
      set({ busy: null });
    }
  },

  setNightly: async (v) => {
    set({ preferNightly: v, updateCheck: null });
    await api.saveSettings({ prefer_nightly: v });
    const engine = await api.engineStatus().catch(() => get().engine);
    set({ engine });
  },

  setExtraArgs: async (v) => {
    set({ extraArgs: v });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.saveSettings({ extra_args: get().extraArgs }).catch(() => {});
    }, 600);
  },

  checkUpdate: async () => {
    set({ busy: "check", notice: null, updateCheck: null });
    try {
      const check = await api.checkEngineUpdate(get().preferNightly);
      set({
        updateCheck: check,
        notice: check.updateAvailable
          ? `${check.repo} has ${check.latest} (installed: ${check.current ?? "none"})`
          : `Engine is current (${check.current ?? "unknown"}).`,
      });
    } catch (e) {
      set({ notice: `Update check failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      set({ busy: null });
    }
  },

  runUpdate: async () => {
    set({ busy: "update", notice: null });
    try {
      const res = await api.updateEngine(get().preferNightly);
      const engine = await api.engineStatus();
      set({
        engine,
        updateCheck: null,
        notice: res.updated
          ? `Engine updated ${res.previous ?? "?"} → ${res.current}`
          : `Engine already current (${res.current}).`,
      });
    } catch (e) {
      set({ notice: `Engine update failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      set({ busy: null });
    }
  },

  dismissNotice: () => set({ notice: null }),
}));
