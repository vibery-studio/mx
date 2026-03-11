# mx

A fast, lightweight markdown editor for the AI era. Built with Tauri 2 + Rust.

## Download

| Platform | Link |
|----------|------|
| macOS | [mx.dmg](https://github.com/vibery-studio/mx/releases/latest) |
| Windows | [mx.exe](https://github.com/vibery-studio/mx/releases/latest) |
| Linux | [mx.deb / .AppImage](https://github.com/vibery-studio/mx/releases/latest) |

> All downloads on the [Releases](https://github.com/vibery-studio/mx/releases) page.

## Why mx?

MacDown stopped getting updates and never supported Mermaid diagrams. Meanwhile, working with AI means opening dozens of markdown files every day — but you shouldn't need to "create a vault" just to read a `.md` file. mx is a simple editor that opens any markdown file instantly with live preview, Mermaid, KaTeX, and word counting. No vault. No config. Just open and go.

## Features

- **Live split preview** — markdown-it with syntax highlighting
- **Mermaid diagrams** — rendered inline, dark theme
- **KaTeX math** — inline `$...$` and display `$$...$$`
- **Word & character count** — real-time in status bar
- **File sidebar** — browse directories with emoji icons
- **Drag & drop** — drop any `.md` file to open
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
