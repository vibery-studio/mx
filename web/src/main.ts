import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, ViewUpdate } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, foldKeymap } from "@codemirror/language";
import { closeBrackets } from "@codemirror/autocomplete";
import { search, searchKeymap } from "@codemirror/search";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import mermaid from "mermaid";
import katex from "katex";
import "katex/dist/katex.min.css";

// --- State ---

let editor: EditorView;
let currentFileName: string | null = null;
let currentFileHandle: FileSystemFileHandle | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let zoomLevel = 100;
const MAX_RECENT = 10;

// --- Font selection ---

const FONT_OPTIONS = ["System", "Inter", "Georgia", "Merriweather", "JetBrains Mono"] as const;
let currentFont: string = localStorage.getItem("mx-font") || "System";

function cycleFont() {
  const idx = FONT_OPTIONS.indexOf(currentFont as typeof FONT_OPTIONS[number]);
  currentFont = FONT_OPTIONS[(idx + 1) % FONT_OPTIONS.length];
  localStorage.setItem("mx-font", currentFont);
  applyFont();
}

function applyFont() {
  const previewPane = $("#preview-pane");
  if (previewPane) {
    if (currentFont === "System") previewPane.style.removeProperty("--font-reading");
    else previewPane.style.setProperty("--font-reading", `"${currentFont}", var(--font-ui)`);
  }
  const label = document.getElementById("font-label");
  if (label) label.textContent = currentFont;
}

// --- Line numbers toggle ---

let showLineNumbers = localStorage.getItem("mx-line-numbers") !== "false";
const lineNumbersCompartment = new Compartment();

function toggleLineNumbers() {
  showLineNumbers = !showLineNumbers;
  localStorage.setItem("mx-line-numbers", String(showLineNumbers));
  editor.dispatch({
    effects: lineNumbersCompartment.reconfigure(showLineNumbers ? lineNumbers() : []),
  });
  const label = document.getElementById("linenumbers-label");
  if (label) label.textContent = showLineNumbers ? "On" : "Off";
}

// --- Zen mode ---

let zenMode = false;
function toggleZenMode() {
  zenMode = !zenMode;
  document.getElementById("app")?.classList.toggle("zen-mode", zenMode);
}

// --- Recent files (name-only, no paths in browser) ---

interface RecentEntry { name: string; content: string; ts: number }

function getRecentFiles(): RecentEntry[] {
  try { return JSON.parse(localStorage.getItem("mx-web-recent") || "[]"); }
  catch { return []; }
}

