import { motion } from "framer-motion";
import {
  AlertTriangle,
  Check,
  Cpu,
  FlaskConical,
  FolderDown,
  Gauge,
  Loader2,
  RefreshCw,
  SearchCheck,
  Terminal,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { timeAgo } from "../lib/format";
import { DEFAULT_FRAGMENTS, FRAGMENT_OPTIONS, useSettings } from "../stores/useSettings";

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

function Switch({ on, onFlip, label }: { on: boolean; onFlip: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onFlip}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${
        on ? "bg-emerald-400" : "bg-zinc-700"
      }`}
    >
      <motion.span
        animate={{ x: on ? 16 : 0 }}
        transition={{ type: "spring", stiffness: 600, damping: 32 }}
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full ${on ? "bg-zinc-950" : "bg-zinc-300"}`}
      />
    </button>
  );
}

function Section({
  icon,
  title,
  blurb,
  children,
  index,
}: {
  icon: ReactNode;
  title: string;
  blurb: string;
  children: ReactNode;
  index: number;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: 0.06 + index * 0.06, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-zinc-500">{icon}</span>
        <h3 className="text-[13px] font-semibold text-zinc-100">{title}</h3>
      </div>
      <p className="-mt-1 mb-2.5 text-[12px] leading-relaxed text-zinc-500">{blurb}</p>
      {children}
    </motion.section>
  );
}

