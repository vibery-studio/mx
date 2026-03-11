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
let zoomLevel = 100; // percentage
const MAX_RECENT = 10;

// --- Recent files ---

function getRecentFiles(): string[] {
  try { return JSON.parse(localStorage.getItem("mx-recent-files") || "[]"); }
  catch { return []; }
}

function addRecentFile(path: string) {
  let recent = getRecentFiles().filter(p => p !== path);
  recent.unshift(path);
  if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
  localStorage.setItem("mx-recent-files", JSON.stringify(recent));
  renderRecentFiles();
}

function renderRecentFiles() {
  const list = document.getElementById("recent-list");
  if (!list) return;
  const recent = getRecentFiles();
  if (recent.length === 0) {
    list.innerHTML = '<div class="recent-empty">No recent files</div>';
    return;
  }
  list.innerHTML = recent.map(p => {
    const name = p.split("/").pop()!;
    const dir = p.split("/").slice(0, -1).join("/");
    return `<div class="recent-item" data-path="${p.replace(/"/g, "&quot;")}"><span class="recent-name">${name}</span><span class="recent-path">${dir}</span></div>`;
  }).join("");
  list.querySelectorAll(".recent-item").forEach(el => {
    el.addEventListener("click", () => {
      openFile((el as HTMLElement).dataset.path!);
      toggleRecentPanel();
    });
  });
}

function toggleRecentPanel() {
  const panel = document.getElementById("recent-panel");
  if (!panel) return;
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) renderRecentFiles();
}

// --- Zoom ---

function applyZoom() {
  const previewPane = $("#preview-pane");
  const editorPane = $("#editor-pane");
  if (previewPane) previewPane.style.fontSize = `${zoomLevel}%`;
  if (editorPane) editorPane.style.fontSize = `${zoomLevel}%`;
  const el = document.getElementById("status-zoom");
  if (el) el.textContent = `${zoomLevel}%`;
}

function zoomIn() { zoomLevel = Math.min(200, zoomLevel + 10); applyZoom(); }
function zoomOut() { zoomLevel = Math.max(50, zoomLevel - 10); applyZoom(); }
function zoomReset() { zoomLevel = 100; applyZoom(); }

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

function parseYamlFrontmatter(yaml: string): { key: string; value: string }[] {
  const lines = yaml.split("\n");
  const entries: { key: string; value: string }[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^(\w[\w\s-]*):\s*(.*)/);
    if (match) {
      const key = match[1].trim();
      let val = match[2].trim();
      // Check for block scalar (> or |) or empty value with indented continuation
      if (val === ">" || val === "|" || val === ">-" || val === "|-") {
        val = "";
        i++;
        while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
          val += (val ? " " : "") + lines[i].trim();
          i++;
        }
        val = val.trim();
      } else if (val === "") {
        // Could be a list or nested block
        i++;
        const listItems: string[] = [];
        while (i < lines.length && (lines[i].startsWith("  ") || lines[i].startsWith("\t"))) {
          const item = lines[i].trim();
          if (item.startsWith("- ")) listItems.push(item.slice(2));
          else listItems.push(item);
          i++;
        }
        val = listItems.join(", ");
      } else {
        // Strip quotes
        val = val.replace(/^["']|["']$/g, "");
        i++;
      }
      entries.push({ key, value: val });
    } else {
      i++;
    }
  }
  return entries;
}

function renderFrontmatter(yaml: string): string {
  const entries = parseYamlFrontmatter(yaml);
  if (entries.length === 0) return "";
  const rows = entries.map(({ key, value }) => {
    const displayVal = value.length > 200 ? value.slice(0, 200) + "..." : value;
    return `<div class="fm-row"><span class="fm-key">${escapeHtml(key)}</span><span class="fm-val">${escapeHtml(displayVal)}</span></div>`;
  }).join("");
  return `<div class="frontmatter">${rows}</div>`;
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
    addRecentFile(result.path);
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
  await appWindow.onDragDropEvent(async (event) => {
    if (event.payload.type === "drop") {
      const paths = event.payload.paths;
      const textExts = [".md", ".markdown", ".txt", ".yaml", ".yml", ".json", ".toml", ".xml", ".csv", ".log"];

      // Check first path — could be a folder
      const first = paths[0];
      if (first) {
        try {
          // Try listing as directory — if it works, it's a folder
          await invoke<unknown[]>("list_directory", { path: first });
          // It's a folder — open in sidebar
          openFolder(first);
          return;
        } catch { /* not a directory, continue */ }
      }

      const textFile = paths.find((p: string) => textExts.some(ext => p.endsWith(ext)));
      if (textFile) openFile(textFile);
    }
  });
}

// --- Editor fill container theme ---

const editorFillTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
});

// --- Sample content ---

const SAMPLE_CONTENT = `# About mx

**mx** is a fast, lightweight markdown editor built for the AI era. Open any \`.md\` file instantly with live preview — no vault, no config, just open and go.

If you're coming from MacDown (abandoned since 2020), mx picks up where it left off with modern features and native Apple Silicon performance.

## Features

- **Live split preview** with resizable pane
- **Mermaid diagrams** rendered inline
- **KaTeX math** — inline \`$...$\` and display \`$$...$$\`
- **YAML frontmatter** rendered as metadata table
- **Copy formatted** — paste rich HTML into Substack, WordPress, Notion
- **PDF export** via Pandoc with Mermaid support
- **File sidebar** — browse directories
- **Drag & drop** any .md, .yaml, .json, .txt file

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| \`Cmd+O\` | Open file |
| \`Cmd+S\` | Save file |
| \`Cmd+P\` | Toggle preview |
| \`Cmd+E\` | Read mode (preview only) |
| \`Cmd+B\` | Toggle file sidebar |
| \`Cmd+Shift+C\` | Copy formatted HTML |

## Mermaid Diagrams

\`\`\`mermaid
graph TD
    A[Open .md file] --> B[CodeMirror Editor]
    B --> C{Content Changed}
    C -->|debounce| D[markdown-it]
    D --> E[KaTeX + Mermaid]
    E --> F[Live Preview]
\`\`\`

## Math Support

Inline: $E = mc^2$ and $\\sum_{i=1}^{n} x_i$

Display:

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$

## YAML Frontmatter

Files with YAML frontmatter (\`---\` blocks) are rendered as a styled metadata table in the preview pane.

---

**GitHub:** https://github.com/vibery-studio/mx
Report bugs and request features at https://github.com/vibery-studio/mx/issues

> **Drop a .md file to get started, or just start typing!**
`;

