import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, ViewUpdate } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";
import { closeBrackets } from "@codemirror/autocomplete";
import MarkdownIt from "markdown-it";
import mermaid from "mermaid";
import katex from "katex";
import "katex/dist/katex.min.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";

// --- State ---

let currentFilePath: string | null = null;
let editor: EditorView;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// --- DOM refs ---

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

// --- Markdown-it with KaTeX ---

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

function renderKaTeX(html: string): string {
  // Block math: $$...$$
  html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_match, tex: string) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false });
    } catch { return `<pre class="katex-error">${tex}</pre>`; }
  });
  // Inline math: $...$  (not preceded/followed by $)
  html = html.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_match, tex: string) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false });
    } catch { return `<code class="katex-error">${tex}</code>`; }
  });
  return html;
}

// --- Mermaid ---

mermaid.initialize({ startOnLoad: false, theme: "dark" });

let mermaidCounter = 0;

function processMermaidBlocks(html: string): string {
  return html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_match, code: string) => {
      const id = `mermaid-${++mermaidCounter}`;
      const decoded = code.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
      return `<div class="mermaid" id="${id}">${decoded}</div>`;
    }
  );
}

async function renderMermaidDivs() {
  const divs = document.querySelectorAll("#preview-pane .mermaid");
  if (divs.length === 0) return;
  try {
    await mermaid.run({ nodes: divs as unknown as ArrayLike<HTMLElement> });
  } catch { /* mermaid render errors are non-fatal */ }
}

// --- YAML Frontmatter ---

function extractFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { frontmatter: null, body: content };
  return { frontmatter: match[1], body: content.slice(match[0].length) };
}