function addRecentFile(name: string, content: string) {
  let recent = getRecentFiles().filter(r => r.name !== name);
  recent.unshift({ name, content: content.slice(0, 50000), ts: Date.now() });
  if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
  localStorage.setItem("mx-web-recent", JSON.stringify(recent));
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
  list.innerHTML = recent.map((r, i) => {
    const preview = r.content.slice(0, 80).replace(/\n/g, " ");
    return `<div class="recent-item" data-idx="${i}"><span class="recent-name">${escapeHtml(r.name)}</span><span class="recent-path">${escapeHtml(preview)}…</span></div>`;
  }).join("");
  list.querySelectorAll(".recent-item").forEach(el => {
    el.addEventListener("click", () => {
      const idx = parseInt((el as HTMLElement).dataset.idx!);
      const entry = recent[idx];
      if (entry) {
        loadContent(entry.name, entry.content);
        toggleRecentPanel();
      }
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

// --- Theme ---

type ThemeMode = "auto" | "light" | "dark";
let currentThemeMode: ThemeMode = (localStorage.getItem("mx-theme") as ThemeMode) || "auto";
const themeCompartment = new Compartment();

function getEffectiveTheme(): "light" | "dark" {
  if (currentThemeMode === "auto") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return currentThemeMode;
}

function applyTheme() {
  document.documentElement.setAttribute("data-theme", currentThemeMode);
  localStorage.setItem("mx-theme", currentThemeMode);

  if (editor) {
    const isDark = getEffectiveTheme() === "dark";
    editor.dispatch({
      effects: themeCompartment.reconfigure(isDark ? oneDark : editorLightTheme),
    });
  }

  mermaid.initialize({ startOnLoad: false, theme: getEffectiveTheme() === "dark" ? "dark" : "default" });

  if (editor) {
    mermaidCounter = 0;
    updatePreview(editor.state.doc.toString());
  }

  const label = document.getElementById("btn-theme-label");
  if (label) {
    const labels: Record<ThemeMode, string> = { auto: "System", light: "Light", dark: "Dark" };
    label.textContent = `Theme: ${labels[currentThemeMode]}`;
  }
}

function cycleTheme() {
  const order: ThemeMode[] = ["auto", "light", "dark"];
  const idx = order.indexOf(currentThemeMode);
  currentThemeMode = order[(idx + 1) % order.length];
  applyTheme();
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (currentThemeMode === "auto") applyTheme();
});

// --- DOM refs ---

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

// --- Markdown-it with KaTeX ---

const md = new MarkdownIt({ html: true, linkify: true, typographer: true, breaks: true }).use(footnote);

// Wikilinks inline rule
md.inline.ruler.push("wikilink", (state, silent) => {
  if (state.src.charAt(state.pos) !== "[" || state.src.charAt(state.pos + 1) !== "[") return false;
  const start = state.pos + 2;
  const end = state.src.indexOf("]]", start);
  if (end === -1) return false;
  if (!silent) {
    const content = state.src.slice(start, end);
    const token = state.push("wikilink_open", "a", 1);
    token.attrSet("href", content.replace(/\s+/g, "-") + ".md");
    token.attrSet("class", "wikilink");
    const text = state.push("text", "", 0);
    text.content = content;
    state.push("wikilink_close", "a", -1);
  }
  state.pos = end + 2;
  return true;
});

function renderKaTeX(html: string): string {
  html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_match, tex: string) => {
    try { return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false }); }
    catch { return `<pre class="katex-error">${tex}</pre>`; }
  });
  html = html.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_match, tex: string) => {
    try { return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false }); }
    catch { return `<code class="katex-error">${tex}</code>`; }
  });
  return html;
}

// --- Mermaid ---

mermaid.initialize({ startOnLoad: false, theme: "default" });
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
  try { await mermaid.run({ nodes: divs as unknown as ArrayLike<HTMLElement> }); }
  catch { /* non-fatal */ }
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
      if (val === ">" || val === "|" || val === ">-" || val === "|-") {
        val = ""; i++;
        while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
          val += (val ? " " : "") + lines[i].trim(); i++;
        }
        val = val.trim();
      } else if (val === "") {
        i++;
        const listItems: string[] = [];
        while (i < lines.length && (lines[i].startsWith("  ") || lines[i].startsWith("\t"))) {
          const item = lines[i].trim();
          listItems.push(item.startsWith("- ") ? item.slice(2) : item); i++;
        }
        val = listItems.join(", ");
      } else {
        val = val.replace(/^["']|["']$/g, ""); i++;
      }
      entries.push({ key, value: val });
    } else { i++; }
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

  // Wire image lightbox clicks
  previewPane.querySelectorAll("img").forEach(img => {
    img.addEventListener("click", () => {
      const src = img.getAttribute("src");
      if (src) showImageLightbox(src);
    });
  });
}

// --- Word counting (browser-native) ---

function wordCount(text: string): { chars: number; words: number; lines: number } {
  const chars = text.length;
  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  const lines = text.split("\n").length;
  return { chars, words, lines };
}

function updateWordCount(content: string) {
  const result = wordCount(content);
  const el = (id: string) => document.getElementById(id);
  if (el("status-words")) el("status-words")!.textContent = `${result.words} words`;
  if (el("status-tokens")) el("status-tokens")!.textContent = `${result.chars} chars`;
  if (el("token-count")) el("token-count")!.textContent = `${result.words} words`;
  if (el("cost-estimate")) el("cost-estimate")!.textContent = `${result.lines} lines`;
}

// --- Cursor position ---

