# mx

A fast, lightweight markdown editor for the AI era. Built with Tauri 2 + Rust.

**Website: [getmx.vibery.app](https://getmx.vibery.app/)**

![mx screenshot](screenshot.jpeg)

**Coming from [MacDown](https://macdown.uranusjr.com/)?** MacDown has been abandoned since 2020 — no Mermaid support, no Apple Silicon build, no updates. mx picks up where MacDown left off: same simplicity, but with modern features like Mermaid diagrams, KaTeX math, YAML frontmatter, and a fraction of the bundle size.

## Download

| Platform | Link |
|----------|------|
| macOS | [mx.dmg](https://github.com/vibery-studio/mx/releases/latest) |
| Windows | [mx.exe](https://github.com/vibery-studio/mx/releases/latest) |
| Linux | [mx.deb / .AppImage](https://github.com/vibery-studio/mx/releases/latest) |

> All downloads on the [Releases](https://github.com/vibery-studio/mx/releases) page.

### macOS: "mx is damaged and can't be opened"

macOS Gatekeeper blocks unsigned apps. After installing, run:

```bash
xattr -cr /Applications/mx.app
```

## Why mx?

Working with AI means opening dozens of markdown files every day. You need a fast editor that just works — not a vault-based system like Obsidian, not an abandoned app like MacDown. mx opens any `.md` file instantly with live preview. No vault. No config. Just open and go.

### mx vs MacDown

| | mx | MacDown |
|--|-----|---------|
| Status | Active | Abandoned (2020) |
| Mermaid diagrams | Yes | No |
| KaTeX math | Yes | MathJax (slow) |
| YAML frontmatter | Rendered | Raw text |
| Footnotes / Wikilinks | Yes | No |
| Code folding | Yes | No |
| File sidebar + search | Yes | No |
| Folder content search | Yes | No |
| Zen mode | Yes | No |
| Apple Silicon | Native universal | Rosetta only |
| Bundle size | ~8 MB | ~30 MB |
| Export | PDF, HTML, DOCX | PDF (broken) |
| File associations | .md, .yaml, .json, .txt | .md only |
| Cross-platform | macOS, Windows, Linux | macOS only |

## Features

### Editor
- **Live split preview** — markdown-it with syntax highlighting
- **Code folding** — collapse/expand blocks via gutter markers
- **Formatting toolbar** — bold, italic, heading, link, code, quote, list, hr
- **Search & replace** — Cmd+F / Cmd+H with regex support
- **Line numbers** — toggleable, with active line highlight
- **Selection count** — word/character count for selected text in status bar

### Markdown
- **Mermaid diagrams** — rendered inline with click-to-zoom fullscreen overlay (pan & pinch zoom)
- **KaTeX math** — inline `$...$` and display `$$...$$`
- **YAML frontmatter** — rendered as styled metadata table
- **Footnotes** — `[^1]` syntax via markdown-it-footnote
- **Wikilinks** — `[[page name]]` renders as clickable link to `page-name.md`

### File Management
- **File sidebar** — browse directories with drag-to-move reordering
- **Context menu** — new file, new folder, rename, duplicate, copy path (absolute/relative), reveal in Finder, delete
- **File search** — Cmd+Shift+F fuzzy search across folder
- **Content search** — Cmd+Opt+F search text inside all files in open folder, jump to exact keyword position
- **Command palette** — Cmd+Shift+P for quick actions
- **Breadcrumb navigation** — clickable path segments
- **Session restore** — reopens last file and folder on launch
- **Drag & drop** — drop any .md, .yaml, .json, .txt file or folder to open
- **Recent files** — quick access to recently opened files

### Writing
- **Auto-save** — configurable, saves after 3s of inactivity
- **Crash recovery** — periodic recovery snapshots for unsaved work
- **External change detection** — auto-reloads when file changes on disk, prompts if you have unsaved edits
- **Zen mode** — Cmd+Shift+Z, hides all chrome for distraction-free writing
- **Image paste** — paste images from clipboard directly into editor
- **Image lightbox** — click images in preview to zoom fullscreen

### Export & Copy
- **Copy modes** — formatted HTML, raw markdown, or plain text
- **PDF export** — via Pandoc with Mermaid diagram support
- **HTML export** — self-contained HTML with inline CSS, light/dark theme
- **DOCX export** — via Pandoc

### Customization
- **Themes** — light, dark, and auto (system) with Catppuccin palette
- **Font selection** — System, Inter, Georgia, Merriweather, JetBrains Mono
- **Custom preview CSS** — load your own styles from `~/.mx/preview.css`
- **Resizable panes** — drag divider between editor and preview, resize sidebar
- **Zoom** — Cmd+/- to scale editor and preview

### Platform
- **Word & character count** — real-time in status bar
- **Auto-update** — checks for updates weekly, downloads in background
- **File associations** — .md, .markdown, .yaml, .yml, .txt
- **Cross-platform** — macOS (universal binary), Windows, Linux

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+O` | Open file |
| `Cmd+S` | Save file |
| `Cmd+N` | New file |
| `Cmd+P` | Toggle preview |
| `Cmd+E` | Read mode (preview only) |
| `Cmd+B` | Toggle file sidebar |
| `Cmd+F` | Search in file |
| `Cmd+H` | Search & replace |
| `Cmd+Shift+P` | Command palette |
| `Cmd+Shift+F` | File search |
| `Cmd+Opt+F` | Content search (search inside all files) |
| `Cmd+Shift+C` | Copy formatted HTML |
| `Cmd+Shift+Z` | Zen mode |
| `Cmd+=` / `Cmd+-` | Zoom in / out |

## Development

For contributors — requires Node.js 18+, Rust, and [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev
```

### PDF Export (optional)

Requires [Pandoc](https://pandoc.org/) and a LaTeX distribution:

```bash
brew install pandoc
brew install --cask mactex-no-gui
```

## Documentation

| Doc | Description |
|-----|-------------|
| [00-architecture-overview](docs/00-architecture-overview.md) | System shape, tech stack, entry points |
| [01-editor-engine](docs/01-editor-engine.md) | CodeMirror setup, keybindings |
| [02-preview-pipeline](docs/02-preview-pipeline.md) | markdown-it → KaTeX → Mermaid |
| [03-file-operations](docs/03-file-operations.md) | Rust commands, file I/O |
| [04-pdf-export](docs/04-pdf-export.md) | Pandoc + mermaid.ink pipeline |
| [05-ui-layout](docs/05-ui-layout.md) | UI components, theme, view modes |
| [06-auto-update](docs/06-auto-update.md) | In-app auto-update system |
| [07-release-pipeline](docs/07-release-pipeline.md) | CI/CD, signing, release process |

## License

[GPL-3.0](LICENSE)