function renderFrontmatter(yaml: string): string {
  const rows = yaml.split("\n").filter(l => l.trim()).map(line => {
    const idx = line.indexOf(":");
    if (idx === -1) return `<tr><td colspan="2">${escapeHtml(line)}</td></tr>`;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    return `<tr><td class="fm-key">${escapeHtml(key)}</td><td>${escapeHtml(val)}</td></tr>`;
  }).join("");
  return `<div class="frontmatter"><table>${rows}</table></div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Preview rendering ---

async function updatePreview(content: string) {
  const previewPane = $("#preview-pane");
  if (!previewPane || previewPane.style.display === "none") return;

  const { frontmatter, body } = extractFrontmatter(content);
  let html = "";
  if (frontmatter) html += renderFrontmatter(frontmatter);
  html += md.render(body);
  html = renderKaTeX(html);
  html = processMermaidBlocks(html);
  previewPane.innerHTML = html;
  await renderMermaidDivs();
}

// --- Word counting ---

async function updateWordCount(content: string) {
  try {
    const result = await invoke<{
      chars: number;
      words: number;
      lines: number;
    }>("word_count", { text: content });

    const el = (id: string) => document.getElementById(id);
    if (el("status-words")) el("status-words")!.textContent = `${result.words} words`;
    if (el("status-tokens")) el("status-tokens")!.textContent = `${result.chars} chars`;
    if (el("token-count")) el("token-count")!.textContent = `${result.words} words`;
    if (el("cost-estimate")) el("cost-estimate")!.textContent = `${result.lines} lines`;
  } catch { /* backend not ready yet */ }
}

// --- Cursor position ---

function updateCursorPosition(view: EditorView) {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const col = pos - line.from + 1;
  const el = document.getElementById("status-position");
  if (el) el.textContent = `Ln ${line.number}, Col ${col}`;
}

// --- Modified state ---

function setModified(value: boolean) {
  const indicator = document.getElementById("modified-indicator");
  if (indicator) indicator.classList.toggle("hidden", !value);
}

// --- File operations ---

function setFilename(path: string | null) {
  currentFilePath = path;
  const el = document.getElementById("filename");
  if (el) el.textContent = path ? path.split("/").pop()! : "No file open";
}

async function saveFile() {
  const content = editor.state.doc.toString();
  if (!currentFilePath) {
    // No file path — show Save As dialog
    const path = await save({
      filters: [{ name: "Markdown", extensions: ["md"] }],
      defaultPath: "untitled.md",
    });
    if (!path) return;
    try {
      await invoke("save_file", { path, content });
      setFilename(path);
      setModified(false);
    } catch (e) {
      console.error("Save failed:", e);
    }
    return;
  }
  try {
    await invoke("save_file", { path: currentFilePath, content });
    setModified(false);
  } catch (e) {
    console.error("Save failed:", e);
  }
}

async function openFileDialog() {
  const path = await open({
    filters: [
      { name: "Markdown", extensions: ["md", "markdown"] },
      { name: "Text", extensions: ["txt", "yaml", "yml", "json", "toml", "xml", "csv", "log"] },
      { name: "All Files", extensions: ["*"] },
    ],
    multiple: false,
  });
  if (path) openFile(path as string);
}

async function openFile(path: string) {
  try {
    const result = await invoke<{ path: string; content: string }>("read_file", { path });
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: result.content },
    });
    setFilename(result.path);
    setModified(false);
  } catch (e) {
    console.error("Open failed:", e);
  }
}

// --- Debounced content change handler ---

function onContentChange(view: EditorView) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const content = view.state.doc.toString();
    updatePreview(content);
    updateWordCount(content);
  }, 300);
  updateCursorPosition(view);
  setModified(true);
}

// --- Divider drag to resize ---

function initDividerDrag() {
  const divider = $("#divider");
  const editorPane = $("#editor-pane");
  const previewPane = $("#preview-pane");
  const container = $("#editor-container");
  if (!divider || !editorPane || !previewPane || !container) return;

  let dragging = false;

  divider.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const offset = e.clientX - rect.left;
    const total = rect.width;
    const pct = Math.max(20, Math.min(80, (offset / total) * 100));
    editorPane.style.flexBasis = `${pct}%`;
    previewPane.style.flexBasis = `${100 - pct}%`;
  });

  window.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  });
}

// --- View modes: "split" | "editor" | "preview" ---

type ViewMode = "split" | "editor" | "preview";
let currentViewMode: ViewMode = "split";

function setViewMode(mode: ViewMode) {
  const previewPane = $("#preview-pane");
  const divider = $("#divider");
  const editorPane = $("#editor-pane");
  if (!previewPane || !divider || !editorPane) return;

  currentViewMode = mode;

  if (mode === "split") {
    editorPane.style.display = "";
    editorPane.style.flexBasis = "";
    divider.style.display = "";
    previewPane.style.display = "";
    previewPane.style.flexBasis = "";
    updatePreview(editor.state.doc.toString());
  } else if (mode === "editor") {
    editorPane.style.display = "";
    editorPane.style.flexBasis = "100%";
    divider.style.display = "none";
    previewPane.style.display = "none";
  } else if (mode === "preview") {
    editorPane.style.display = "none";
    divider.style.display = "none";
    previewPane.style.display = "";
    previewPane.style.flexBasis = "100%";
    updatePreview(editor.state.doc.toString());
  }
}

function togglePreview() {
  // Cycle: split → editor → split
  setViewMode(currentViewMode === "split" ? "editor" : "split");
}

function toggleReadMode() {
  // Cycle: current → preview → split
  setViewMode(currentViewMode === "preview" ? "split" : "preview");
}

// --- Drag & drop via Tauri ---

async function initDragDrop() {
  const appWindow = getCurrentWindow();
  await appWindow.onDragDropEvent((event) => {
    if (event.payload.type === "drop") {
      const paths = event.payload.paths;
      const textExts = [".md", ".markdown", ".txt", ".yaml", ".yml", ".json", ".toml", ".xml", ".csv", ".log"];
      const mdFile = paths.find((p: string) => textExts.some(ext => p.endsWith(ext)));
      if (mdFile) openFile(mdFile);
    }
  });
}

// --- Editor fill container theme ---

const editorFillTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
});

// --- Sample content ---

const SAMPLE_CONTENT = `# mx — AI-Native Markdown Editor

A fast, lightweight editor for the age of AI. Open any \`.md\` file, see live preview with **Mermaid diagrams**, **LaTeX math**, and **token counting**.

## Features

- **Live preview** with split pane
- **Mermaid diagrams** rendered inline
- **KaTeX math** for equations
- **Token counter** with cost estimates
- **Drag & drop** any .md file

## Architecture

\`\`\`mermaid
graph TD
    A[User opens .md file] --> B[CodeMirror Editor]
    B --> C{Content Changed}
    C -->|debounce 300ms| D[markdown-it Parser]
    D --> E[KaTeX Math Rendering]
    E --> F[Mermaid Diagram Rendering]
    F --> G[Live Preview Pane]
    C -->|invoke| H[Rust Backend]
    H --> I[Token Counter]
    I --> J[Status Bar Update]
\`\`\`

## User Flow

\`\`\`mermaid
sequenceDiagram
    participant U as User
    participant E as Editor
    participant R as Rust Backend
    participant P as Preview

    U->>E: Type markdown
    E->>R: count_tokens(text)
    R-->>E: {tokens, cost}
    E->>P: Render HTML + Mermaid + KaTeX
    U->>E: Cmd+S
    E->>R: save_file(path, content)
    R-->>E: Ok
    U->>E: Drop .md file
    E->>R: read_file(path)
    R-->>E: {content}
    E->>P: Update preview
\`\`\`

## Math Support

Inline math: $E = mc^2$ and $\\sum_{i=1}^{n} x_i = x_1 + x_2 + \\cdots + x_n$

Display math:

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$

$$
f(x) = \\frac{1}{\\sigma\\sqrt{2\\pi}} e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}}
$$

## Code Blocks

\`\`\`typescript
async function countTokens(text: string): Promise<TokenCount> {
  return await invoke("count_tokens", { text });
}
\`\`\`

\`\`\`rust
#[tauri::command]
fn count_tokens(text: String) -> TokenCount {
    let estimated_tokens = text.len() / 4;
    TokenCount { chars: text.len(), estimated_tokens }
}
\`\`\`

## State Diagram

\`\`\`mermaid
stateDiagram-v2
    [*] --> Empty: App Launch
    Empty --> Editing: Open/Drop File
    Editing --> Modified: Type
    Modified --> Saved: Cmd+S
    Saved --> Modified: Type
    Modified --> Editing: Undo All
    Editing --> Empty: Close File
\`\`\`

## Why mx?

| Feature | mx | MacDown | Typora | Obsidian |
|---------|-----|---------|--------|----------|
| Startup | <200ms | ~1s | ~2s | ~3s |
| Bundle size | ~8MB | ~30MB | ~80MB | ~200MB |
| Mermaid | Yes | Broken | Yes | Yes |
| Token count | **Yes** | No | No | No |
| Cost estimate | **Yes** | No | No | No |
| AI-native | **Yes** | No | No | Partial |

> **Drop a .md file to get started, or just start typing!**
`;

// --- Export to PDF ---

async function exportPDF() {
  const content = editor.state.doc.toString();

  // Ask where to save
  const defaultName = currentFilePath
    ? currentFilePath.replace(/\.md$/, ".pdf").split("/").pop()!
    : "export.pdf";
  const outputPath = await save({
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    defaultPath: defaultName,
  });
  if (!outputPath) return;

  // Show working state
  const statusWords = document.getElementById("status-words");
  const prevText = statusWords?.textContent || "";
  if (statusWords) {
    statusWords.textContent = "Exporting PDF...";
    statusWords.style.color = "#89b4fa";
  }

  try {
    const result = await invoke<string>("export_pdf", {
      markdownContent: content,
      outputPath,
    });
    if (statusWords) {
      statusWords.textContent = `PDF saved: ${result.split("/").pop()}`;
      statusWords.style.color = "#a6e3a1";
      setTimeout(() => {
        statusWords.textContent = prevText;
        statusWords.style.color = "";
      }, 3000);
    }
  } catch (e) {
    console.error("Pandoc export failed:", e);
    if (statusWords) {
      statusWords.textContent = `PDF failed: ${e}`;
      statusWords.style.color = "#f38ba8";
      setTimeout(() => {
        statusWords.textContent = prevText;
        statusWords.style.color = "";
      }, 5000);
    }
  }
}

// --- Sidebar / File tree ---

let currentFolderPath: string | null = null;

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  extension: string | null;
}