function updateCursorPosition(view: EditorView) {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const col = pos - line.from + 1;
  const el = document.getElementById("status-position");
  if (el) el.textContent = `Ln ${line.number}, Col ${col}`;
}

// --- Selection count ---

function updateSelectionCount(view: EditorView) {
  const sel = view.state.selection.main;
  const el = document.getElementById("status-selection");
  if (!el) return;
  if (sel.empty) { el.textContent = ""; return; }
  const text = view.state.sliceDoc(sel.from, sel.to);
  const words = text.split(/\s+/).filter(Boolean).length;
  el.textContent = `(${words} words, ${text.length} chars selected)`;
}

// --- Flash status ---

function flashStatus(text: string, color: string, duration = 2000) {
  const el = document.getElementById("status-words");
  if (!el) return;
  const prev = el.textContent || "";
  el.textContent = text;
  el.style.color = color;
  setTimeout(() => { el.textContent = prev; el.style.color = ""; }, duration);
}

// --- Modified state ---

function setModified(value: boolean) {
  const indicator = document.getElementById("modified-indicator");
  if (indicator) indicator.classList.toggle("hidden", !value);
}

// --- File operations (browser File API) ---

function setFilename(name: string | null) {
  currentFileName = name;
  const el = document.getElementById("filename");
  if (el) el.textContent = name || "Untitled";
}

function loadContent(name: string, content: string) {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: content },
  });
  setFilename(name);
  setModified(false);
}

async function openFileDialog() {
  if ("showOpenFilePicker" in window) {
    try {
      const [handle] = await (window as unknown as { showOpenFilePicker: (opts: unknown) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker({
        types: [
          { description: "Markdown", accept: { "text/markdown": [".md", ".markdown"] } },
          { description: "Text", accept: { "text/plain": [".txt", ".yaml", ".yml", ".json"] } },
        ],
        multiple: false,
      });
      const file = await handle.getFile();
      const content = await file.text();
      currentFileHandle = handle;
      loadContent(file.name, content);
      addRecentFile(file.name, content);
    } catch { /* user cancelled */ }
  } else {
    // Fallback: input element
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.txt,.yaml,.yml,.json,.toml,.xml,.csv";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const content = await file.text();
      currentFileHandle = null;
      loadContent(file.name, content);
      addRecentFile(file.name, content);
    };
    input.click();
  }
}

async function saveFile() {
  const content = editor.state.doc.toString();

  // Try to write back to existing handle
  if (currentFileHandle) {
    try {
      const writable = await (currentFileHandle as unknown as { createWritable: () => Promise<WritableStream & { write: (s: string) => Promise<void>; close: () => Promise<void> }> }).createWritable();
      await writable.write(content);
      await writable.close();
      setModified(false);
      return;
    } catch { /* fall through to save-as */ }
  }

  await saveFileAs();
}

async function saveFileAs() {
  const content = editor.state.doc.toString();
  const defaultName = currentFileName || "untitled.md";

  if ("showSaveFilePicker" in window) {
    try {
      const handle = await (window as unknown as { showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
        suggestedName: defaultName,
        types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
      });
      const writable = await (handle as unknown as { createWritable: () => Promise<WritableStream & { write: (s: string) => Promise<void>; close: () => Promise<void> }> }).createWritable();
      await writable.write(content);
      await writable.close();
      currentFileHandle = handle;
      setFilename(handle.name);
      setModified(false);
    } catch { /* user cancelled */ }
  } else {
    // Fallback: download
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultName;
    a.click();
    URL.revokeObjectURL(url);
    setModified(false);
  }
}

function newFile() {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: "" },
  });
  currentFileHandle = null;
  setFilename("Untitled");
  setModified(false);
}

// --- Copy modes ---

async function copyFormattedHTML() {
  const previewPane = $("#preview-pane");
  if (!previewPane) return;

  const html = previewPane.innerHTML;
  const text = previewPane.innerText;

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);
    flashStatus("Copied!", "var(--success)");
  } catch (e) {
    console.error("Copy failed:", e);
  }
}

