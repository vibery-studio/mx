# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is mx

A fast, lightweight markdown editor built with Tauri 2 + Rust. Successor to MacDown. Features: live split preview, Mermaid diagrams, KaTeX math, YAML frontmatter, PDF export via Pandoc, auto-update, native Apple Silicon support. Current version: 1.0.0. License: GPL-3.0.

## Commands

```bash
npm install              # Install dependencies
npm run tauri dev        # Dev server (Vite :1420) + Rust backend in watch mode
npm run build            # TS compile + Vite bundle → dist/
npm run tauri build      # Full app bundle (per platform)
```

No test framework or linter configured.

Release: push a `v*` tag to trigger `.github/workflows/release.yml` (builds macOS/Windows/Linux, signs, creates GitHub Release with `latest.json` for auto-updater).

## Architecture

**Tauri 2 IPC-first**: all file/system ops go through Rust commands, no direct Node.js access from frontend.

### Frontend (`src/`)
- **Monolithic**: entire app in `src/main.ts` (~890 lines) + `src/styles.css` + `index.html`
- Vanilla TypeScript, no framework (CodeMirror 6 for editor, markdown-it for preview)
- Rendering pipeline: markdown-it → KaTeX (math) → Mermaid (diagrams) → YAML frontmatter extraction
- 300ms debounce on content change before re-rendering preview
- State: `currentFilePath`, `editor` (CM6 instance), `zoomLevel` — persisted in localStorage
- Theme: Catppuccin Mocha dark palette via CSS variables (`--bg: #1e1e2e`, `--accent: #89b4fa`, etc.)
- View modes: split | editor-only | preview-only
- Key bindings: Cmd+O (open), Cmd+S (save), Cmd+P (toggle preview), Cmd+E (read mode), Cmd+B (sidebar)

### Backend (`src-tauri/`)
- `src/lib.rs` (~266 lines): all Tauri commands
- Commands: `read_file`, `save_file`, `word_count`, `list_directory`, `get_home_dir`, `get_initial_file`, `export_pdf`
- PDF export: extracts Mermaid blocks → calls mermaid.ink API for PNGs → runs Pandoc with xelatex/pdflatex
- macOS file association handler: emits "open-file" event to frontend on Finder double-click
- Plugins: dialog, process, opener, updater

### Build/Release
- Vite dev server on :1420, HMR on :1421
- CI matrix: macOS aarch64, Windows x86_64, Linux x86_64
- Updater: signed `.tar.gz`/`.sig` artifacts, `latest.json` manifest on GitHub Releases
- Bundle file associations: `.md`, `.markdown`, `.yaml`, `.yml`, `.txt`

## Docs

Technical docs in `docs/` (00-07) cover architecture, editor engine, preview pipeline, file ops, PDF export, UI layout, auto-update, and release pipeline.
