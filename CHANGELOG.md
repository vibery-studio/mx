# Changelog

## 1.1.0

### Git Sync (Google Drive-like)
- One-click sync setup: paste a GitHub repo URL, auto-inits repo, sets remote, pushes
- Auto-sync on save: commit + push to cloud automatically when enabled
- Auto-pull on folder open: fetches latest changes from remote
- HTTPS credential support via system git credential helpers (macOS Keychain, Windows Credential Manager, `gh auth`)
- SSH agent + key file support
- Non-blocking: all sync operations run in background without freezing the editor
- Sync status in status bar: "✓ Synced", "3 unsaved", "Local only"

### Git UI
- Sidebar git status dots: colored indicators for modified (orange), new (green), deleted (red), staged (blue), conflict (purple)
- Git panel in sidebar: branch name, changed files list, commit message input, sync button
- File History modal: commits tab (git log) + snapshots tab (auto-saves), with View/Restore buttons
- Side-by-side diff view for any version vs current
- Context menu: File History, Discard Changes
- Auto-sync toggle in File menu

### Conflict Resolution
- Side-by-side conflict resolver: Your version vs Incoming version
- Three resolution options: Keep yours, Accept incoming, Keep both
- Auto-opens when sync detects conflicts

### Version History & Snapshots
- Auto-snapshots every 60s when content changes (stored in ~/.mx/snapshots/, keeps last 50 per file)
- Restore from any git commit or local snapshot
- Diff view between any version and current content

### Obsidian Compatibility
- Callout blocks: `> [!type] title` with colored styling (supports: note, info, tip, success, warning, danger, question, bug, example, quote, abstract)
- Interactive checklists: `- [ ]` / `- [x]` render as clickable checkboxes that toggle in source
- Frontmatter tags: `tags:` rendered as styled pill labels with remove buttons

### Export Improvements
- PDF export: proper checklist rendering (□/⊠), callouts as styled blockquotes, table support
- HTML export: callout CSS, tag styling, HTML pass-through
- Pandoc task_lists + pipe_tables extensions enabled

### Bug Fixes
- Context menu New File/Folder now works when right-clicking files (uses parent directory)
- Sidebar + and 📁 buttons create in the selected subfolder instead of always root
- Fix stale preview content on file switch (Windows)
- Folder watcher ignores .git directory changes (no spurious refreshes during git operations)
- Fix context menu target nulled before use (File History, Discard Changes)

## 1.0.3

- Fix file open on Linux/Windows
- Real DOCX export
- Better PDF error messages

## 1.0.1

- Tab context menu: right-click tab for Close, Close Others, Close to the Right, Close All
- Fix preview not rendering when opening a file from sidebar
- Fix word count and cursor position not updating on file open

## 1.0.0

- Multiple file tabs with preserved editor state (undo history, scroll position, selection)
- Multiple windows via Cmd+Shift+N, each with independent tabs and file watchers
- Customizable keyboard shortcuts with conflict detection (Help → Customize Shortcuts)
- Format bar moved to compact bar above editor pane
- Tab persistence across app restarts
- Close tab with Cmd+W (prompts to save unsaved changes)
- Fix recovery banner showing for unchanged files
- Per-window file watchers instead of global

## 0.9.9

- Use Latin Modern Roman font in PDF export (Computer Modern look, classic LaTeX science paper style)
- Falls back to Times New Roman if TeX Live Latin Modern fonts not installed

## 0.9.8

- Fix mermaid diagrams not rendering in PDF (switch to base64url encoding)
- Use Times New Roman for science paper look in PDF export
- Full Vietnamese/Unicode support in PDF (Times New Roman + SF NS Mono)
- Replace unsupported emoji/arrows with text equivalents before export

## 0.9.7

- Fix PDF export hanging forever (add 30s timeout for diagrams, 120s for pandoc)
- Fix Vietnamese characters showing as boxes in PDF
- PDF export now runs in background with live progress updates
- Release workflow now reads notes from CHANGELOG.md

## 0.9.6

- Fix crash caused by KqueueWatcher drop panic when unwatching folders
- Add sidebar refresh button for manual file list reload
- Log watcher errors instead of silently swallowing them
- Recover from poisoned mutex after watcher panics

## 0.9.5

- Persist UI state across sessions (sidebar width, view mode, zoom level)
- Help cheatsheet overlay
- Remove max-width on preview pane to allow free resize via divider
- Fix preview link navigation
- Document heading anchor IDs and copy-link button

## 0.9.4

- Mermaid diagram zoom: click any diagram to open fullscreen overlay with pan & pinch zoom (panzoom library)
- Mermaid rendering: always use light theme for readable text in both dark and light modes
- File watcher: auto-reload when external app modifies the current file; prompts if editor has unsaved changes
- Context menu: "Copy Path" now has submenu with Absolute Path and Relative Path options
- Web version: added Mermaid diagram zoom overlay (same as desktop)

## 0.9.3

- Center Mermaid diagram in zoom overlay with fit-to-screen scaling

## 0.9.2

- Fix laggy scroll sync between editor and preview
- Debounce scroll sync to prevent feedback loops

## 0.9.1

- Port 18 features to web version
- Font selection: System, Inter, Georgia, Merriweather, JetBrains Mono
- Scroll sync between editor and preview
- Formatting toolbar: bold, italic, heading, link, code, quote, list, hr
- Breadcrumb navigation
- Custom preview CSS via `~/.mx/preview.css`
- Wikilinks support
- Session restore

## 0.9.0

- File sidebar with directory browsing and drag-to-move
- File search (Cmd+Shift+F) with fuzzy matching
- Command palette (Cmd+Shift+P)
- Outline panel
- Auto-save with configurable interval
- Crash recovery with periodic snapshots
- Context menu: new file, new folder, rename, duplicate, copy path, reveal in Finder, delete
- Footnotes via markdown-it-footnote
- Code folding
- Zen mode (Cmd+Shift+Z)
- Image lightbox
- Copy modes: formatted HTML, raw markdown, plain text
- HTML export with inline CSS
- Duplicate and reveal in Finder

## 0.8.2

- Fix relative link navigation in preview

## 0.8.1

- Switch macOS build to universal binary (Apple Silicon + Intel)

## 0.8.0

- Light, dark, and system theme support with Catppuccin palette

## 0.7.0

- Toolbar redesign: grouped dropdown menus, cleaner layout

## 0.4.0

- In-app auto-update with weekly check
- Notion-style preview layout
- Tree view sidebar, zoom, recent files

## 0.3.0

- Copy formatted HTML (Cmd+Shift+C)
- Keyboard shortcuts