async function copyRawMarkdown() {
  await navigator.clipboard.writeText(editor.state.doc.toString());
  flashStatus("Copied raw markdown!", "var(--success)");
}

async function copyPlainText() {
  const p = $("#preview-pane");
  if (p) await navigator.clipboard.writeText(p.innerText);
  flashStatus("Copied plain text!", "var(--success)");
}

// --- Export HTML ---

async function exportHTML() {
  const content = editor.state.doc.toString();
  const { frontmatter, body } = extractFrontmatter(content);
  let html = "";
  if (frontmatter) html += renderFrontmatter(frontmatter);
  html += md.render(body);
  html = renderKaTeX(html);

  const theme = getEffectiveTheme();
  const isDark = theme === "dark";
  const bg = isDark ? "#1e1e2e" : "#ffffff";
  const fg = isDark ? "#cdd6f4" : "#1e1e2e";
  const accent = isDark ? "#89b4fa" : "#1e66f5";

  const fullHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:${bg};color:${fg};max-width:800px;margin:0 auto;padding:2rem;line-height:1.6}
a{color:${accent}}pre{background:${isDark ? "#313244" : "#f5f5f5"};padding:1em;border-radius:6px;overflow-x:auto}
code{font-family:"SF Mono",Menlo,monospace;font-size:0.9em}img{max-width:100%}</style>
</head><body>${html}</body></html>`;

  const blob = new Blob([fullHtml], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (currentFileName || "export").replace(/\.md$/, "") + ".html";
  a.click();
  URL.revokeObjectURL(url);
  flashStatus("HTML exported!", "var(--success)");
}

// --- Image lightbox ---

function showImageLightbox(src: string) {
  const lb = document.getElementById("image-lightbox");
  if (!lb) return;
  lb.innerHTML = `<img src="${src.replace(/"/g, "&quot;")}" />`;
  lb.classList.remove("hidden");
  lb.addEventListener("click", () => { lb.classList.add("hidden"); lb.innerHTML = ""; }, { once: true });
}

// --- Image paste ---

function handleImagePaste(e: ClipboardEvent) {
  if (!e.clipboardData) return;
  const imageItem = Array.from(e.clipboardData.items).find(item => item.type.startsWith("image/"));
  if (!imageItem) return;
  e.preventDefault();
  const blob = imageItem.getAsFile();
  if (!blob) return;
  const reader = new FileReader();
  reader.onload = () => {
    const pos = editor.state.selection.main.head;
    editor.dispatch({ changes: { from: pos, insert: `![pasted image](${reader.result})\n` } });
  };
  reader.readAsDataURL(blob);
}

// --- Scroll sync ---

let isScrollSyncing = false;
function initScrollSync() {
  const previewPane = document.getElementById("preview-pane");
  const editorScroll = editor.scrollDOM;
  if (!previewPane || !editorScroll) return;
  editorScroll.addEventListener("scroll", () => {
    if (isScrollSyncing || currentViewMode !== "split") return;
    isScrollSyncing = true;
    const pct = editorScroll.scrollTop / Math.max(1, editorScroll.scrollHeight - editorScroll.clientHeight);
    previewPane.scrollTop = pct * (previewPane.scrollHeight - previewPane.clientHeight);
    requestAnimationFrame(() => { isScrollSyncing = false; });
  });
  previewPane.addEventListener("scroll", () => {
    if (isScrollSyncing || currentViewMode !== "split") return;
    isScrollSyncing = true;
    const pct = previewPane.scrollTop / Math.max(1, previewPane.scrollHeight - previewPane.clientHeight);
    editorScroll.scrollTop = pct * (editorScroll.scrollHeight - editorScroll.clientHeight);
    requestAnimationFrame(() => { isScrollSyncing = false; });
  });
}

// --- Formatting toolbar ---

