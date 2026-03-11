# Auto-Update Implementation — mx (Tauri 2)

## Stack
Tauri 2 + Rust desktop markdown editor. macOS/Windows/Linux. Previously manual DMG/EXE/DEB downloads via GitHub Releases.

## Dependencies Added
- **Rust**: `tauri-plugin-updater` (with `#[cfg(desktop)]` guard), `tauri-plugin-process`
- **JS**: `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`
- **Capabilities**: `updater:default`, `process:allow-restart` in `capabilities/default.json`
- Plugins registered in `lib.rs` via `.setup()` closure

## Updater Config (`tauri.conf.json`)
- Endpoint: `https://github.com/vibery-studio/mx/releases/latest/download/latest.json`
- Signing keypair via `tauri signer generate` (used `expect` for non-interactive TTY)
- Pubkey in `tauri.conf.json`, private key as GitHub secret `TAURI_SIGNING_PRIVATE_KEY`
- **Critical**: `"createUpdaterArtifacts": true` in bundle config — without this, no `.tar.gz`/`.sig` files are generated

## Frontend Logic
- `checkForUpdates()` runs 3s after startup, non-blocking
- Throttled to once/week via localStorage timestamp
- Manual trigger in Help dropdown menu
- Status bar progress: "Update X available — downloading... N%" -> "Update installed — click to restart"
- Uses discriminated union `DownloadEvent` type (Started/Progress/Finished)

## Toolbar Redesign
Old: 11 flat buttons. New: File/View/Help dropdowns with keyboard shortcut hints. Always-visible: Copy, Zoom controls. Dropdowns close on outside click, mutex open state.

## Bugs Encountered

| # | Issue | Root Cause | Fix |
|---|-------|-----------|-----|
| 1 | "Signature not found for updater JSON" | `tauri-action@v0` couldn't merge sigs across matrix jobs | Replaced with manual `npx tauri build` + separate release job |
| 2 | upload-artifact missed `.tar.gz`/`.sig` | Glob patterns `**/*.app.tar.gz` didn't match nested paths in v4 | Upload entire `bundle/` directory |
| 3 | No `.tar.gz`/`.sig` generated | Missing `"createUpdaterArtifacts": true` in tauri.conf.json | Added the config |
| 4 | Empty signatures/URLs in latest.json | Script used Tauri 1 naming (`*.AppImage.tar.gz`, `*-setup.nsis.zip`) | Updated to Tauri 2 names: `mx.app.tar.gz`, `*.AppImage` + `.sig`, `*-setup.exe` + `.sig` |
| 5 | Build failed on signing step | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` not set | Set empty GitHub secret |
| 6 | macOS Gatekeeper "app is damaged" | No Apple Developer codesign | Workaround: `xattr -cr /Applications/mx.app` |

## Tauri 2 vs Tauri 1 Artifact Differences
- **macOS**: `mx.app.tar.gz` + `.sig` (same)
- **Linux**: `*.AppImage` + `.sig` directly (no `.tar.gz` wrapper)
- **Windows**: `*-setup.exe` + `.sig` directly (no `.nsis.zip` wrapper)

## CI Architecture
```
build (3 parallel: macOS/Windows/Linux)
  -> npx tauri build --target $TARGET
  -> upload-artifact (entire bundle/ dir)

release (after all builds)
  -> download-artifact (merge all)
  -> collect installers + updater artifacts + sigs
  -> generate latest.json with per-platform signatures
  -> gh release create with all files
```

## Key Takeaways
1. `createUpdaterArtifacts: true` is essential for updater to work
2. Manual CI workflow > `tauri-action@v0` for matrix builds with updater JSON
3. Tauri 2 signs installers directly — no tar.gz wrapper on Linux/Windows
4. Signing key password env var must exist even if empty
5. Non-blocking update check + weekly throttle + manual option = good UX

## Versions
v0.5.0 -> v0.6.0 (re-tagged 4 times fixing CI). Final working: v0.6.0 with complete latest.json.