function getFileIcon(entry: DirEntry): string {
  if (entry.is_dir) return "📁";
  const ext = entry.extension;
  if (ext === "md") return "📝";
  if (ext === "json") return "{}";
  if (ext === "ts" || ext === "js") return "⚡";
  if (ext === "rs") return "🦀";
  if (ext === "toml" || ext === "yaml" || ext === "yml") return "⚙";
  if (ext === "css" || ext === "scss") return "🎨";
  if (ext === "html") return "🌐";
  if (ext === "png" || ext === "jpg" || ext === "svg") return "🖼";
  return "📄";
}

async function loadDirectory(path: string) {
  try {
    const entries = await invoke<DirEntry[]>("list_directory", { path });
    const tree = document.getElementById("sidebar-tree");
    if (!tree) return;
    tree.innerHTML = "";

    // Add parent directory entry if not root
    if (path !== "/") {
      const parentItem = document.createElement("div");
      parentItem.className = "tree-item directory";
      parentItem.innerHTML = `<span class="icon">📁</span><span class="name">..</span>`;
      const parentPath = path.split("/").slice(0, -1).join("/") || "/";
      parentItem.addEventListener("click", () => {
        currentFolderPath = parentPath;
        loadDirectory(parentPath);
        updateSidebarTitle(parentPath);
      });
      tree.appendChild(parentItem);
    }

    for (const entry of entries) {
      const item = document.createElement("div");
      item.className = `tree-item${entry.is_dir ? " directory" : ""}`;
      if (entry.path === currentFilePath) item.classList.add("active");
      item.innerHTML = `<span class="icon">${getFileIcon(entry)}</span><span class="name">${entry.name}</span>`;

      if (entry.is_dir) {
        item.addEventListener("click", () => {
          currentFolderPath = entry.path;
          loadDirectory(entry.path);
          updateSidebarTitle(entry.path);
        });
      } else {
        item.addEventListener("click", () => {
          openFile(entry.path);
          // highlight active
          tree.querySelectorAll(".tree-item").forEach(el => el.classList.remove("active"));
          item.classList.add("active");
        });
      }
      tree.appendChild(item);
    }
  } catch (e) {
    console.error("Failed to load directory:", e);
  }
}