function applyFormat(fmt: string) {
  const sel = editor.state.selection.main;
  const selected = editor.state.sliceDoc(sel.from, sel.to);
  let insert = "";
  let from = sel.from;
  let to = sel.to;
  switch (fmt) {
    case "bold": insert = `**${selected || "bold"}**`; break;
    case "italic": insert = `*${selected || "italic"}*`; break;
    case "heading": {
      const line = editor.state.doc.lineAt(sel.from);
      from = line.from; to = line.to;
      insert = `### ${line.text.replace(/^#+\s*/, "")}`;
      break;
    }
    case "link": insert = selected ? `[${selected}](url)` : `[link](url)`; break;
    case "code": insert = `\`${selected || "code"}\``; break;
    case "quote": {
      const qline = editor.state.doc.lineAt(sel.from);
      from = qline.from; to = qline.to;
      insert = `> ${qline.text}`;
      break;
    }
    case "list": {
      const lline = editor.state.doc.lineAt(sel.from);
      from = lline.from; to = lline.to;
      insert = `- ${lline.text}`;
      break;
    }
    case "hr": insert = `\n---\n`; break;
    default: return;
  }
  editor.dispatch({ changes: { from, to, insert } });
  editor.focus();
}

// --- Command palette ---

interface PaletteCommand { label: string; shortcut?: string; action: () => void; }

function getCommands(): PaletteCommand[] {
  return [
    { label: "New File", action: newFile },
    { label: "Open File", shortcut: "Cmd+O", action: openFileDialog },
    { label: "Save", shortcut: "Cmd+S", action: saveFile },
    { label: "Save As...", action: saveFileAs },
    { label: "Toggle Preview", shortcut: "Cmd+P", action: togglePreview },
    { label: "Read Mode", shortcut: "Cmd+E", action: toggleReadMode },
    { label: "Copy Formatted HTML", shortcut: "Cmd+Shift+C", action: copyFormattedHTML },
    { label: "Copy Raw Markdown", action: copyRawMarkdown },
    { label: "Copy Plain Text", action: copyPlainText },
    { label: "Export HTML", action: exportHTML },
    { label: "Toggle Line Numbers", action: toggleLineNumbers },
    { label: "Zen Mode", action: toggleZenMode },
    { label: "Cycle Theme", action: cycleTheme },
    { label: "Cycle Font", action: cycleFont },
    { label: "Zoom In", shortcut: "Cmd++", action: zoomIn },
    { label: "Zoom Out", shortcut: "Cmd+-", action: zoomOut },
    { label: "Zoom Reset", shortcut: "Cmd+0", action: zoomReset },
  ];
}

let paletteSelectedIndex = 0;

function toggleCommandPalette() {
  const palette = document.getElementById("command-palette");
  if (!palette) return;
  if (!palette.classList.contains("hidden")) { palette.classList.add("hidden"); return; }
  palette.classList.remove("hidden");
  const input = document.getElementById("palette-input") as HTMLInputElement;
  input.value = "";
  input.focus();
  paletteSelectedIndex = 0;
  renderPaletteResults("");
}

function renderPaletteResults(query: string) {
  const results = document.getElementById("palette-results");
  if (!results) return;
  const commands = getCommands();
  const q = query.toLowerCase();
  const filtered = q ? commands.filter(c => c.label.toLowerCase().includes(q)) : commands;
  if (paletteSelectedIndex >= filtered.length) paletteSelectedIndex = 0;
  results.innerHTML = filtered.map((cmd, i) => {
    const active = i === paletteSelectedIndex ? " active" : "";
    const shortcut = cmd.shortcut ? `<span class="shortcut">${cmd.shortcut}</span>` : "";
    return `<div class="palette-item${active}" data-index="${i}"><span>${escapeHtml(cmd.label)}</span>${shortcut}</div>`;
  }).join("");
  results.querySelectorAll(".palette-item").forEach(el => {
    el.addEventListener("click", () => {
      const idx = parseInt((el as HTMLElement).dataset.index || "0");
      toggleCommandPalette();
      filtered[idx].action();
    });
  });
}

