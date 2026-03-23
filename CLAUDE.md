# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is mx

A fast, lightweight markdown editor built with Tauri 2 + Rust. Successor to MacDown. Features: live split preview, Mermaid diagrams, KaTeX math, YAML frontmatter, PDF export via Pandoc, auto-update, native Apple Silicon support, git sync (auto-commit/push on save), Obsidian-style callouts & interactive checklists, conflict resolution, version history with snapshots. Current version: 1.1.0. License: GPL-3.0.

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
- **Monolithic**: entire app in `src/main.ts` (~4200 lines) + `src/styles.css` + `index.html`
- Vanilla TypeScript, no framework (CodeMirror 6 for editor, markdown-it for preview)
- Rendering pipeline: markdown-it → callouts → checklists → KaTeX (math) → Mermaid (diagrams) → YAML frontmatter extraction
- Git integration: state management (gitStatusMap, gitRepoInfo, autoSyncEnabled), non-blocking sync via fire-and-forget promises
- 300ms debounce on content change before re-rendering preview
- State: `currentFilePath`, `editor` (CM6 instance), `zoomLevel` — persisted in localStorage
- Theme: Catppuccin Mocha dark palette via CSS variables (`--bg: #1e1e2e`, `--accent: #89b4fa`, etc.)
- View modes: split | editor-only | preview-only
- Key bindings: Cmd+O (open), Cmd+S (save), Cmd+P (toggle preview), Cmd+E (read mode), Cmd+B (sidebar)

### Backend (`src-tauri/`)
- `src/lib.rs` (~1800 lines): all Tauri commands
- File commands: `read_file`, `save_file`, `word_count`, `list_directory`, `get_home_dir`, `get_initial_file`
- Export: `export_pdf` (Pandoc + task_lists), `export_html` (custom renderer with callout/tag CSS), `export_docx`
- Git commands (git2 crate): `git_repo_info`, `git_status`, `git_diff_file`, `git_log`, `git_commit`, `git_push`, `git_pull`, `git_auto_sync`, `git_setup_sync`, `git_check_auth`, `git_init`, `git_discard_file`, `git_stage_file`, `git_file_at_commit`, `git_restore_file`, `git_conflict_info`, `git_resolve_conflict`
- Snapshot commands: `save_snapshot`, `list_snapshots`, `read_snapshot`
- Credential handling: SSH agent → SSH key files → system `git credential fill` (HTTPS)
- Plugins: dialog, process, opener, updater

### Build/Release
- Vite dev server on :1420, HMR on :1421
- CI matrix: macOS aarch64, Windows x86_64, Linux x86_64
- Updater: signed `.tar.gz`/`.sig` artifacts, `latest.json` manifest on GitHub Releases
- Bundle file associations: `.md`, `.markdown`, `.yaml`, `.yml`, `.txt`

## Docs

Technical docs in `docs/` (00-07) cover architecture, editor engine, preview pipeline, file ops, PDF export, UI layout, auto-update, and release pipeline.