function updateSidebarTitle(path: string) {
  const title = document.getElementById("sidebar-title");
  if (title) title.textContent = path.split("/").pop() || "Files";
}

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.classList.toggle("hidden");
}

async function openFolder() {
  // Use a simple approach - open the home directory or current dir
  // In a real app, we'd use a native folder picker dialog
  const path = currentFolderPath || "/Users";
  currentFolderPath = path;
  const sidebar = document.getElementById("sidebar");
  if (sidebar?.classList.contains("hidden")) {
    sidebar.classList.remove("hidden");
  }
  loadDirectory(path);
  updateSidebarTitle(path);
}

// --- Init ---

window.addEventListener("DOMContentLoaded", () => {
  const editorPane = $("#editor-pane");
  if (!editorPane) return;

  editor = new EditorView({
    state: EditorState.create({
      doc: SAMPLE_CONTENT,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        closeBrackets(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        oneDark,
        editorFillTheme,
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
          { key: "Mod-o", run: () => { openFileDialog(); return true; } },
          { key: "Mod-s", run: () => { saveFile(); return true; } },
          { key: "Mod-p", run: () => { togglePreview(); return true; } },
          { key: "Mod-b", run: () => { toggleSidebar(); return true; } },
          { key: "Mod-e", run: () => { toggleReadMode(); return true; } },
        ]),
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.docChanged || update.selectionSet) {
            if (update.docChanged) onContentChange(update.view);
            else updateCursorPosition(update.view);
          }
        }),
      ],
    }),
    parent: editorPane,
  });

  // Toolbar buttons
  document.getElementById("btn-open")?.addEventListener("click", openFileDialog);
  document.getElementById("btn-save")?.addEventListener("click", saveFile);
  document.getElementById("btn-toggle-preview")?.addEventListener("click", togglePreview);

  // Sidebar buttons
  document.getElementById("btn-read-mode")?.addEventListener("click", toggleReadMode);
  document.getElementById("btn-export-pdf")?.addEventListener("click", exportPDF);
  document.getElementById("btn-toggle-sidebar")?.addEventListener("click", toggleSidebar);
  document.getElementById("btn-open-folder")?.addEventListener("click", openFolder);

  // Divider drag
  initDividerDrag();

  // Tauri drag & drop
  initDragDrop();

  // Listen for file open events (double-click .md in Finder, warm start)
  listen<string>("open-file", (event) => {
    openFile(event.payload);
  });

  // Check for file passed on cold start
  invoke<string | null>("get_initial_file").then((path) => {
    if (path) openFile(path);
  });

  // Initial render
  updateCursorPosition(editor);
  updatePreview(SAMPLE_CONTENT);
  updateWordCount(SAMPLE_CONTENT);
});