function handlePaletteKey(e: KeyboardEvent) {
  const palette = document.getElementById("command-palette");
  if (!palette || palette.classList.contains("hidden")) return;
  const input = document.getElementById("palette-input") as HTMLInputElement;
  const q = input.value.toLowerCase();
  const commands = getCommands();
  const filtered = q ? commands.filter(c => c.label.toLowerCase().includes(q)) : commands;
  if (e.key === "ArrowDown") { e.preventDefault(); paletteSelectedIndex = Math.min(paletteSelectedIndex + 1, filtered.length - 1); renderPaletteResults(input.value); }
  else if (e.key === "ArrowUp") { e.preventDefault(); paletteSelectedIndex = Math.max(paletteSelectedIndex - 1, 0); renderPaletteResults(input.value); }
  else if (e.key === "Enter") { e.preventDefault(); if (filtered[paletteSelectedIndex]) { toggleCommandPalette(); filtered[paletteSelectedIndex].action(); } }
  else if (e.key === "Escape") { e.preventDefault(); toggleCommandPalette(); }
}

// --- Debounced content change handler ---

function onContentChange(view: EditorView) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const content = view.state.doc.toString();
    updatePreview(content);
    updateWordCount(content);
    // Auto-save to localStorage
    localStorage.setItem("mx-web-autosave", content);
    localStorage.setItem("mx-web-autosave-name", currentFileName || "Untitled");
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

// --- View modes ---

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
  setViewMode(currentViewMode === "split" ? "editor" : "split");
}

function toggleReadMode() {
  setViewMode(currentViewMode === "preview" ? "split" : "preview");
}

// --- Drag & drop ---

function initDragDrop() {
  let dragCounter = 0;

  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) {
      let overlay = document.getElementById("drop-overlay");
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "drop-overlay";
        overlay.textContent = "Drop .md file to open";
        document.body.appendChild(overlay);
      }
      overlay.classList.remove("hidden");
    }
  });

  document.addEventListener("dragleave", () => {
    dragCounter--;
    if (dragCounter === 0) {
      document.getElementById("drop-overlay")?.classList.add("hidden");
    }
  });

  document.addEventListener("dragover", (e) => e.preventDefault());

  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragCounter = 0;
    document.getElementById("drop-overlay")?.classList.add("hidden");

    const file = e.dataTransfer?.files[0];
    if (!file) return;

    const textExts = [".md", ".markdown", ".txt", ".yaml", ".yml", ".json", ".toml", ".xml", ".csv"];
    if (!textExts.some(ext => file.name.endsWith(ext))) return;

    const content = await file.text();
    loadContent(file.name, content);
    addRecentFile(file.name, content);
  });
}

// --- Editor themes ---

const editorFillTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
});

const editorLightTheme = EditorView.theme({
  "&": { backgroundColor: "var(--bg)" },
  ".cm-gutters": {
    backgroundColor: "var(--surface)",
    borderRight: "1px solid var(--border)",
    color: "var(--muted)",
  },
  ".cm-activeLineGutter, .cm-activeLine": {
    backgroundColor: "var(--hover-bg)",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--text)",
  },
  "&.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--active-bg)",
  },
  ".cm-content": {
    color: "var(--text)",
    caretColor: "var(--text)",
  },
});

// --- Banner dismiss ---

function dismissBanner() {
  document.getElementById("banner")?.remove();
  localStorage.setItem("mx-web-banner-dismissed", "1");
}

// --- Sample content ---

