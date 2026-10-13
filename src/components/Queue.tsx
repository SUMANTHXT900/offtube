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
import { useMemo, useState } from "react";
import { fmtBytes, fmtCount, fmtDuration, shortCodec } from "../lib/format";
import { buildLadder, type LadderAudioRow, type LadderVideoRow } from "../lib/ladder";
import { api } from "../lib/tauri";
import { activeKey, useQueue, type QueueItem } from "../stores/useQueue";

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
      return <span className={cls}>{item.detail ?? "ready"}</span>;
  }
}

function Radio({ on }: { on: boolean }) {
  return (
    <span
      className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors ${
        on ? "border-emerald-300" : "border-zinc-700"
      }`}
    >
      {on && <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />}
    </span>
  );
}

function VideoRow({
  row,
  selected,
  onPick,
}: {
  row: LadderVideoRow;
  selected: boolean;
  onPick: () => void;
}) {
  const detail = [
    row.vcodec ? shortCodec(row.vcodec) : "auto",
    row.acodec ? shortCodec(row.acodec) : row.key === "best" ? "best audio" : null,
    row.key === "best" ? null : row.merged ? "merged" : "progressive",
    row.key === "best" ? "merged → mp4" : "→ mp4",
    row.hdr ? "HDR" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      onClick={onPick}
      className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
        selected ? "bg-emerald-400/10" : "hover:bg-zinc-800/70"
      }`}
    >
      <Radio on={selected} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={`text-[13px] font-medium ${selected ? "text-emerald-200" : "text-zinc-100"}`}>
            {row.label}
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular text-zinc-300">
            {row.size != null ? fmtBytes(row.size, row.approx) : "—"}
          </span>
        </span>
        <span className="block truncate font-mono text-[11px] text-zinc-500">{detail}</span>
      </span>
    </button>
  );
}

