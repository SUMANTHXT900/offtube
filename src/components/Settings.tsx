import { motion } from "framer-motion";
import { FolderOpen, RefreshCw, SearchCheck, X } from "lucide-react";
import { timeAgo } from "../lib/format";
import { useSettings } from "../stores/useSettings";

export function EngineDot() {
  const engine = useSettings((s) => s.engine);
  const v = engine?.installedVersion;
  const color = v ? "bg-emerald-400" : "bg-red-400";
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-400" title={engine?.enginePath ?? "engine"}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />
      {v ? `yt-dlp ${v}` : "engine missing"}
      {engine && <span className="text-zinc-600">· {engine.source}</span>}
    </span>
  );
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const s = useSettings();

  return (
    <motion.aside
      initial={{ x: 320, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 320, opacity: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 36 }}
      className="fixed right-0 top-0 z-40 flex h-full w-[340px] flex-col border-l border-zinc-800 bg-zinc-950"
    >
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-400">settings</h2>
        <button onClick={onClose} className="rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-auto px-4 py-4">
        {/* download folder */}
        <div>
          <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-zinc-500">download folder</p>
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-2 font-mono text-[11px] text-zinc-300" title={s.downloadDir}>
              {s.downloadDir || "…"}
            </p>
            <button
              onClick={() => s.pickDir()}
              disabled={s.busy === "pick"}
              className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-zinc-700 px-2.5 text-[12px] text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
            >
              <FolderOpen size={13} /> change
            </button>
          </div>
        </div>

        {/* engine */}
        <div>
          <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-zinc-500">engine · yt-dlp</p>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[12px] text-zinc-200">
                {s.engine?.installedVersion ?? "not found"}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-600">
                {s.engine?.source ?? "—"}
              </span>
            </div>
            <div className="mt-2 space-y-1 font-mono text-[11px] text-zinc-500">
              <p>
                ffmpeg{" "}
                <span className={s.engine?.ffmpegOk ? "text-emerald-300" : "text-red-400"}>
                  {s.engine?.ffmpegOk ? "ok" : "missing"}
                </span>
                {"  ·  "}deno{" "}
                <span className={s.engine?.denoOk ? "text-emerald-300" : "text-amber-300"}>
                  {s.engine?.denoOk ? "ok" : "missing"}
                </span>
              </p>
              <p>last check: {timeAgo(s.engine?.lastChecked)}</p>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => s.checkUpdate()}
                disabled={s.busy === "check"}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-700 px-2 py-1.5 text-[12px] text-zinc-200 transition hover:bg-zinc-800 disabled:opacity-50"
              >
                <SearchCheck size={13} />
                {s.busy === "check" ? "checking…" : "Check"}
              </button>
              <button
                onClick={() => s.runUpdate()}
                disabled={s.busy === "update" || (s.updateCheck != null && !s.updateCheck.updateAvailable)}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-400 px-2 py-1.5 text-[12px] font-semibold text-zinc-950 transition hover:bg-emerald-300 disabled:opacity-40"
              >
                <RefreshCw size={13} className={s.busy === "update" ? "animate-spin" : ""} />
                {s.busy === "update" ? "Updating…" : "Update engine"}
              </button>
            </div>
            <label className="mt-3 flex cursor-pointer items-center justify-between">
              <span className="text-[12px] text-zinc-400">prefer nightly builds</span>
              <input
                type="checkbox"
                checked={s.preferNightly}
                onChange={(e) => s.setNightly(e.target.checked)}
                className="h-4 w-4 accent-emerald-400"
              />
            </label>
          </div>
        </div>

        {/* extra args */}
        <div>
          <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-zinc-500">
            extra yt-dlp args
          </p>
          <input
            value={s.extraArgs}
            onChange={(e) => s.setExtraArgs(e.target.value)}
            placeholder="--socket-timeout 30"
            spellCheck={false}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-2 font-mono text-[12px] text-zinc-200 placeholder:text-zinc-700 focus:border-zinc-600 focus:outline-none"
          />
          <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-zinc-600">
            Appended to every yt-dlp call. Future flags work without a rebuild.
          </p>
        </div>

        {s.notice && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <p className="font-mono text-[11px] leading-relaxed text-zinc-300">{s.notice}</p>
            <button onClick={() => s.dismissNotice()} className="mt-1.5 font-mono text-[11px] text-zinc-600 hover:text-zinc-300">
              dismiss
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-zinc-800 px-4 py-2.5">
        <p className="font-mono text-[10px] text-zinc-700">offtube v0.1 · tauri + yt-dlp</p>
      </div>
    </motion.aside>
  );
}
