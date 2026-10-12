# Offtube

Personal offline-first YouTube downloader — paste a link, pick quality, download.
Windows desktop app built with **Tauri v2 + React 19 + TypeScript + Tailwind**.

> v0.1 scaffold: Tauri + React + Tailwind wired, sidecar spawning works,
> single-URL download with quality picker + progress, silent engine updater in
> place. Playlists / subtitles / audio-extract UI land in v0.2.

## Stack

| Layer    | Choice |
|----------|--------|
| Shell    | Tauri v2 (Rust backend is a thin orchestrator only) |
| UI       | React 19 + TypeScript + Tailwind CSS v4 |
| State    | zustand (download queue) |
| Motion   | framer-motion |
| Engine   | **yt-dlp** sidecar + **ffmpeg** sidecar (merge / MP3) + **deno** sidecar (YouTube signature challenges) |

The backend shells out to the sidecars, parses yt-dlp JSON metadata (`-J`),
streams progress events to the UI. No download logic lives in Rust beyond
orchestration.

## Quick start (Windows)

```powershell
# 1. install JS deps
npm install

# 2. run in dev (sidecars resolve via app-data bin → bundled → PATH,
#    so a `yt-dlp`/`ffmpeg` on PATH is enough to develop)
npm run tauri dev

# 3. typecheck / web build
npm run check
npm run build

# 4. rust checks
cd src-tauri
cargo check
cargo clippy -- -D warnings   # optional
```

## Sidecar binaries

Large platform executables live in `src-tauri/binaries/` (git-ignored) and are
declared in `tauri.conf.json > bundle.externalBin`. Fetch them before
`tauri build` — see [`src-tauri/binaries/README.md`](src-tauri/binaries/README.md).

## Engine updater

On launch (max once/24h) the app checks
`api.github.com/repos/yt-dlp/yt-dlp/releases/latest`, compares the tag with
`yt-dlp --version`, and — if newer — downloads the platform asset +
`SHA2-256SUMS`, verifies the checksum (mandatory), atomically swaps
(`.new` → `.old` → live) into the per-user bin dir, and confirms with
`--version`. Offline or failed checks quietly keep serving the existing
sidecar. Settings exposes **Update engine**, a **prefer nightly** toggle, and a
free-form **extra-args** passthrough (config-driven, so future yt-dlp flags
never need a rebuild).

## Project layout

```text
src/
  App.tsx                 shell: header, queue, footer, settings drawer
  components/
    UrlBar.tsx            add-by-URL + metadata fetch trigger
    Queue.tsx             the interface: rows, quality picker, format table, progress
    Settings.tsx          folder, engine update, nightly toggle, extra args
  stores/
    useQueue.ts           zustand download queue
    useSettings.ts        zustand settings + engine status
  lib/
    tauri.ts              typed invoke wrappers mirroring Rust commands
    format.ts             duration / bytes / counts
src-tauri/
  src/
    lib.rs                commands + app state + launch wiring
    downloads.rs          metadata (-J), progress streaming, cancel
    updater.rs            silent yt-dlp updater
    sidecar.rs            binary resolution + spawning
    settings.rs           JSON settings persistence
  binaries/               sidecars (git-ignored, see README inside)
```

## License

MIT — see [LICENSE](LICENSE).
