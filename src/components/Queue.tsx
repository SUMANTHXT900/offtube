import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  FileAudio,
  FolderOpen,
  Inbox,
  Loader2,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { fmtBytes, fmtCount, fmtDuration } from "../lib/format";
import { api } from "../lib/tauri";
import { PRESETS, useQueue, type QueueItem } from "../stores/useQueue";

function StatusLine({ item }: { item: QueueItem }) {
  const cls = "font-mono text-[11px] tabular text-zinc-500";
  switch (item.status) {
    case "fetching":
      return <span className={cls}>resolving metadata…</span>;
    case "downloading":
      return (
        <span className={`${cls} text-zinc-300`}>
          {item.progress != null ? `${item.progress.toFixed(1)}%` : "starting…"}
          {item.total ? ` of ${item.total}` : ""}
          {item.speed ? ` · ${item.speed}` : ""}
          {item.eta ? ` · ETA ${item.eta}` : ""}
        </span>
      );
    case "merging":
      return <span className={`${cls} text-amber-300`}>merging video + audio…</span>;
    case "completed":
      return (
        <span className={`${cls} flex items-center gap-1 text-emerald-300`}>
          <Check size={12} /> done
        </span>
      );
    case "error":
      return (
        <span className={`${cls} flex items-center gap-1 text-red-400`}>
          <AlertTriangle size={12} /> {item.error ?? "failed"}
        </span>
      );
    case "cancelled":
      return <span className={cls}>cancelled</span>;
    default:
      return <span className={cls}>ready</span>;
  }
}