// --- Copy formatted HTML ---

async function copyFormattedHTML() {
  const previewPane = $("#preview-pane");
  if (!previewPane) return;

  // Get the rendered HTML from preview pane
  const html = previewPane.innerHTML;
  // Also get plain text fallback
  const text = previewPane.innerText;

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);

    // Flash status feedback
    const statusWords = document.getElementById("status-words");
    const prevText = statusWords?.textContent || "";
    if (statusWords) {
      statusWords.textContent = "Copied!";
      statusWords.style.color = "#a6e3a1";
      setTimeout(() => {
        statusWords.textContent = prevText;
        statusWords.style.color = "";
      }, 2000);
    }
  } catch (e) {
    console.error("Copy failed:", e);
  }
}

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

// Track expanded directories
const expandedDirs = new Set<string>();

async function loadDirectory(path: string) {
  try {
    const entries = await invoke<DirEntry[]>("list_directory", { path });
    const tree = document.getElementById("sidebar-tree");
    if (!tree) return;
    tree.innerHTML = "";
    await renderTreeEntries(entries, tree, 0);
  } catch (e) {
    console.error("Failed to load directory:", e);
  }
}

async function renderTreeEntries(entries: DirEntry[], container: HTMLElement, depth: number) {
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = `tree-item${entry.is_dir ? " directory" : ""}`;
    if (entry.path === currentFilePath) item.classList.add("active");

    const indent = '<span class="tree-indent"></span>'.repeat(depth);
    const chevron = entry.is_dir
      ? `<span class="tree-chevron${expandedDirs.has(entry.path) ? " expanded" : ""}">▶</span>`
      : '<span class="tree-chevron-placeholder"></span>';

    item.innerHTML = `${indent}${chevron}<span class="icon">${getFileIcon(entry)}</span><span class="name">${entry.name}</span>`;

    if (entry.is_dir) {
      const childContainer = document.createElement("div");
      childContainer.className = "tree-children";
      childContainer.dataset.path = entry.path;
      if (!expandedDirs.has(entry.path)) childContainer.classList.add("hidden");

      item.addEventListener("click", async () => {
        const isExpanded = expandedDirs.has(entry.path);
        if (isExpanded) {
          expandedDirs.delete(entry.path);
          childContainer.classList.add("hidden");
          item.querySelector(".tree-chevron")?.classList.remove("expanded");
        } else {
          expandedDirs.add(entry.path);
          childContainer.classList.remove("hidden");
          item.querySelector(".tree-chevron")?.classList.add("expanded");
          // Load children if empty
          if (childContainer.children.length === 0) {
            try {
              const children = await invoke<DirEntry[]>("list_directory", { path: entry.path });
              await renderTreeEntries(children, childContainer, depth + 1);
            } catch { /* ignore */ }
          }
        }
      });

      container.appendChild(item);
      container.appendChild(childContainer);

      // If already expanded, load children
      if (expandedDirs.has(entry.path) && childContainer.children.length === 0) {
        try {
          const children = await invoke<DirEntry[]>("list_directory", { path: entry.path });
          await renderTreeEntries(children, childContainer, depth + 1);
        } catch { /* ignore */ }
      }
    } else {
      item.addEventListener("click", () => {
        openFile(entry.path);
        document.querySelectorAll("#sidebar-tree .tree-item").forEach(el => el.classList.remove("active"));
        item.classList.add("active");
      });
      container.appendChild(item);
    }
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

async function openFolder(folderPath?: string) {
  let path = folderPath;
  if (!path) {
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    path = selected as string;
  }
  expandedDirs.clear();
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
          { key: "Mod-Shift-c", run: () => { copyFormattedHTML(); return true; } },
          { key: "Mod-=", run: () => { zoomIn(); return true; } },
          { key: "Mod--", run: () => { zoomOut(); return true; } },
          { key: "Mod-0", run: () => { zoomReset(); return true; } },
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
  document.getElementById("btn-copy-html")?.addEventListener("click", copyFormattedHTML);
  document.getElementById("btn-export-pdf")?.addEventListener("click", exportPDF);
  document.getElementById("btn-toggle-sidebar")?.addEventListener("click", toggleSidebar);
  document.getElementById("btn-open-folder")?.addEventListener("click", () => openFolder());
  document.getElementById("btn-recent")?.addEventListener("click", toggleRecentPanel);
  document.getElementById("btn-zoom-in")?.addEventListener("click", zoomIn);
  document.getElementById("btn-zoom-out")?.addEventListener("click", zoomOut);

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

  // GitHub link — open in system browser
  document.getElementById("status-github")?.addEventListener("click", (e) => {
    e.preventDefault();
    invoke("plugin:opener|open_url", { url: "https://github.com/vibery-studio/mx" });
  });

  // Initial render
  updateCursorPosition(editor);
  updatePreview(SAMPLE_CONTENT);
  updateWordCount(SAMPLE_CONTENT);
});