const SAMPLE_CONTENT = `# mx -- Markdown Editor for the AI Era

**mx** is a fast, lightweight markdown editor that picks up where [MacDown](https://macdown.uranusjr.com/) left off (abandoned since 2020). No vault, no config, no signup -- just open and write.

Built for people who work with AI daily and need a clean way to read, edit, and share markdown.

## Why mx?

| | mx | MacDown | Typora | VS Code |
|---|---|---|---|---|
| **Startup** | Instant | Slow | Medium | Heavy |
| **Live preview** | Split pane | Split pane | Inline | Extension |
| **Mermaid diagrams** | Built-in | No | Plugin | Extension |
| **Math (KaTeX)** | Built-in | MathJax | Built-in | Extension |
| **Copy as rich HTML** | One shortcut | No | Export | No |
| **File size** | ~8 MB | ~50 MB | ~80 MB | ~300 MB |
| **Apple Silicon** | Native | Rosetta | Native | Electron |

## Features

- **Live split preview** -- resizable pane, real-time rendering
- **Mermaid diagrams** -- flowcharts, sequences, ERDs, rendered inline
- **KaTeX math** -- inline \`$...$\` and display \`$$...$$\`
- **YAML frontmatter** -- rendered as a clean metadata table
- **Copy formatted HTML** -- paste directly into Substack, WordPress, Notion, Google Docs
- **PDF export** -- via Pandoc with Mermaid support *(desktop only)*
- **Dark & light themes** -- follows your system, or pick manually
- **Drag & drop** -- drop any \`.md\`, \`.yaml\`, \`.json\`, \`.txt\` file to open it

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| \`Cmd+O\` | Open file |
| \`Cmd+S\` | Save file |
| \`Cmd+P\` | Toggle preview |
| \`Cmd+E\` | Read mode (preview only) |
| \`Cmd+Shift+C\` | Copy as formatted HTML |
| \`Cmd+=\` / \`Cmd+-\` | Zoom in / out |

## Math Support

Inline math: $E = mc^2$ and $\\sum_{i=1}^{n} x_i$

Display math:

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$

## Diagram Support

\`\`\`mermaid
graph TD
    A[Open .md file] --> B[CodeMirror Editor]
    B --> C{Content Changed}
    C -->|300ms debounce| D[markdown-it parser]
    D --> E[KaTeX math rendering]
    E --> F[Mermaid diagram rendering]
    F --> G[Live Preview pane]
\`\`\`

## Get Started

1. **Start typing** in the editor on the left
2. **Drop a file** -- drag any \`.md\` file onto this page
3. **Open a file** -- \`Cmd+O\` or File menu

Your work is auto-saved to your browser. For file associations, PDF export, and auto-updates, [download the desktop app](https://github.com/vibery-studio/mx/releases/latest).

---

**Open source** -- [github.com/vibery-studio/mx](https://github.com/vibery-studio/mx)
`;

// --- Init ---

