import { useState } from "react";
import { ArrowDownToLine, Link2 } from "lucide-react";
import { useQueue } from "../stores/useQueue";
import { useSettings } from "../stores/useSettings";

const URL_HINT = /(youtube\.com|youtu\.be|v=|youtu\.be\/|shorts\/|live\/)/i;

export function UrlBar() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const fetchUrl = useQueue((s) => s.fetchUrl);
  const autofetch = useSettings((s) => s.autofetch);

  const submit = async (raw?: string) => {
    const trimmed = (raw ?? url).trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await fetchUrl(trimmed);
      setUrl("");
    } finally {
      setBusy(false);
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    if (!autofetch) return;
    const text = e.clipboardData.getData("text").trim();
    // Only autofetch when the paste looks like a video link — plain text
    // stays editable so a stray paste never fires a fetch.
    if (text && URL_HINT.test(text) && !busy) {
      e.preventDefault();
      setUrl(text);
      void submit(text);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="flex items-center gap-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-500">
          <Link2 size={16} />
        </div>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Paste a YouTube link — https://youtube.com/watch?v=…"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 bg-transparent font-mono text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
        />
        <button
          onClick={() => submit()}
          disabled={!url.trim() || busy}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-emerald-400 px-3.5 text-[13px] font-semibold text-zinc-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowDownToLine size={15} />
          {busy ? "Fetching…" : "Fetch"}
        </button>
      </div>
      <p className="mt-2 font-mono text-[11px] leading-relaxed text-zinc-600">
        {autofetch
          ? "Pasting a link fetches it instantly — toggle in settings."
          : "Single videos in v0.1 — playlists, subtitles and audio-extract UI land in v0.2."}
      </p>
    </div>
  );
}