function AudioRow({
  row,
  selected,
  onPick,
}: {
  row: LadderAudioRow;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      onClick={onPick}
      className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
        selected ? "bg-emerald-400/10" : "hover:bg-zinc-800/70"
      }`}
    >
      <Radio on={selected} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={`text-[13px] font-medium ${selected ? "text-emerald-200" : "text-zinc-100"}`}>
            {row.label}
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular text-zinc-300">
            {row.size != null ? fmtBytes(row.size, row.approx) : "—"}
          </span>
        </span>
        <span className="block truncate font-mono text-[11px] text-zinc-500">{row.detail}</span>
      </span>
    </button>
  );
}

function QualityPicker({ item }: { item: QueueItem }) {
  const [showAll, setShowAll] = useState(false);
  const setSelKey = useQueue((s) => s.setSelKey);
  const setMode = useQueue((s) => s.setMode);
  const ladder = useMemo(
    () => buildLadder(item.formats, item.duration),
    [item.formats, item.duration],
  );
  const key = activeKey(item);
  const video = item.mode === "video";
  // The expander follows the mode: video lists video formats, audio lists audio-only.
  const allList = useMemo(
    () =>
      video
        ? ladder.allSorted.filter((f) => f.isVideo)
        : ladder.allSorted.filter((f) => !f.isVideo && f.isAudio),
    [ladder, video],
  );
  const hasVideo = ladder.videoRows.length > 0;
  const hasAudio = ladder.audioRows.length > 0;

  if (!hasVideo && !hasAudio) {
    return (
      <p className="mt-2 font-mono text-[11px] text-amber-300/90">
        no downloadable formats listed — the video may be DRM-protected or members-only
      </p>
    );
  }

  return (
    <div className="mt-1.5 rounded-lg border border-zinc-800 bg-zinc-950/60 p-1.5">
      {/* mode switch — free to flip until the download starts; each mode keeps its pick */}
      <div className="mb-1 flex gap-1 rounded-lg bg-zinc-900/80 p-1">
        {(
          [
            { m: "video", label: `Video · ${ladder.videoRows.length}`, enabled: hasVideo },
            { m: "audio", label: `Audio · ${ladder.audioRows.length}`, enabled: hasAudio },
          ] as const
        ).map((t) => (
          <button
            key={t.m}
            disabled={!t.enabled}
            onClick={() => setMode(item.id, t.m)}
            className={`flex-1 rounded-md px-2 py-1 font-mono text-[11px] transition ${
              video === (t.m === "video")
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            } disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {video ? (
        <>
          <p className="px-2 pb-1 pt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
            video · merged, includes audio
          </p>
          {ladder.videoRows.map((row) => (
            <VideoRow
              key={row.key}
              row={row}
              selected={key === row.key}
              onPick={() => setSelKey(item.id, row.key)}
            />
          ))}
        </>
      ) : (
        <>
          <p className="px-2 pb-1 pt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
            audio · no video
          </p>
          {ladder.audioRows.map((row) => (
            <AudioRow
              key={row.key}
              row={row}
              selected={key === row.key}
              onPick={() => setSelKey(item.id, row.key)}
            />
          ))}
        </>
      )}
      <button
        onClick={() => setShowAll((v) => !v)}
        className="mt-1 flex w-full items-center gap-1 rounded-md px-2 py-1 font-mono text-[11px] text-zinc-500 transition hover:bg-zinc-800/70 hover:text-zinc-200"
      >
        all {allList.length} {video ? "video" : "audio"} formats
        <ChevronDown size={13} className={`transition-transform ${showAll ? "rotate-180" : ""}`} />
      </button>
      {showAll && (
        <div className="mt-1 max-h-56 overflow-auto rounded-lg border border-zinc-800">
          <table className="w-full font-mono text-[11px]">
            <thead className="sticky top-0 bg-zinc-950 text-left text-zinc-500">
              <tr>
                <th className="px-2 py-1.5 font-medium">id</th>
                <th className="px-2 py-1.5 font-medium">ext</th>
                <th className="px-2 py-1.5 font-medium">res</th>
                <th className="px-2 py-1.5 font-medium">fps</th>
                <th className="px-2 py-1.5 text-right font-medium">size</th>
                <th className="px-2 py-1.5 text-right font-medium">tbr</th>
                <th className="px-2 py-1.5 font-medium">codecs</th>
              </tr>
            </thead>
            <tbody>
              {allList.map((f) => {
                const ckey = `custom:${f.formatId}`;
                const selected = key === ckey;
                const res =
                  f.height != null
                    ? `${f.height}p${f.fps != null && f.fps >= 48 ? Math.round(f.fps) : ""}`
                    : (f.isAudio ? "audio" : (f.resolution ?? "—"));
                return (
                  <tr
                    key={f.formatId}
                    onClick={() => setSelKey(item.id, ckey)}
                    className={`cursor-pointer border-t border-zinc-800/60 transition-colors ${
                      selected ? "bg-emerald-400/10 text-emerald-200" : "text-zinc-400 hover:bg-zinc-800/60"
                    }`}
                  >
                    <td className="px-2 py-1">{f.formatId}</td>
                    <td className="px-2 py-1">{f.ext}</td>
                    <td className="px-2 py-1 tabular">{res}</td>
                    <td className="px-2 py-1 tabular">{f.fps != null ? Math.round(f.fps) : "—"}</td>
                    <td className="px-2 py-1 text-right tabular">
                      {f.filesize != null ? fmtBytes(f.filesize, f.filesizeApprox) : "—"}
                    </td>
                    <td className="px-2 py-1 text-right tabular">
                      {f.tbr != null ? `${Math.round(f.tbr)}k` : "—"}
                    </td>
                    <td className="px-2 py-1 text-zinc-500">
                      {[shortCodec(f.vcodec === "none" ? null : f.vcodec), shortCodec(f.acodec === "none" ? null : f.acodec)]
                        .filter((c) => c !== "—")
                        .join(" + ") || "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FetchingSkeleton({ item }: { item: QueueItem }) {
  return (
    <div className="min-w-0 flex-1" aria-live="polite">
      <div className="h-4 w-3/4 animate-pulse rounded bg-zinc-800" />
      <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-zinc-800/70" />
      <div className="mt-2.5 space-y-1.5">
        {[92, 78, 64].map((w) => (
          <div
            key={w}
            className="h-7 animate-pulse rounded-lg bg-zinc-800/50"
            style={{ width: `${w}%` }}
          />
        ))}
      </div>
      <p className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-zinc-400">
        <Loader2 size={12} className="animate-spin text-emerald-300" />
        {item.stage ?? "Starting fetch…"}
      </p>
    </div>
  );
}

function QueueRow({ item }: { item: QueueItem }) {
  const enqueue = useQueue((s) => s.enqueue);
  const cancel = useQueue((s) => s.cancel);
  const remove = useQueue((s) => s.remove);
  const fetchUrl = useQueue((s) => s.fetchUrl);

  const active = item.status === "downloading" || item.status === "merging";
  const pct = item.progress ?? (item.status === "completed" ? 100 : 0);
  const pickable =
    (item.status === "ready" || item.status === "error" || item.status === "cancelled") &&
    item.formats.length > 0;

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
        {item.status === "fetching" ? (
          <FetchingSkeleton item={item} />
        ) : (
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate text-[13px] font-medium text-zinc-100" title={item.title ?? item.url}>
              {item.title ?? item.url}
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

          {pickable && <QualityPicker item={item} />}

          <div className="mt-1.5">
            <StatusLine item={item} />
          </div>
          {item.status === "completed" && item.outputPath && (
            <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-600" title={item.outputPath}>
              {item.outputPath}
            </p>
          )}
        </div>
        )}

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
              item.title ? (
                <button
                  onClick={() => enqueue(item.id)}
                  title="Resume from where it stopped (--continue)"
                  className="flex items-center gap-1 rounded-md bg-emerald-400 px-2.5 py-1 text-[12px] font-semibold text-zinc-950 transition hover:bg-emerald-300"
                >
                  <Download size={13} /> resume
                </button>
              ) : (
                <button
                  onClick={() => {
                    const url = item.url;
                    remove(item.id);
                    fetchUrl(url);
                  }}
                  title="Retry fetch"
                  className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
                >
                  <RotateCcw size={15} />
                </button>
              )
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
