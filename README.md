# mx

A fast, lightweight markdown editor for the AI era. Built with Tauri 2 + Rust.

**Coming from [MacDown](https://macdown.uranusjr.com/)?** MacDown has been abandoned since 2020 — no Mermaid support, no Apple Silicon build, no updates. mx picks up where MacDown left off: same simplicity, but with modern features like Mermaid diagrams, KaTeX math, YAML frontmatter, and a fraction of the bundle size.

## Download

| Platform | Link |
|----------|------|
| macOS | [mx.dmg](https://github.com/vibery-studio/mx/releases/latest) |
| Windows | [mx.exe](https://github.com/vibery-studio/mx/releases/latest) |
| Linux | [mx.deb / .AppImage](https://github.com/vibery-studio/mx/releases/latest) |

> All downloads on the [Releases](https://github.com/vibery-studio/mx/releases) page.

## Why mx?

Working with AI means opening dozens of markdown files every day. You need a fast editor that just works — not a vault-based system like Obsidian, not an abandoned app like MacDown. mx opens any `.md` file instantly with live preview. No vault. No config. Just open and go.

### mx vs MacDown

| | mx | MacDown |
|--|-----|---------|
| Status | Active | Abandoned (2020) |
| Mermaid diagrams | Yes | No |
| KaTeX math | Yes | MathJax (slow) |
| YAML frontmatter | Rendered | Raw text |
| Apple Silicon | Native | Rosetta only |
| Bundle size | ~8 MB | ~30 MB |
| PDF export | Pandoc + Mermaid | Broken |
| File associations | .md, .yaml, .json, .txt | .md only |
| Cross-platform | macOS, Windows, Linux | macOS only |

## Features

- **Live split preview** — markdown-it with syntax highlighting
- **Mermaid diagrams** — rendered inline, dark theme
- **KaTeX math** — inline `$...$` and display `$$...$$`
- **YAML frontmatter** — rendered as styled metadata table
- **Word & character count** — real-time in status bar
- **File sidebar** — browse directories with emoji icons
- **Drag & drop** — drop any .md, .yaml, .json, .txt file to open
- **PDF export** — via Pandoc with Mermaid diagram support
- **Resizable split** — drag divider between editor and preview
- **Keyboard-first** — `Cmd+O` open, `Cmd+S` save, `Cmd+P` preview, `Cmd+E` read mode

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

## License

[GPL-3.0](LICENSE)
