import { listen } from "@tauri-apps/api/event";
import { AnimatePresence } from "framer-motion";
import { Settings as SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Queue } from "./components/Queue";
import { EngineDot, SettingsPanel } from "./components/Settings";
import { UrlBar } from "./components/UrlBar";
import type { DoneEvent, FailEvent, ProgressEvent } from "./lib/tauri";
import { useQueue } from "./stores/useQueue";
import { useSettings } from "./stores/useSettings";

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const loadSettings = useSettings((s) => s.load);
  const loaded = useSettings((s) => s.loaded);
  const downloadDir = useSettings((s) => s.downloadDir);

  useEffect(() => {
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const qs = useQueue.getState();
    const ss = () => useSettings.getState().load().catch(() => {});
    const unlisteners: Array<() => void> = [];
    let alive = true;

    (async () => {
      unlisteners.push(
        await listen<ProgressEvent>("download-progress", (e) =>
          qs.applyProgress(e.payload.id, e.payload),
        ),
        await listen<DoneEvent>("download-complete", (e) =>
          qs.markDone(e.payload.id, e.payload.path),
        ),
        await listen<FailEvent>("download-error", (e) =>
          qs.markFailed(e.payload.id, e.payload.error),
        ),
        await listen<DoneEvent>("download-cancelled", (e) =>
          qs.markCancelled(e.payload.id),
        ),
        await listen("engine-status", () => ss()),
        await listen("engine-progress", () => {}),
      );
    })();

    return () => {
      alive = false;
      void alive;
      unlisteners.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-full flex-col bg-zinc-950 text-zinc-100">
      {/* header */}
      <header className="sticky top-0 z-30 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-5xl items-center justify-between px-4">
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-[13px] font-bold tracking-[0.18em]">OFFTUBE</span>
            <span className="rounded border border-zinc-800 px-1 py-px font-mono text-[10px] text-zinc-600">v0.1</span>
            <EngineDot />
          </div>
          <button
            onClick={() => setSettingsOpen((v) => !v)}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] transition ${
              settingsOpen
                ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                : "border-zinc-800 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            }`}
          >
            <SettingsIcon size={14} /> settings
          </button>
        </div>
      </header>

      {/* main */}
      <main className="mx-auto w-full max-w-5xl flex-1 space-y-4 px-4 py-4">
        <UrlBar />
        <Queue />
      </main>

      {/* footer status */}
      <footer className="border-t border-zinc-800/80">
        <div className="mx-auto flex h-8 max-w-5xl items-center justify-between px-4 font-mono text-[10px] text-zinc-600">
          <span className="truncate" title={loaded ? downloadDir : ""}>
            {loaded ? downloadDir : "loading…"}
          </span>
          <span className="shrink-0">offline-first · engine auto-updates silently</span>
        </div>
      </footer>

      <AnimatePresence>
        {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      </AnimatePresence>
    </div>
  );
}