window.addEventListener("DOMContentLoaded", () => {
  const editorPane = $("#editor-pane");
  if (!editorPane) return;

  document.documentElement.setAttribute("data-theme", currentThemeMode);

  // Restore autosave or use sample
  const savedContent = localStorage.getItem("mx-web-autosave");
  const savedName = localStorage.getItem("mx-web-autosave-name");
  const initialContent = savedContent || SAMPLE_CONTENT;

  editor = new EditorView({
    state: EditorState.create({
      doc: initialContent,
      extensions: [
        lineNumbersCompartment.of(showLineNumbers ? lineNumbers() : []),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        closeBrackets(),
        foldGutter(),
        search(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        themeCompartment.of(getEffectiveTheme() === "dark" ? oneDark : editorLightTheme),
        editorFillTheme,
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
          indentWithTab,
          { key: "Mod-o", run: () => { openFileDialog(); return true; } },
          { key: "Mod-s", run: () => { saveFile(); return true; } },
          { key: "Mod-p", run: () => { togglePreview(); return true; } },
          { key: "Mod-e", run: () => { toggleReadMode(); return true; } },
          { key: "Mod-Shift-c", run: () => { copyFormattedHTML(); return true; } },
          { key: "Mod-=", run: () => { zoomIn(); return true; } },
          { key: "Mod--", run: () => { zoomOut(); return true; } },
          { key: "Mod-0", run: () => { zoomReset(); return true; } },
          { key: "Mod-Shift-p", run: () => { toggleCommandPalette(); return true; } },
        ]),
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.docChanged || update.selectionSet) {
            if (update.docChanged) onContentChange(update.view);
            else updateCursorPosition(update.view);
            updateSelectionCount(update.view);
          }
        }),
      ],
    }),
    parent: editorPane,
  });

  // Dropdown menus
  document.querySelectorAll(".toolbar-dropdown").forEach(wrapper => {
    const btn = wrapper.querySelector("button");
    const menu = wrapper.querySelector(".dropdown-menu");
    if (!btn || !menu) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".dropdown-menu").forEach(m => {
        if (m !== menu) m.classList.add("hidden");
      });
      menu.classList.toggle("hidden");
    });
  });
  document.addEventListener("click", () => {
    document.querySelectorAll(".dropdown-menu").forEach(m => m.classList.add("hidden"));
  });

  // File menu
  document.getElementById("btn-new")?.addEventListener("click", () => newFile());
  document.getElementById("btn-open")?.addEventListener("click", () => openFileDialog());
  document.getElementById("btn-save")?.addEventListener("click", () => saveFile());
  document.getElementById("btn-save-as")?.addEventListener("click", () => saveFileAs());
  document.getElementById("btn-recent")?.addEventListener("click", () => toggleRecentPanel());
  document.getElementById("btn-export-html")?.addEventListener("click", () => exportHTML());

  // View menu
  document.getElementById("btn-toggle-preview")?.addEventListener("click", () => togglePreview());
  document.getElementById("btn-read-mode")?.addEventListener("click", () => toggleReadMode());
  document.getElementById("btn-theme")?.addEventListener("click", () => cycleTheme());
  document.getElementById("btn-toggle-linenumbers")?.addEventListener("click", () => toggleLineNumbers());
  document.getElementById("btn-zen-mode")?.addEventListener("click", () => toggleZenMode());
  document.getElementById("btn-font-menu")?.addEventListener("click", () => cycleFont());

  // Toolbar buttons
  document.getElementById("btn-copy-html")?.addEventListener("click", copyFormattedHTML);
  document.getElementById("btn-copy-raw")?.addEventListener("click", copyRawMarkdown);
  document.getElementById("btn-copy-plain")?.addEventListener("click", copyPlainText);
  document.getElementById("btn-zoom-in")?.addEventListener("click", zoomIn);
  document.getElementById("btn-zoom-out")?.addEventListener("click", zoomOut);
  document.getElementById("btn-theme-icon")?.addEventListener("click", () => cycleTheme());

  // Banner
  if (localStorage.getItem("mx-web-banner-dismissed") === "1") {
    document.getElementById("banner")?.remove();
  }
  document.getElementById("banner-close")?.addEventListener("click", () => dismissBanner());

  // Divider drag
  initDividerDrag();

  // Drag & drop (works on both hero and editor)
  initDragDrop();

  // Set initial filename
  if (savedContent && savedName) {
    setFilename(savedName);
  }

  // Update theme label
  const themeLabel = document.getElementById("btn-theme-label");
  if (themeLabel) {
    const labels: Record<ThemeMode, string> = { auto: "System", light: "Light", dark: "Dark" };
    themeLabel.textContent = `Theme: ${labels[currentThemeMode]}`;
  }

  // Format bar
  document.querySelectorAll(".fmt-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const fmt = (btn as HTMLElement).dataset.fmt;
      if (fmt) applyFormat(fmt);
    });
  });

  // Command palette
  const paletteInput = document.getElementById("palette-input") as HTMLInputElement;
  if (paletteInput) {
    paletteInput.addEventListener("input", () => {
      paletteSelectedIndex = 0;
      renderPaletteResults(paletteInput.value);
    });
    paletteInput.addEventListener("keydown", handlePaletteKey);
  }
  document.getElementById("palette-backdrop")?.addEventListener("click", () => toggleCommandPalette());

  // Image paste
  editor.dom.addEventListener("paste", handleImagePaste);

  // Scroll sync
  initScrollSync();

  // Font
  applyFont();

  // Line numbers label
  const lnLabel = document.getElementById("linenumbers-label");
  if (lnLabel) lnLabel.textContent = showLineNumbers ? "On" : "Off";

  // Initial render
  updateCursorPosition(editor);
  updatePreview(initialContent);
  updateWordCount(initialContent);
});