function FormatTable({ item }: { item: QueueItem }) {
  const setCustom = useQueue((s) => s.setCustomFormat);
  const video = item.formats.filter((f) => f.isVideo);
  const audioOnly = item.formats.filter((f) => !f.isVideo && f.isAudio);
  const rows = [...video.slice(0, 24), ...audioOnly.slice(0, 8)];

  return (
    <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-zinc-800">
      <table className="w-full font-mono text-[11px]">
        <thead className="sticky top-0 bg-zinc-950 text-left text-zinc-500">
          <tr>
            <th className="px-2 py-1.5 font-medium">id</th>
            <th className="px-2 py-1.5 font-medium">ext</th>
            <th className="px-2 py-1.5 font-medium">res</th>
            <th className="px-2 py-1.5 font-medium">codecs</th>
            <th className="px-2 py-1.5 text-right font-medium">size</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => {
            const selected = item.presetId === "custom" && item.customFormatId === f.formatId;
            return (
              <tr
                key={f.formatId}
                onClick={() => setCustom(item.id, f.formatId)}
                className={`cursor-pointer border-t border-zinc-800/60 transition-colors ${
                  selected ? "bg-emerald-400/10 text-emerald-200" : "text-zinc-400 hover:bg-zinc-800/60"
                }`}
              >
                <td className="px-2 py-1">{f.formatId}</td>
                <td className="px-2 py-1">{f.ext}</td>
                <td className="px-2 py-1 tabular">{f.resolution ?? (f.isAudio ? "audio" : "—")}</td>
                <td className="px-2 py-1 text-zinc-500">
                  {[f.vcodec === "none" ? null : f.vcodec, f.acodec === "none" ? null : f.acodec]
                    .filter(Boolean)
                    .join(" + ") || "—"}
                </td>
                <td className="px-2 py-1 text-right tabular">{fmtBytes(f.filesize)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function QueueRow({ item }: { item: QueueItem }) {
  const [showFormats, setShowFormats] = useState(false);
  const setPreset = useQueue((s) => s.setPreset);
  const enqueue = useQueue((s) => s.enqueue);
  const cancel = useQueue((s) => s.cancel);
  const remove = useQueue((s) => s.remove);
  const fetchUrl = useQueue((s) => s.fetchUrl);

  const active = item.status === "downloading" || item.status === "merging";
  const pct = item.progress ?? (item.status === "completed" ? 100 : 0);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.99 }}
      transition={{ duration: 0.16 }}
      className="relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60"
    >
      <div className="flex gap-3 p-3">
        {/* thumbnail */}
        <div className="h-16 w-28 shrink-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
          {item.thumbnail ? (
            <img src={item.thumbnail} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-zinc-700">
              {item.status === "fetching" ? <Loader2 size={18} className="animate-spin" /> : <FileAudio size={18} />}
            </div>
          )}
        </div>

        {/* body */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate text-[13px] font-medium text-zinc-100" title={item.title ?? item.url}>
              {item.status === "fetching" ? "Resolving…" : (item.title ?? item.url)}
            </p>
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
              {item.status}
            </span>
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
            {[item.uploader, item.duration != null ? fmtDuration(item.duration) : null,
              item.viewCount != null ? `${fmtCount(item.viewCount)} views` : null,
            ].filter(Boolean).join("  ·  ") || item.url}
          </p>

          {/* quality picker */}
          {(item.status === "ready" || item.status === "error" || item.status === "cancelled") && item.formats.length > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <select
                value={item.presetId}
                onChange={(e) => setPreset(item.id, e.target.value)}
                className="h-7 rounded-md border border-zinc-700 bg-zinc-950 px-1.5 font-mono text-[11px] text-zinc-200 focus:outline-none"
              >
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
                {item.presetId === "custom" && <option value="custom">Custom…</option>}
              </select>
              <button
                onClick={() => setShowFormats((v) => !v)}
                className="flex h-7 items-center gap-1 rounded-md px-1.5 font-mono text-[11px] text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
              >
                formats
                <ChevronDown size={13} className={`transition-transform ${showFormats ? "rotate-180" : ""}`} />
              </button>
            </div>
          )}
          {showFormats && item.formats.length > 0 && <FormatTable item={item} />}

          <div className="mt-1.5">
            <StatusLine item={item} />
          </div>
          {item.status === "completed" && item.outputPath && (
            <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-600" title={item.outputPath}>
              {item.outputPath}
            </p>
          )}
        </div>

        {/* actions */}
        <div className="flex shrink-0 flex-col items-end justify-between gap-2">
          <button
            onClick={() => remove(item.id)}
            title="Remove"
            className="rounded-md p-1.5 text-zinc-600 transition hover:bg-zinc-800 hover:text-zinc-200"
          >
            <Trash2 size={15} />
          </button>
          <div className="flex items-center gap-1.5">
            {item.status === "completed" && item.outputPath && (
              <button
                onClick={() => api.openPath(item.outputPath!).catch(() => {})}
                title="Reveal file"
                className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
              >
                <FolderOpen size={15} />
              </button>
            )}
            {(item.status === "error" || item.status === "cancelled") && (
              <button
                onClick={() => {
                  if (!item.title) {
                    const url = item.url;
                    remove(item.id);
                    fetchUrl(url);
                  } else {
                    enqueue(item.id);
                  }
                }}
                title={item.title ? "Retry download" : "Retry fetch"}
                className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
              >
                <RotateCcw size={15} />
              </button>
            )}
            {active ? (
              <button
                onClick={() => cancel(item.id)}
                title="Cancel"
                className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 font-mono text-[11px] text-zinc-300 transition hover:border-red-500/60 hover:text-red-300"
              >
                <X size={13} /> stop
              </button>
            ) : (
              (item.status === "ready" || item.status === "cancelled") && (
                <button
                  onClick={() => enqueue(item.id)}
                  title="Download"
                  className="flex items-center gap-1 rounded-md bg-zinc-100 px-2.5 py-1 text-[12px] font-semibold text-zinc-950 transition hover:bg-white"
                >
                  <Download size={13} /> get
                </button>
              )
            )}
          </div>
        </div>
      </div>

      {/* progress track */}
      <div className="h-[3px] w-full bg-zinc-800/70">
        <div
          className={`h-full transition-[width] duration-200 ${
            item.status === "error" ? "bg-red-500" : item.status === "merging" ? "bg-amber-300" : "bg-emerald-400"
          }`}
          style={{ width: `${Math.min(100, Math.max(0, active || item.status === "completed" ? pct : item.status === "ready" ? 0 : pct))}%` }}
        />
      </div>
    </motion.div>
  );
}

export function Queue() {
  const items = useQueue((s) => s.items);
  const clearFinished = useQueue((s) => s.clearFinished);
  const active = items.filter((i) => i.status === "downloading" || i.status === "merging").length;
  const finished = items.filter((i) => i.status === "completed" || i.status === "error" || i.status === "cancelled").length;

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-500">
          queue{active > 0 && <span className="ml-2 text-emerald-300">{active} active</span>}
        </h2>
        {finished > 0 && (
          <button onClick={clearFinished} className="font-mono text-[11px] text-zinc-600 transition hover:text-zinc-300">
            clear finished
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-zinc-800 px-4 py-6 text-zinc-600">
          <Inbox size={18} className="shrink-0" />
          <p className="text-[13px]">
            Queue is empty. Paste a link above — the queue list <span className="text-zinc-400">is</span> the interface.
          </p>
        </div>
      ) : (
        <motion.div layout className="flex flex-col gap-2">
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <QueueRow key={item.id} item={item} />
            ))}
          </AnimatePresence>
        </motion.div>
      )}
    </section>
  );
}
