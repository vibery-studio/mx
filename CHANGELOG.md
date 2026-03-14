# Changelog

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