function StatusRow({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn" | "bad";
  title?: string;
}) {
  const dot = tone === "ok" ? "bg-emerald-400" : tone === "warn" ? "bg-amber-300" : "bg-red-400";
  const text = tone === "ok" ? "text-zinc-300" : tone === "warn" ? "text-amber-200" : "text-red-300";
  return (
    <div className="flex items-center justify-between py-1" title={title}>
      <span className="font-mono text-[11px] text-zinc-500">{label}</span>
      <span className={`flex items-center gap-1.5 font-mono text-[11px] ${text}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {value}
      </span>
    </div>
  );
}

const SELECTION_FLAGS = ["-f", "--format", "--match-filter", "--match-filter-range"];

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  const updating = s.busy === "update";
  const checking = s.busy === "check";
  const prog = s.engineProgress;
  const flags = s.extraArgs.split(/\s+/).filter(Boolean);
  const hasSelectionFlags = flags.some((f) => SELECTION_FLAGS.includes(f));

  return (
    <motion.aside
      initial={{ x: 360, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 360, opacity: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 36 }}
      className="fixed right-0 top-0 z-40 flex h-full w-[372px] flex-col border-l border-zinc-800 bg-zinc-950"
    >
      <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3.5">
        <div>
          <h2 className="text-[14px] font-semibold text-zinc-100">Settings</h2>
          <p className="font-mono text-[10px] text-zinc-600">offtube v0.1 · tauri + yt-dlp</p>
        </div>
        <button onClick={onClose} className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 space-y-6 overflow-auto px-5 py-5">
        {/* ------------------------------------------------ downloads */}
        <Section
          index={0}
          icon={<FolderDown size={15} />}
          title="Downloads"
          blurb="Where finished files land and how hard the engine pulls."
        >
          <div className="flex items-center gap-2">
            <p
              className="min-w-0 flex-1 truncate rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-2 font-mono text-[11px] text-zinc-300"
              title={s.downloadDir}
            >
              {s.downloadDir || "…"}
            </p>
            <button
              onClick={() => s.pickDir()}
              disabled={s.busy === "pick"}
              className="h-8 shrink-0 rounded-lg border border-zinc-700 px-3 text-[12px] text-zinc-300 transition hover:bg-zinc-800 active:scale-[0.98] disabled:opacity-50"
            >
              Change
            </button>
          </div>

          <div className="mt-3 flex items-center justify-between">
            <span className="text-[12px] text-zinc-400">Parallel fragments</span>
            <div className="flex gap-1 rounded-lg bg-zinc-900/80 p-1">
              {FRAGMENT_OPTIONS.map((n) => (
                <button
                  key={n}
                  onClick={() => s.setFragments(n)}
                  className={`min-w-7 rounded-md px-1.5 py-1 font-mono text-[11px] tabular transition ${
                    s.fragments === n
                      ? "bg-zinc-700 text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-zinc-600">
            DASH/HLS parts fetched at once. {DEFAULT_FRAGMENTS} saturates most lines; raise it for
            gigabit or 2GB+ files.
          </p>
        </Section>

        {/* ------------------------------------------------ engine */}
        <Section
          index={1}
          icon={<Cpu size={15} />}
          title="Engine"
          blurb="yt-dlp does the fetching; Offtube keeps it fresh and healthy."
        >
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[16px] font-semibold tabular text-zinc-100">
                {s.engine?.installedVersion ?? "not found"}
              </span>
              <span className="rounded border border-zinc-700/80 px-1.5 py-px font-mono text-[10px] uppercase tracking-wider text-zinc-400">
                {s.engine?.source ?? "—"}
              </span>
            </div>

            <div className="mt-2 divide-y divide-zinc-800/60">
              <StatusRow
                label="ffmpeg"
                value={s.engine?.ffmpegOk ? "ok" : "missing"}
                tone={s.engine?.ffmpegOk ? "ok" : "bad"}
                title={s.engine?.ffmpegPath ?? "needed to merge video + audio"}
              />
              <StatusRow
                label="deno"
                value={s.engine?.denoOk ? "ok" : "missing"}
                tone={s.engine?.denoOk ? "ok" : "warn"}
                title="JS runtime for YouTube signature challenges — some videos need it"
              />
              <div className="flex items-center justify-between py-1">
                <span className="font-mono text-[11px] text-zinc-500">last check</span>
                <span className="font-mono text-[11px] text-zinc-400">
                  {timeAgo(s.engine?.lastChecked)}
                </span>
              </div>
            </div>

            {s.updateCheck?.updateAvailable && (
              <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-emerald-400/10 px-2.5 py-2 font-mono text-[11px] text-emerald-200">
                <Check size={13} />
                {s.updateCheck.latest} available
                {s.updateCheck.current ? ` (have ${s.updateCheck.current})` : ""}
              </p>
            )}

            {updating && prog && (
              <div className="mt-3">
                <div className="flex items-center justify-between font-mono text-[11px] text-zinc-400">
                  <span className="capitalize">{prog.stage}…</span>
                  <span className="tabular">{prog.percent != null ? `${prog.percent.toFixed(0)}%` : ""}</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-emerald-400 transition-[width] duration-200"
                    style={{ width: `${Math.min(100, Math.max(2, prog.percent ?? 2))}%` }}
                  />
                </div>
                <p className="mt-1 truncate font-mono text-[10px] text-zinc-600" title={prog.detail}>
                  {prog.detail}
                </p>
              </div>
            )}

            <div className="mt-3 flex gap-2">
              <button
                onClick={() => s.checkUpdate()}
                disabled={checking || updating}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-700 px-2 py-2 text-[12px] text-zinc-200 transition hover:bg-zinc-800 active:scale-[0.98] disabled:opacity-50"
              >
                {checking ? <Loader2 size={13} className="animate-spin" /> : <SearchCheck size={13} />}
                {checking ? "Checking…" : "Check"}
              </button>
              <button
                onClick={() => s.runUpdate()}
                disabled={
                  updating || (s.updateCheck != null && !s.updateCheck.updateAvailable)
                }
                className="flex flex-[1.4] items-center justify-center gap-1.5 rounded-lg bg-emerald-400 px-2 py-2 text-[12px] font-semibold text-zinc-950 transition hover:bg-emerald-300 active:scale-[0.98] disabled:opacity-40"
              >
                {updating ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <RefreshCw size={13} />
                )}
                {updating
                  ? "Updating…"
                  : s.updateCheck?.updateAvailable
                    ? `Update to ${s.updateCheck.latest}`
                    : "Update engine"}
              </button>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3 border-t border-zinc-800/80 pt-3">
              <div className="flex items-center gap-2">
                <FlaskConical size={13} className="shrink-0 text-zinc-500" />
                <div>
                  <p className="text-[12px] text-zinc-300">Nightly builds</p>
                  <p className="font-mono text-[10px] leading-snug text-zinc-600">
                    fresher extractors, occasional breakage
                  </p>
                </div>
              </div>
              <Switch
                on={s.preferNightly}
                onFlip={() => s.setNightly(!s.preferNightly)}
                label="Prefer nightly builds"
              />
            </div>
          </div>
        </Section>

        {/* ------------------------------------------------ advanced */}
        <Section
          index={2}
          icon={<Terminal size={15} />}
          title="Advanced"
          blurb="Raw flags for every yt-dlp call. Future flags work without a rebuild."
        >
          <input
            value={s.extraArgs}
            onChange={(e) => s.setExtraArgs(e.target.value)}
            placeholder="--socket-timeout 30 --retries 10"
            spellCheck={false}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 font-mono text-[12px] text-zinc-200 placeholder:text-zinc-700 focus:border-zinc-600 focus:outline-none"
          />
          {flags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {flags.map((f, i) => (
                <span
                  key={`${f}-${i}`}
                  className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
                >
                  {f}
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-2 font-mono text-[11px] text-zinc-700">no extra flags — yt-dlp defaults</p>
          )}
          {hasSelectionFlags && (
            <p className="mt-2 flex items-start gap-1.5 font-mono text-[11px] leading-relaxed text-amber-200/90">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              Selection flags (-f, --match-filter) shape downloads; the format list always
              fetches unfiltered.
            </p>
          )}
        </Section>

        {s.notice && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className={`rounded-xl border p-3 ${
              s.notice.toLowerCase().includes("fail")
                ? "border-red-500/30 bg-red-500/5"
                : "border-zinc-800 bg-zinc-900/60"
            }`}
          >
            <p
              className={`font-mono text-[11px] leading-relaxed ${
                s.notice.toLowerCase().includes("fail") ? "text-red-300" : "text-zinc-300"
              }`}
            >
              {s.notice}
            </p>
            <button
              onClick={() => s.dismissNotice()}
              className="mt-1.5 font-mono text-[11px] text-zinc-600 transition hover:text-zinc-300"
            >
              dismiss
            </button>
          </motion.div>
        )}

        <div className="flex items-center gap-2 rounded-xl border border-zinc-800/70 px-3.5 py-3">
          <Gauge size={13} className="shrink-0 text-zinc-600" />
          <p className="font-mono text-[10px] leading-relaxed text-zinc-600">
            Fragment downloads run {s.fragments}-way parallel; the engine re-checks itself at
            most once a day.
          </p>
        </div>
      </div>
    </motion.aside>
  );
}
