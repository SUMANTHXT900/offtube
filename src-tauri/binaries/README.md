# Offtube sidecar binaries (v0.1)

The Rust backend is a thin orchestrator — all download work is done by
sidecar executables spawned via `tauri-plugin-shell`:

| sidecar  | purpose                                                        | upstream                                   |
|----------|----------------------------------------------------------------|--------------------------------------------|
| `yt-dlp` | download engine: metadata (`-J`), formats, progress, merging   | https://github.com/yt-dlp/yt-dlp           |
| `ffmpeg` | merge best video+audio, MP3 extract (`-x`)                     | https://ffmpeg.org / gyan.dev builds       |
| `deno`   | JS runtime sidecar — YouTube signature challenges require it   | https://github.com/denoland/deno           |

## Expected filenames (Tauri `externalBin` convention)

`tauri.conf.json > bundle.externalBin` lists `binaries/yt-dlp`,
`binaries/ffmpeg`, `binaries/deno`. At bundle time Tauri appends the
target triple + `.exe` on Windows, so place files as:

```text
src-tauri/binaries/
  yt-dlp-x86_64-pc-windows-msvc.exe
  ffmpeg-x86_64-pc-windows-msvc.exe   (or ffmpeg.exe renamed per triple)
  deno-x86_64-pc-windows-msvc.exe
```

These are git-ignored (see root `.gitignore`) — they are large and
platform-specific. CI / release builds fetch them before `tauri build`.

## Fetching (Windows x64, PowerShell)

```powershell
# 1. yt-dlp (stable)
$tag = (Invoke-RestMethod https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest).tag_name
Invoke-WebRequest "https://github.com/yt-dlp/yt-dlp/releases/download/$tag/yt-dlp.exe" `
  -OutFile "src-tauri/binaries/yt-dlp-x86_64-pc-windows-msvc.exe"

# 2. ffmpeg (essentials build)
Invoke-WebRequest "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile "$env:TEMP\ffmpeg.zip"
Expand-Archive "$env:TEMP\ffmpeg.zip" "$env:TEMP\ff" -Force
Copy-Item "$env:TEMP\ff\*\bin\ffmpeg.exe" "src-tauri/binaries\ffmpeg-x86_64-pc-windows-msvc.exe"

# 3. deno
Invoke-WebRequest "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip" `
  -OutFile "$env:TEMP\deno.zip"
Expand-Archive "$env:TEMP\deno.zip" "$env:TEMP\deno" -Force
Copy-Item "$env:TEMP\deno\deno.exe" "src-tauri/binaries\deno-x86_64-pc-windows-msvc.exe"
```

## Dev fallback

If a sidecar is absent (fresh clone, no binaries yet), the backend falls
back in order: **updated app-data bin → bundled sidecar → system PATH**
(`yt-dlp`, `ffmpeg`, `deno`). So `cargo tauri dev` works with
`yt-dlp`/`ffmpeg` installed on PATH while you wire the UI.

## Runtime updater

On first run the engine updater copies/checks versions into
`%APPDATA%\com.offtube.app\offtube\bin\` (per-user, writable) and performs
atomic swaps there (`.new` → `.old` → live) after SHA2-256 verification —
it never tries to overwrite the read-only bundled copy under Program Files.
