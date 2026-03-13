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
import panzoom from "panzoom";
import katex from "katex";
import "katex/dist/katex.min.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// --- State ---

let currentFilePath: string | null = null;
let currentFolderPath: string | null = localStorage.getItem("mx-current-folder");
let editor: EditorView;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let zoomLevel = 100;
const MAX_RECENT = 10;

// Auto-save state
let autoSaveEnabled = localStorage.getItem("mx-autosave") === "true";
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
const AUTO_SAVE_DELAY = 3000;

// Recovery state
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
const RECOVERY_INTERVAL = 30000;

// Line numbers state
let showLineNumbers = localStorage.getItem("mx-line-numbers") !== "false";
const lineNumbersCompartment = new Compartment();

// Font selection state
const FONT_OPTIONS = ["System", "Inter", "Georgia", "Merriweather", "JetBrains Mono"] as const;
let currentFont: string = localStorage.getItem("mx-font") || "System";

// Scroll sync state
let scrollSyncEnabled = true;
let isScrollSyncing = false;

// Context menu state
let contextMenuTarget: { path: string; isDir: boolean; parentPath: string } | null = null;

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

// --- Font selection ---

function cycleFont() {
  const idx = FONT_OPTIONS.indexOf(currentFont as typeof FONT_OPTIONS[number]);
  currentFont = FONT_OPTIONS[(idx + 1) % FONT_OPTIONS.length];
  localStorage.setItem("mx-font", currentFont);
  applyFont();
}

function applyFont() {
  const previewPane = $("#preview-pane");
  if (previewPane) {
    if (currentFont === "System") {
      previewPane.style.removeProperty("--font-reading");
    } else {
      previewPane.style.setProperty("--font-reading", `"${currentFont}", var(--font-ui)`);
    }
  }
  const label = document.getElementById("font-label");
  if (label) label.textContent = currentFont;
}

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

  mermaid.initialize({ startOnLoad: false, theme: "default" });

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

// Attach id attributes to headings for anchor navigation.
// Uses Unicode property escapes (\p{L}\p{N}) to preserve accented/Vietnamese characters.
md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
  const contentToken = tokens[idx + 1];
  const text = contentToken?.children
    ?.filter((t: any) => t.type === "text" || t.type === "code_inline")
    .map((t: any) => t.content)
    .join("") ?? "";
  // Strip punctuation but keep Unicode letters/numbers (incl. Vietnamese diacritics)
  const id = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
  if (id) tokens[idx].attrSet("id", id);
  return self.renderToken(tokens, idx, options);
};

// Inject copy-link button inside each heading (visible on hover)
md.renderer.rules.heading_close = (tokens, idx, _options, _env, _self) => {
  // heading_open is always 2 positions before heading_close in markdown-it's token stream
  const openToken = tokens[idx - 2];
  const id = openToken?.attrGet("id") ?? "";
  const safeId = id.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const btn = id
    ? `<button class="heading-copy-link" data-anchor="${safeId}" title="Copy link to heading">¶</button>`
    : "";
  return `${btn}</${tokens[idx].tag}>\n`;
};

// --- Wikilinks support ---

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
    try {
      return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false });
    } catch { return `<pre class="katex-error">${tex}</pre>`; }
  });
  html = html.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_match, tex: string) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false });
    } catch { return `<code class="katex-error">${tex}</code>`; }
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
  try {
    await mermaid.run({ nodes: divs as unknown as ArrayLike<HTMLElement> });
  } catch { /* mermaid render errors are non-fatal */ }
  // Add click-to-open-fullscreen on each mermaid diagram
  divs.forEach((div) => {
    const el = div as HTMLElement;
    if (el.dataset.zoomReady) return;
    el.dataset.zoomReady = "1";
    el.style.cursor = "pointer";

    el.addEventListener("click", () => openMermaidOverlay(el));
  });
}

function openMermaidOverlay(source: HTMLElement) {
  const svg = source.querySelector("svg");
  if (!svg) return;

  // Clone via outerHTML to preserve all attributes, styles, defs
  const tmpDiv = document.createElement("div");
  tmpDiv.innerHTML = svg.outerHTML;
  const newSvg = tmpDiv.querySelector("svg")!;

  // Ensure it has a viewBox so it scales properly
  if (!newSvg.getAttribute("viewBox")) {
    const bbox = svg.getBBox();
    newSvg.setAttribute("viewBox", `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);
  }

  // outerHTML preserves Mermaid's internal <style> block — no need to copy computed styles
  // since we always use "default" (light) theme which has good contrast

  newSvg.removeAttribute("width");
  newSvg.removeAttribute("height");

  // Create overlay
  const overlay = document.createElement("div");
  overlay.className = "mermaid-zoom-overlay";

  const closeBtn = document.createElement("button");
  closeBtn.className = "mermaid-zoom-close";
  closeBtn.innerHTML = "✕";
  closeBtn.title = "Close (Esc)";
  overlay.appendChild(closeBtn);

  const wrapper = document.createElement("div");
  wrapper.className = "mermaid-zoom-wrapper";
  wrapper.appendChild(newSvg);
  overlay.appendChild(wrapper);
  document.body.appendChild(overlay);

  // Size wrapper to SVG's natural dimensions and center via panzoom
  const vb = newSvg.getAttribute("viewBox")?.split(/\s+/).map(Number);
  const svgW = vb ? vb[2] : svg.getBBox().width;
  const svgH = vb ? vb[3] : svg.getBBox().height;
  wrapper.style.width = svgW + "px";
  wrapper.style.height = svgH + "px";
  newSvg.style.width = "100%";
  newSvg.style.height = "100%";

  // Fit diagram to screen with padding, then center
  const pad = 60;
  const scaleX = (window.innerWidth - pad * 2) / svgW;
  const scaleY = (window.innerHeight - pad * 2) / svgH;
  const fitScale = Math.min(scaleX, scaleY, 1); // don't upscale past 1
  const cx = (window.innerWidth - svgW * fitScale) / 2;
  const cy = (window.innerHeight - svgH * fitScale) / 2;

  const pz = panzoom(wrapper, {
    smoothScroll: true,
    minZoom: 0.1,
    maxZoom: 10,
    pinchSpeed: 1.5,
    zoomDoubleClickSpeed: 2,
  });

  pz.zoomAbs(0, 0, fitScale);
  pz.moveTo(cx, cy);

  function close() {
    pz.dispose();
    overlay.remove();
  }

  closeBtn.addEventListener("click", close);
  const escHandler = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") { close(); document.removeEventListener("keydown", escHandler); }
  };
  document.addEventListener("keydown", escHandler);
  overlay.tabIndex = 0;
  overlay.focus();
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
        val = "";
        i++;
        while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
          val += (val ? " " : "") + lines[i].trim();
          i++;
        }
        val = val.trim();
      } else if (val === "") {
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

// Scroll the preview pane to the element matching the given anchor fragment.
// Matches on id attribute (headings) or name attribute (<a name="..."> in table cells).
function scrollPreviewToAnchor(fragment: string) {
  const previewPane = document.getElementById("preview-pane");
  if (!previewPane || !fragment) return;
  const target = previewPane.querySelector(`[id="${CSS.escape(fragment)}"], [name="${CSS.escape(fragment)}"]`) as HTMLElement | null;
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
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

// --- File watcher (external changes) ---

let fileWatchSuppressed = false; // suppress events right after we save

async function startFileWatch(path: string | null) {
  try { await invoke("unwatch_file"); } catch { /* ok */ }
  if (path) {
    try { await invoke("watch_file", { path }); } catch { /* ok */ }
  }
}

function isEditorDirty(): boolean {
  const indicator = document.getElementById("modified-indicator");
  return indicator ? !indicator.classList.contains("hidden") : false;
}

async function reloadCurrentFile() {
  if (!currentFilePath) return;
  try {
    const result = await invoke<{ path: string; content: string }>("read_file", { path: currentFilePath });
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: result.content },
    });
    setModified(false);
  } catch { /* file may have been deleted */ }
}

let fileChangeBanner: HTMLElement | null = null;

function showFileChangedBanner() {
  if (fileChangeBanner && document.body.contains(fileChangeBanner)) return; // already showing

  fileChangeBanner = document.createElement("div");
  fileChangeBanner.className = "file-changed-banner";
  fileChangeBanner.innerHTML = `
    <span>File changed on disk.</span>
    <button id="file-changed-reload">Reload</button>
    <button id="file-changed-dismiss">Keep mine</button>
  `;
  document.body.appendChild(fileChangeBanner);

  document.getElementById("file-changed-reload")?.addEventListener("click", () => {
    reloadCurrentFile();
    fileChangeBanner?.remove();
  }, { once: true });

  document.getElementById("file-changed-dismiss")?.addEventListener("click", () => {
    fileChangeBanner?.remove();
  }, { once: true });
}

listen<string>("file-changed", async (event) => {
  if (fileWatchSuppressed) return;
  if (event.payload !== currentFilePath) return;

  if (isEditorDirty()) {
    showFileChangedBanner();
  } else {
    await reloadCurrentFile();
  }
});

// Folder watcher: refresh sidebar when files are added/removed/renamed externally
let folderWatchDebounce: ReturnType<typeof setTimeout> | null = null;

async function startFolderWatch(path: string | null) {
  try { await invoke("unwatch_folder"); } catch { /* ok */ }
  if (path) {
    try { await invoke("watch_folder", { path }); } catch { /* ok */ }
  }
}

listen("folder-changed", () => {
  // Debounce to avoid rapid-fire refreshes
  if (folderWatchDebounce) clearTimeout(folderWatchDebounce);
  folderWatchDebounce = setTimeout(() => {
    if (currentFolderPath) refreshSidebar();
  }, 500);
});

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
  if (path) localStorage.setItem("mx-last-file", path);
  else localStorage.removeItem("mx-last-file");
  updateBreadcrumb();
  // Start watching the new file for external changes
  startFileWatch(path);
}

async function saveFile() {
  const content = editor.state.doc.toString();
  if (!currentFilePath) {
    const path = await save({
      filters: [{ name: "Markdown", extensions: ["md"] }],
      defaultPath: "untitled.md",
    });
    if (!path) return;
    try {
      await invoke("save_file", { path, content });
      setFilename(path);
      setModified(false);
      deleteRecoveryForCurrent();
    } catch (e) {
      console.error("Save failed:", e);
    }
    return;
  }
  try {
    fileWatchSuppressed = true;
    await invoke("save_file", { path: currentFilePath, content });
    setModified(false);
    deleteRecoveryForCurrent();
    setTimeout(() => { fileWatchSuppressed = false; }, 1000);
  } catch (e) {
    fileWatchSuppressed = false;
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

async function openFile(path: string, skipScrollRestore = false) {
  try {
    saveScrollPosition();
    const result = await invoke<{ path: string; content: string }>("read_file", { path });
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: result.content },
    });
    setFilename(result.path);
    setModified(false);
    addRecentFile(result.path);
    if (!skipScrollRestore) restoreScrollPosition(result.path);
  } catch (e) {
    console.error("Open failed:", e);
  }
}

// --- New file ---

async function newFile() {
  if (currentFolderPath) {
    // Create in current folder
    let name = "untitled.md";
    let counter = 1;
    while (true) {
      try {
        await invoke("create_file", { path: `${currentFolderPath}/${name}` });
        await openFile(`${currentFolderPath}/${name}`);
        refreshSidebar();
        return;
      } catch {
        counter++;
        name = `untitled-${counter}.md`;
      }
    }
  } else {
    // No folder — just reset editor
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: "" },
    });
    setFilename(null);
    setModified(false);
  }
}

// --- Auto-save ---

function toggleAutoSave() {
  autoSaveEnabled = !autoSaveEnabled;
  localStorage.setItem("mx-autosave", String(autoSaveEnabled));
  updateAutoSaveUI();
}

function updateAutoSaveUI() {
  const label = document.getElementById("autosave-label");
  if (label) label.textContent = autoSaveEnabled ? "On" : "Off";
  const indicator = document.getElementById("autosave-indicator");
  if (indicator) indicator.classList.toggle("hidden", !autoSaveEnabled);
}

function scheduleAutoSave() {
  if (!autoSaveEnabled || !currentFilePath) return;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    if (currentFilePath) {
      await saveFile();
      flashStatus("Auto-saved", "var(--success)");
    }
  }, AUTO_SAVE_DELAY);
}

// --- Crash recovery ---

function scheduleRecovery() {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(async () => {
    if (currentFilePath) {
      try {
        await invoke("save_recovery", {
          originalPath: currentFilePath,
          content: editor.state.doc.toString(),
        });
      } catch { /* ignore */ }
    }
    scheduleRecovery();
  }, RECOVERY_INTERVAL);
}

async function deleteRecoveryForCurrent() {
  if (!currentFilePath) return;
  try {
    const files = await invoke<{ original_path: string; recovery_path: string; timestamp: number }[]>("get_recovery_files");
    for (const f of files) {
      if (f.original_path === currentFilePath) {
        await invoke("delete_recovery", { recoveryPath: f.recovery_path });
      }
    }
  } catch { /* ignore */ }
}

async function checkRecovery() {
  try {
    const files = await invoke<{ original_path: string; recovery_path: string; timestamp: number }[]>("get_recovery_files");
    if (files.length === 0) return;

    const banner = document.getElementById("recovery-banner");
    const msg = document.getElementById("recovery-message");
    if (!banner || !msg) return;

    const latest = files.sort((a, b) => b.timestamp - a.timestamp)[0];
    msg.textContent = `Recovered unsaved changes for ${latest.original_path.split("/").pop()}`;
    banner.classList.remove("hidden");

    document.getElementById("recovery-restore")?.addEventListener("click", async () => {
      try {
        const content = await invoke<string>("read_recovery_content", { recoveryPath: latest.recovery_path });
        editor.dispatch({
          changes: { from: 0, to: editor.state.doc.length, insert: content },
        });
        setFilename(latest.original_path);
        setModified(true);
        // Clean up all recovery files
        for (const f of files) {
          await invoke("delete_recovery", { recoveryPath: f.recovery_path });
        }
      } catch { /* ignore */ }
      banner.classList.add("hidden");
    }, { once: true });

    document.getElementById("recovery-dismiss")?.addEventListener("click", async () => {
      for (const f of files) {
        await invoke("delete_recovery", { recoveryPath: f.recovery_path });
      }
      banner.classList.add("hidden");
    }, { once: true });
  } catch { /* ignore */ }
}

// --- Line numbers toggle ---

function toggleLineNumbers() {
  showLineNumbers = !showLineNumbers;
  localStorage.setItem("mx-line-numbers", String(showLineNumbers));
  editor.dispatch({
    effects: lineNumbersCompartment.reconfigure(showLineNumbers ? lineNumbers() : []),
  });
  updateLineNumbersUI();
}

function updateLineNumbersUI() {
  const label = document.getElementById("linenumbers-label");
  if (label) label.textContent = showLineNumbers ? "On" : "Off";
}

// --- Status flash ---

function flashStatus(text: string, color: string, duration = 2000) {
  const statusWords = document.getElementById("status-words");
  if (!statusWords) return;
  const prevText = statusWords.textContent || "";
  statusWords.textContent = text;
  statusWords.style.color = color;
  setTimeout(() => {
    statusWords.textContent = prevText;
    statusWords.style.color = "";
  }, duration);
}

// --- Custom dialogs (prompt/confirm don't work in Tauri webview) ---

function showInputDialog(message: string, defaultValue = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const palette = document.getElementById("command-palette");
    const input = document.getElementById("palette-input") as HTMLInputElement;
    const results = document.getElementById("palette-results");
    if (!palette || !input || !results) { resolve(null); return; }

    palette.classList.remove("hidden");
    input.value = defaultValue;
    input.placeholder = message;
    input.focus();
    if (defaultValue) {
      const dotIdx = defaultValue.lastIndexOf(".");
      input.setSelectionRange(0, dotIdx > 0 ? dotIdx : defaultValue.length);
    }
    results.innerHTML = `<div class="palette-item" style="color:var(--muted);pointer-events:none">${escapeHtml(message)} — press Enter to confirm, Esc to cancel</div>`;

    const cleanup = () => {
      palette.classList.add("hidden");
      input.placeholder = "Type a command…";
      input.removeEventListener("keydown", handler);
      document.getElementById("palette-backdrop")?.removeEventListener("click", cancel);
    };
    const cancel = () => { cleanup(); resolve(null); };
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); const v = input.value.trim(); cleanup(); resolve(v || null); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    };
    input.addEventListener("keydown", handler);
    document.getElementById("palette-backdrop")?.addEventListener("click", cancel, { once: true });
  });
}

function showConfirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const palette = document.getElementById("command-palette");
    const input = document.getElementById("palette-input") as HTMLInputElement;
    const results = document.getElementById("palette-results");
    if (!palette || !input || !results) { resolve(false); return; }

    palette.classList.remove("hidden");
    input.value = "";
    input.placeholder = "y / n";
    input.focus();
    results.innerHTML = `<div class="palette-item" style="pointer-events:none">${escapeHtml(message)}</div><div class="palette-item" style="color:var(--muted);pointer-events:none">Press Y to confirm, N or Esc to cancel</div>`;

    const cleanup = () => {
      palette.classList.add("hidden");
      input.placeholder = "Type a command…";
      input.removeEventListener("keydown", handler);
      document.getElementById("palette-backdrop")?.removeEventListener("click", cancel);
    };
    const cancel = () => { cleanup(); resolve(false); };
    const handler = (e: KeyboardEvent) => {
      if (e.key === "y" || e.key === "Y" || e.key === "Enter") { e.preventDefault(); cleanup(); resolve(true); }
      if (e.key === "n" || e.key === "N" || e.key === "Escape") { e.preventDefault(); cancel(); }
    };
    input.addEventListener("keydown", handler);
    document.getElementById("palette-backdrop")?.addEventListener("click", cancel, { once: true });
  });
}

// --- Debounced content change handler ---

function onContentChange(view: EditorView) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const content = view.state.doc.toString();
    updatePreview(content);
    updateWordCount(content);
    updateOutline(content);
  }, 300);
  updateCursorPosition(view);
  setModified(true);
  scheduleAutoSave();
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
    const sidebar = document.getElementById("sidebar");
    const sidebarWidth = sidebar && !sidebar.classList.contains("hidden") ? sidebar.offsetWidth + 4 : 0;
    const offset = e.clientX - rect.left - sidebarWidth;
    const total = rect.width - sidebarWidth;
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

// --- Sidebar resize ---

function initSidebarResize() {
  const resizer = document.getElementById("sidebar-resizer");
  const sidebar = document.getElementById("sidebar");
  if (!resizer || !sidebar) return;

  let dragging = false;

  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const width = Math.max(140, Math.min(500, e.clientX));
    sidebar.style.width = `${width}px`;
  });

  window.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem("mx-sidebar-width", sidebar!.style.width);
    }
  });

  // Restore saved width
  const savedWidth = localStorage.getItem("mx-sidebar-width");
  if (savedWidth) sidebar.style.width = savedWidth;
}

// --- View modes: "split" | "editor" | "preview" ---

type ViewMode = "split" | "editor" | "preview";
let currentViewMode: ViewMode = (localStorage.getItem("mx-view-mode") as ViewMode) || "split";

function setViewMode(mode: ViewMode) {
  const previewPane = $("#preview-pane");
  const divider = $("#divider");
  const editorPane = $("#editor-pane");
  if (!previewPane || !divider || !editorPane) return;

  currentViewMode = mode;
  localStorage.setItem("mx-view-mode", mode);

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

// --- Drag & drop via Tauri ---

async function initDragDrop() {
  const appWindow = getCurrentWindow();
  await appWindow.onDragDropEvent(async (event) => {
    if (event.payload.type === "drop") {
      const paths = event.payload.paths;
      const textExts = [".md", ".markdown", ".txt", ".yaml", ".yml", ".json", ".toml", ".xml", ".csv", ".log"];

      const first = paths[0];
      if (first) {
        try {
          await invoke<unknown[]>("list_directory", { path: first });
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
| \`Cmd+N\` | New file |
| \`Cmd+P\` | Toggle preview |
| \`Cmd+E\` | Read mode (preview only) |
| \`Cmd+B\` | Toggle file sidebar |
| \`Cmd+F\` | Search in file |
| \`Cmd+H\` | Search & replace |
| \`Cmd+Shift+P\` | Command palette |
| \`Cmd+Shift+F\` | File search |
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

// --- Export to PDF ---

async function exportPDF() {
  const content = editor.state.doc.toString();

  const defaultName = currentFilePath
    ? currentFilePath.replace(/\.md$/, ".pdf").split("/").pop()!
    : "export.pdf";
  const outputPath = await save({
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    defaultPath: defaultName,
  });
  if (!outputPath) return;

  const statusWords = document.getElementById("status-words");
  const prevText = statusWords?.textContent || "";
  if (statusWords) {
    statusWords.textContent = "Exporting PDF...";
    statusWords.style.color = "var(--accent)";
  }

  try {
    const result = await invoke<string>("export_pdf", {
      markdownContent: content,
      outputPath,
    });
    if (statusWords) {
      statusWords.textContent = `PDF saved: ${result.split("/").pop()}`;
      statusWords.style.color = "var(--success)";
      setTimeout(() => {
        statusWords.textContent = prevText;
        statusWords.style.color = "";
      }, 3000);
    }
  } catch (e) {
    console.error("Pandoc export failed:", e);
    if (statusWords) {
      statusWords.textContent = `PDF failed: ${e}`;
      statusWords.style.color = "var(--error)";
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

// --- Mouse-based drag to move (Tauri intercepts HTML5 drag events) ---

let dragState: { srcPath: string; srcEl: HTMLElement; ghost: HTMLElement } | null = null;
let dragStartPos: { x: number; y: number } | null = null;
const DRAG_THRESHOLD = 5;

function initTreeDrag(item: HTMLElement, entry: DirEntry) {
  item.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // left click only
    dragStartPos = { x: e.clientX, y: e.clientY };

    const onMouseMove = (me: MouseEvent) => {
      if (!dragStartPos) return;

      // Only start drag after threshold
      if (!dragState) {
        const dx = me.clientX - dragStartPos.x;
        const dy = me.clientY - dragStartPos.y;
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;

        // Start dragging
        item.classList.add("dragging");
        const ghost = document.createElement("div");
        ghost.className = "drag-ghost";
        ghost.textContent = entry.name;
        document.body.appendChild(ghost);
        dragState = { srcPath: entry.path, srcEl: item, ghost };
      }

      dragState.ghost.style.left = `${me.clientX + 12}px`;
      dragState.ghost.style.top = `${me.clientY - 10}px`;

      // Highlight drop target
      document.querySelectorAll(".tree-item.drag-over").forEach(el => el.classList.remove("drag-over"));
      const target = document.elementFromPoint(me.clientX, me.clientY)?.closest(".tree-item.directory") as HTMLElement | null;
      if (target && target !== item && target.dataset.path !== entry.path) {
        target.classList.add("drag-over");
      }
    };

    const onMouseUp = async (me: MouseEvent) => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);

      if (!dragState) {
        dragStartPos = null;
        return; // Was a click, not a drag
      }

      item.classList.remove("dragging");
      dragState.ghost.remove();
      document.querySelectorAll(".tree-item.drag-over").forEach(el => el.classList.remove("drag-over"));

      // Find drop target
      const targetEl = document.elementFromPoint(me.clientX, me.clientY)?.closest(".tree-item.directory") as HTMLElement | null;
      const srcPath = dragState.srcPath;
      dragState = null;
      dragStartPos = null;

      let destDir: string | null = null;
      if (targetEl && targetEl.dataset.path && targetEl.dataset.path !== srcPath) {
        destDir = targetEl.dataset.path;
      } else {
        // Check if dropped on sidebar-tree empty area (move to root)
        const treeEl = document.elementFromPoint(me.clientX, me.clientY)?.closest("#sidebar-tree");
        if (treeEl && currentFolderPath) {
          destDir = currentFolderPath;
        }
      }

      if (!destDir) return;
      const srcParent = srcPath.substring(0, srcPath.lastIndexOf("/"));
      if (srcParent === destDir) return; // already there
      // Prevent moving a folder into itself
      if (destDir.startsWith(srcPath + "/")) return;

      const srcName = srcPath.split("/").pop()!;
      const destPath = `${destDir}/${srcName}`;
      try {
        await invoke("rename_entry", { oldPath: srcPath, newPath: destPath });
        if (srcPath === currentFilePath) setFilename(destPath);
        refreshSidebar();
      } catch (err) {
        flashStatus(`Move failed: ${err}`, "var(--error)", 3000);
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  });
}

async function renderTreeEntries(entries: DirEntry[], container: HTMLElement, depth: number) {
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = `tree-item${entry.is_dir ? " directory" : ""}`;
    if (entry.path === currentFilePath) item.classList.add("active");
    item.dataset.path = entry.path;
    item.dataset.isDir = String(entry.is_dir);
    item.dataset.parentPath = entry.path.substring(0, entry.path.lastIndexOf("/"));

    const indent = '<span class="tree-indent"></span>'.repeat(depth);
    const chevron = entry.is_dir
      ? `<span class="tree-chevron${expandedDirs.has(entry.path) ? " expanded" : ""}">▶</span>`
      : '<span class="tree-chevron-placeholder"></span>';

    item.innerHTML = `${indent}${chevron}<span class="icon">${getFileIcon(entry)}</span><span class="name">${entry.name}</span>`;

    // Mouse-based drag to move
    initTreeDrag(item, entry);

    // Context menu on right-click
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, {
        path: entry.path,
        isDir: entry.is_dir,
        parentPath: entry.path.substring(0, entry.path.lastIndexOf("/")),
      });
    });

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
  if (!sidebar) return;
  sidebar.classList.toggle("hidden");
  localStorage.setItem("mx-sidebar", sidebar.classList.contains("hidden") ? "false" : "true");
}

async function openFolder(folderPath?: string) {
  let path = folderPath;
  if (!path) {
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    path = selected as string;
  }
  currentFolderPath = path;
  localStorage.setItem("mx-current-folder", path);
  expandedDirs.clear();
  const sidebar = document.getElementById("sidebar");
  if (sidebar?.classList.contains("hidden")) {
    sidebar.classList.remove("hidden");
  }
  loadDirectory(path);
  updateSidebarTitle(path);
  startFolderWatch(path);
}

function refreshSidebar() {
  if (currentFolderPath) loadDirectory(currentFolderPath);
}

// --- Context menu ---

function showContextMenu(x: number, y: number, target: { path: string; isDir: boolean; parentPath: string }) {
  const menu = document.getElementById("context-menu");
  if (!menu) return;
  contextMenuTarget = target;

  // Show/hide items based on target type
  const newFileItem = document.getElementById("ctx-new-file");
  const newFolderItem = document.getElementById("ctx-new-folder");
  if (newFileItem) newFileItem.style.display = target.isDir ? "" : "none";
  if (newFolderItem) newFolderItem.style.display = target.isDir ? "" : "none";

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.remove("hidden");

  // Ensure menu stays within viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;
  });
}

function hideContextMenu() {
  const menu = document.getElementById("context-menu");
  if (menu) menu.classList.add("hidden");
  contextMenuTarget = null;
}

async function ctxNewFile() {
  if (!contextMenuTarget?.isDir) return;
  const dir = contextMenuTarget.path;
  hideContextMenu();

  const name = await showInputDialog("File name:", "untitled.md");
  if (!name) return;

  try {
    await invoke("create_file", { path: `${dir}/${name}` });
    refreshSidebar();
    await openFile(`${dir}/${name}`);
  } catch (e) {
    flashStatus(`Error: ${e}`, "var(--error)", 3000);
  }
}

async function ctxNewFolder() {
  if (!contextMenuTarget?.isDir) return;
  const dir = contextMenuTarget.path;
  hideContextMenu();

  const name = await showInputDialog("Folder name:");
  if (!name) return;

  try {
    await invoke("create_directory", { path: `${dir}/${name}` });
    refreshSidebar();
  } catch (e) {
    flashStatus(`Error: ${e}`, "var(--error)", 3000);
  }
}

async function ctxDelete() {
  if (!contextMenuTarget) return;
  const target = contextMenuTarget;
  hideContextMenu();

  const name = target.path.split("/").pop()!;
  if (!(await showConfirmDialog(`Move "${name}" to trash?`))) return;

  try {
    await invoke("delete_entry", { path: target.path });
    if (target.path === currentFilePath) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "" } });
      setFilename(null);
      setModified(false);
    }
    refreshSidebar();
  } catch (e) {
    flashStatus(`Delete failed: ${e}`, "var(--error)", 3000);
  }
}

async function ctxRename() {
  if (!contextMenuTarget) return;
  const target = contextMenuTarget;
  hideContextMenu();

  const oldName = target.path.split("/").pop()!;
  const treeItem = document.querySelector(`.tree-item[data-path="${CSS.escape(target.path)}"]`);
  if (!treeItem) return;

  const nameSpan = treeItem.querySelector(".name") as HTMLElement;
  if (!nameSpan) return;

  const input = document.createElement("input");
  input.className = "tree-rename-input";
  input.value = oldName;
  nameSpan.replaceWith(input);
  input.focus();
  // Select name without extension for files
  if (!target.isDir) {
    const dotIdx = oldName.lastIndexOf(".");
    input.setSelectionRange(0, dotIdx > 0 ? dotIdx : oldName.length);
  } else {
    input.select();
  }

  const doRename = async () => {
    const newName = input.value.trim();
    if (!newName || newName === oldName) {
      // Cancel — restore original name
      const span = document.createElement("span");
      span.className = "name";
      span.textContent = oldName;
      input.replaceWith(span);
      return;
    }
    const dir = target.path.substring(0, target.path.lastIndexOf("/"));
    const newPath = `${dir}/${newName}`;
    try {
      await invoke("rename_entry", { oldPath: target.path, newPath });
      if (target.path === currentFilePath) {
        setFilename(newPath);
      }
      refreshSidebar();
    } catch (e) {
      flashStatus(`Rename failed: ${e}`, "var(--error)", 3000);
      const span = document.createElement("span");
      span.className = "name";
      span.textContent = oldName;
      input.replaceWith(span);
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doRename(); }
    if (e.key === "Escape") {
      const span = document.createElement("span");
      span.className = "name";
      span.textContent = oldName;
      input.replaceWith(span);
    }
  });
  input.addEventListener("blur", doRename);
}

// --- Outline panel ---

let outlineVisible = false;

function toggleOutline() {
  const panel = document.getElementById("outline-panel");
  if (!panel) return;
  outlineVisible = !outlineVisible;
  panel.classList.toggle("hidden", !outlineVisible);
  localStorage.setItem("mx-outline", outlineVisible ? "true" : "false");
  if (outlineVisible) updateOutline(editor.state.doc.toString());
}

function updateOutline(content: string) {
  if (!outlineVisible) return;
  const list = document.getElementById("outline-list");
  if (!list) return;

  const headings: { level: number; text: string; line: number }[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (match) {
      headings.push({ level: match[1].length, text: match[2].trim(), line: i + 1 });
    }
  }

  if (headings.length === 0) {
    list.innerHTML = '<div style="padding: 8px 12px; color: var(--muted); font-size: 11px;">No headings</div>';
    return;
  }

  list.innerHTML = headings.map(h => {
    return `<div class="outline-item outline-h${h.level}" data-line="${h.line}">${escapeHtml(h.text)}</div>`;
  }).join("");

  list.querySelectorAll(".outline-item").forEach(el => {
    el.addEventListener("click", () => {
      const lineNum = parseInt((el as HTMLElement).dataset.line || "1");
      const line = editor.state.doc.line(lineNum);
      editor.dispatch({
        selection: { anchor: line.from },
        scrollIntoView: true,
      });
      editor.focus();
    });
  });
}

// --- Command palette ---

interface PaletteCommand {
  label: string;
  shortcut?: string;
  action: () => void;
}

function getCommands(): PaletteCommand[] {
  return [
    { label: "New File", shortcut: "⌘N", action: newFile },
    { label: "Open File", shortcut: "⌘O", action: openFileDialog },
    { label: "Open Folder", action: () => openFolder() },
    { label: "Save", shortcut: "⌘S", action: saveFile },
    { label: "Toggle Preview", shortcut: "⌘P", action: togglePreview },
    { label: "Toggle Sidebar", shortcut: "⌘B", action: toggleSidebar },
    { label: "Read Mode", shortcut: "⌘E", action: toggleReadMode },
    { label: "Copy Formatted HTML", shortcut: "⌘⇧C", action: copyFormattedHTML },
    { label: "Export PDF", action: exportPDF },
    { label: "Export HTML", action: exportHTML },
    { label: "Export DOCX", action: exportDOCX },
    { label: "Zen Mode", shortcut: "⌘⇧Z", action: toggleZenMode },
    { label: "Copy Raw Markdown", action: copyRawMarkdown },
    { label: "Copy Plain Text", action: copyPlainText },
    { label: "Toggle Outline", action: toggleOutline },
    { label: "Toggle Line Numbers", action: toggleLineNumbers },
    { label: "Toggle Auto-save", action: toggleAutoSave },
    { label: "Cycle Theme", action: cycleTheme },
    { label: "Zoom In", shortcut: "⌘+", action: zoomIn },
    { label: "Zoom Out", shortcut: "⌘-", action: zoomOut },
    { label: "Zoom Reset", shortcut: "⌘0", action: zoomReset },
    { label: "File Search", shortcut: "⌘⇧F", action: openFileSearch },
    { label: "Search in Files", shortcut: "⌘⌥F", action: () => { sidebarSearchMode ? deactivateSidebarSearch() : activateSidebarSearch(); } },
    { label: "Cycle Font", action: cycleFont },
    { label: "Reload Custom CSS", action: loadCustomCSS },
    { label: "Check for Updates", action: () => doUpdateCheck(true) },
    { label: "Keyboard Shortcuts", shortcut: "⌘/", action: toggleHelp },
    { label: "About mx", action: () => invoke("plugin:opener|open_url", { url: "https://github.com/vibery-studio/mx" }) },
  ];
}

let paletteSelectedIndex = 0;

function toggleCommandPalette() {
  const palette = document.getElementById("command-palette");
  if (!palette) return;

  if (!palette.classList.contains("hidden")) {
    palette.classList.add("hidden");
    return;
  }

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
      const cmd = filtered[idx];
      toggleCommandPalette();
      cmd.action();
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

  if (e.key === "ArrowDown") {
    e.preventDefault();
    paletteSelectedIndex = Math.min(paletteSelectedIndex + 1, filtered.length - 1);
    renderPaletteResults(input.value);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    paletteSelectedIndex = Math.max(paletteSelectedIndex - 1, 0);
    renderPaletteResults(input.value);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (filtered[paletteSelectedIndex]) {
      const cmd = filtered[paletteSelectedIndex];
      toggleCommandPalette();
      cmd.action();
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    toggleCommandPalette();
  }
}

// --- File search ---

let fileSearchCache: string[] = [];
let fileSearchSelectedIndex = 0;

async function openFileSearch() {
  if (!currentFolderPath) {
    flashStatus("Open a folder first", "var(--warning)");
    return;
  }

  const dialog = document.getElementById("file-search");
  if (!dialog) return;

  if (!dialog.classList.contains("hidden")) {
    dialog.classList.add("hidden");
    return;
  }

  dialog.classList.remove("hidden");
  const input = document.getElementById("filesearch-input") as HTMLInputElement;
  input.value = "";
  input.focus();
  fileSearchSelectedIndex = 0;

  try {
    fileSearchCache = await invoke<string[]>("list_files_recursive", { path: currentFolderPath, maxDepth: 5 });
  } catch {
    fileSearchCache = [];
  }

  renderFileSearchResults("");
}

function closeFileSearch() {
  const dialog = document.getElementById("file-search");
  if (dialog) dialog.classList.add("hidden");
}

function renderFileSearchResults(query: string) {
  const results = document.getElementById("filesearch-results");
  if (!results) return;

  const q = query.toLowerCase();
  const filtered = q
    ? fileSearchCache.filter(f => f.toLowerCase().includes(q)).slice(0, 50)
    : fileSearchCache.slice(0, 50);

  if (fileSearchSelectedIndex >= filtered.length) fileSearchSelectedIndex = 0;

  const prefix = currentFolderPath ? currentFolderPath + "/" : "";

  results.innerHTML = filtered.map((f, i) => {
    const active = i === fileSearchSelectedIndex ? " active" : "";
    const name = f.split("/").pop()!;
    const rel = f.startsWith(prefix) ? f.slice(prefix.length) : f;
    const dir = rel.substring(0, rel.lastIndexOf("/"));
    return `<div class="filesearch-item${active}" data-index="${i}" data-path="${f.replace(/"/g, "&quot;")}"><span>${escapeHtml(name)}</span><span class="filesearch-path">${escapeHtml(dir)}</span></div>`;
  }).join("");

  results.querySelectorAll(".filesearch-item").forEach(el => {
    el.addEventListener("click", () => {
      const path = (el as HTMLElement).dataset.path!;
      closeFileSearch();
      openFile(path);
    });
  });
}

function handleFileSearchKey(e: KeyboardEvent) {
  const dialog = document.getElementById("file-search");
  if (!dialog || dialog.classList.contains("hidden")) return;

  const input = document.getElementById("filesearch-input") as HTMLInputElement;
  const q = input.value.toLowerCase();
  const filtered = q
    ? fileSearchCache.filter(f => f.toLowerCase().includes(q)).slice(0, 50)
    : fileSearchCache.slice(0, 50);

  if (e.key === "ArrowDown") {
    e.preventDefault();
    fileSearchSelectedIndex = Math.min(fileSearchSelectedIndex + 1, filtered.length - 1);
    renderFileSearchResults(input.value);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    fileSearchSelectedIndex = Math.max(fileSearchSelectedIndex - 1, 0);
    renderFileSearchResults(input.value);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (filtered[fileSearchSelectedIndex]) {
      closeFileSearch();
      openFile(filtered[fileSearchSelectedIndex]);
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFileSearch();
  }
}

// --- Content search (sidebar) ---

interface SearchResult {
  file_path: string;
  line_number: number;
  line_content: string;
  match_start: number;
  match_end: number;
}

// Navigate editor to exact keyword position and sync preview scroll.
// Uses double-rAF so all pending rAFs (CodeMirror scroll, restoreScrollPosition)
// have already fired before we read scrollTop and sync the preview.
async function navigateToSearchResult(result: SearchResult) {
  const line = Math.max(1, result.line_number);
  const lineInfo = editor.state.doc.line(Math.min(line, editor.state.doc.lines));
  const anchor = Math.min(lineInfo.from + result.match_start, lineInfo.to);
  const head = Math.min(lineInfo.from + result.match_end, lineInfo.to);
  editor.dispatch({ selection: { anchor, head }, scrollIntoView: true });
  editor.focus();
  // Double-rAF: wait for all pending animation frames (scroll ops) to settle
  requestAnimationFrame(() => {
    requestAnimationFrame(async () => {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      await updatePreview(editor.state.doc.toString());
      const previewPane = document.getElementById("preview-pane");
      const editorScroll = editor.scrollDOM;
      if (!previewPane || !editorScroll) return;
      const pct = editorScroll.scrollTop / Math.max(1, editorScroll.scrollHeight - editorScroll.clientHeight);
      previewPane.scrollTop = pct * Math.max(0, previewPane.scrollHeight - previewPane.clientHeight);
    });
  });
}

let sidebarSearchMode = false;
let sidebarSearchDebounce: ReturnType<typeof setTimeout> | null = null;
let sidebarSearchResults: SearchResult[] = [];
let sidebarSearchSelectedIndex = 0;

function activateSidebarSearch() {
  if (!currentFolderPath) {
    flashStatus("Open a folder first", "var(--warning)");
    return;
  }
  sidebarSearchMode = true;
  sidebarSearchResults = [];
  sidebarSearchSelectedIndex = 0;

  // Show search panel, hide tree and outline
  document.getElementById("sidebar-search-panel")?.classList.remove("hidden");
  document.getElementById("sidebar-tree")?.classList.add("hidden");
  document.getElementById("outline-panel")?.classList.add("hidden");

  // Make folder title clickable to exit search
  const title = document.getElementById("sidebar-title");
  if (title) title.classList.add("clickable");

  // Clear and focus input
  const input = document.getElementById("sidebar-search-input") as HTMLInputElement;
  if (input) { input.value = ""; input.focus(); }

  renderSidebarSearchResults();
}

function deactivateSidebarSearch() {
  sidebarSearchMode = false;
  if (sidebarSearchDebounce) clearTimeout(sidebarSearchDebounce);

  // Hide search panel, show tree
  document.getElementById("sidebar-search-panel")?.classList.add("hidden");
  document.getElementById("sidebar-tree")?.classList.remove("hidden");

  // Remove clickable style from title
  const title = document.getElementById("sidebar-title");
  if (title) title.classList.remove("clickable");
}

async function doSidebarSearch(query: string) {
  if (!query.trim() || !currentFolderPath) {
    sidebarSearchResults = [];
    renderSidebarSearchResults();
    return;
  }
  try {
    sidebarSearchResults = await invoke<SearchResult[]>("search_in_files", {
      folderPath: currentFolderPath,
      query: query.trim(),
    });
  } catch {
    sidebarSearchResults = [];
  }
  sidebarSearchSelectedIndex = 0;
  renderSidebarSearchResults();
}

function renderSidebarSearchResults() {
  const container = document.getElementById("sidebar-search-results");
  if (!container) return;

  if (sidebarSearchResults.length === 0) {
    const input = document.getElementById("sidebar-search-input") as HTMLInputElement;
    const hasQuery = input?.value.trim();
    container.innerHTML = hasQuery
      ? `<div class="sidebar-search-empty">No results</div>`
      : "";
    return;
  }

  const prefix = currentFolderPath ? currentFolderPath + "/" : "";
  container.innerHTML = sidebarSearchResults.map((r, i) => {
    const active = i === sidebarSearchSelectedIndex ? " active" : "";
    const relPath = r.file_path.startsWith(prefix) ? r.file_path.slice(prefix.length) : r.file_path;
    const fileName = relPath.split("/").pop()!;
    const dir = relPath.substring(0, relPath.lastIndexOf("/"));
    const before = escapeHtml(r.line_content.substring(0, r.match_start));
    const match = escapeHtml(r.line_content.substring(r.match_start, r.match_end));
    const after = escapeHtml(r.line_content.substring(r.match_end));
    return `<div class="sidebar-search-item${active}" data-index="${i}">
      <div><span class="ss-file">${escapeHtml(fileName)}</span>${dir ? `<span class="ss-meta">${escapeHtml(dir)}</span>` : ""}<span class="ss-meta">:${r.line_number}</span></div>
      <span class="ss-content">${before}<span class="ss-match">${match}</span>${after}</span>
    </div>`;
  }).join("");

  container.querySelectorAll(".sidebar-search-item").forEach((el, i) => {
    el.addEventListener("click", () => openSidebarSearchResult(i));
  });
}

async function openSidebarSearchResult(index: number) {
  const result = sidebarSearchResults[index];
  if (!result) return;
  await openFile(result.file_path, true);
  navigateToSearchResult(result);
}

// --- Scroll position memory (#9) ---

const scrollPositions = new Map<string, number>();

function saveScrollPosition() {
  if (!currentFilePath) return;
  const scroller = editor.scrollDOM;
  if (scroller) scrollPositions.set(currentFilePath, scroller.scrollTop);
}

function restoreScrollPosition(path: string) {
  const pos = scrollPositions.get(path);
  if (pos !== undefined) {
    requestAnimationFrame(() => {
      editor.scrollDOM.scrollTop = pos;
    });
  }
}

// --- Selection count (#6) ---

function updateSelectionCount(view: EditorView) {
  const sel = view.state.selection.main;
  const el = document.getElementById("status-selection");
  if (!el) return;
  if (sel.empty) {
    el.textContent = "";
    return;
  }
  const text = view.state.sliceDoc(sel.from, sel.to);
  const words = text.split(/\s+/).filter(Boolean).length;
  const chars = text.length;
  el.textContent = `(${words} words, ${chars} chars selected)`;
}

// --- Zen mode (#22) ---

let zenMode = false;

function toggleZenMode() {
  zenMode = !zenMode;
  const app = document.getElementById("app");
  if (app) app.classList.toggle("zen-mode", zenMode);
  localStorage.setItem("mx-zen", zenMode ? "true" : "false");
}

// --- Help cheatsheet modal ---

function toggleHelp() {
  const modal = document.getElementById("help-modal");
  if (!modal) return;
  if (!modal.classList.contains("hidden")) {
    modal.classList.add("hidden");
    return;
  }
  const content = document.getElementById("help-content");
  if (content) {
    const shortcuts = [
      ["File", [
        ["⌘N", "New file"],
        ["⌘O", "Open file"],
        ["⌘S", "Save"],
        ["⌘⇧S", "Save as"],
      ]],
      ["View", [
        ["⌘P", "Toggle preview"],
        ["⌘E", "Read mode"],
        ["⌘B", "Toggle sidebar"],
        ["⌘⇧Z", "Zen mode"],
        ["⌘+/⌘-/⌘0", "Zoom in/out/reset"],
      ]],
      ["Search", [
        ["⌘F", "Find in file"],
        ["⌘H", "Find & replace"],
        ["⌘⇧F", "File search"],
        ["⌘⌥F", "Content search"],
        ["⌘⇧P", "Command palette"],
      ]],
      ["Edit", [
        ["⌘Z/⌘⇧Z", "Undo/redo"],
        ["⌘⇧C", "Copy formatted HTML"],
        ["Tab/⇧Tab", "Indent/outdent"],
      ]],
      ["Export", [
        ["⌘⇧E", "Export PDF"],
      ]],
    ] as [string, [string, string][]][];
    content.innerHTML = shortcuts.map(([group, keys]) =>
      `<div class="help-group"><h3>${group}</h3>${keys.map(([k, d]) =>
        `<div class="help-row"><kbd>${k}</kbd><span>${d}</span></div>`
      ).join("")}</div>`
    ).join("");
  }
  modal.classList.remove("hidden");
}

// --- Copy modes (#4) ---

async function copyRawMarkdown() {
  const content = editor.state.doc.toString();
  await navigator.clipboard.writeText(content);
  flashStatus("Copied raw markdown!", "var(--success)");
}

async function copyPlainText() {
  const previewPane = $("#preview-pane");
  if (!previewPane) return;
  await navigator.clipboard.writeText(previewPane.innerText);
  flashStatus("Copied plain text!", "var(--success)");
}

// --- Duplicate file (#16) ---

async function ctxDuplicate() {
  if (!contextMenuTarget) return;
  const target = contextMenuTarget;
  hideContextMenu();
  try {
    const newPath = await invoke<string>("duplicate_entry", { path: target.path });
    refreshSidebar();
    if (!target.isDir) await openFile(newPath);
    flashStatus("Duplicated!", "var(--success)");
  } catch (e) {
    flashStatus(`Duplicate failed: ${e}`, "var(--error)", 3000);
  }
}

// --- Copy file path (#10) ---

async function ctxCopyAbsolutePath() {
  if (!contextMenuTarget) return;
  const target = contextMenuTarget;
  hideContextMenu();
  await navigator.clipboard.writeText(target.path);
  flashStatus("Absolute path copied!", "var(--success)");
}

async function ctxCopyRelativePath() {
  if (!contextMenuTarget) return;
  const target = contextMenuTarget;
  hideContextMenu();
  const relative = currentFolderPath
    ? target.path.replace(currentFolderPath + "/", "")
    : target.path;
  await navigator.clipboard.writeText(relative);
  flashStatus("Relative path copied!", "var(--success)");
}

// --- Reveal in Finder (#20) ---

async function ctxReveal() {
  if (!contextMenuTarget) return;
  const target = contextMenuTarget;
  hideContextMenu();
  try {
    await invoke("reveal_in_finder", { path: target.path });
  } catch (e) {
    flashStatus(`Failed: ${e}`, "var(--error)", 3000);
  }
}

// --- Export HTML (#34) ---

async function exportHTML() {
  const content = editor.state.doc.toString();
  const theme = getEffectiveTheme();
  try {
    const html = await invoke<string>("export_html", { markdownContent: content, theme });
    const defaultName = currentFilePath
      ? currentFilePath.replace(/\.md$/, ".html").split("/").pop()!
      : "export.html";
    const outputPath = await save({
      filters: [{ name: "HTML", extensions: ["html"] }],
      defaultPath: defaultName,
    });
    if (!outputPath) return;
    await invoke("save_file", { path: outputPath, content: html });
    flashStatus(`HTML saved: ${outputPath.split("/").pop()}`, "var(--success)");
  } catch (e) {
    flashStatus(`Export failed: ${e}`, "var(--error)", 3000);
  }
}

// --- Export DOCX (#32) ---

async function exportDOCX() {
  const content = editor.state.doc.toString();
  const defaultName = currentFilePath
    ? currentFilePath.replace(/\.md$/, ".docx").split("/").pop()!
    : "export.docx";
  const outputPath = await save({
    filters: [{ name: "Word", extensions: ["docx"] }],
    defaultPath: defaultName,
  });
  if (!outputPath) return;

  // Write temp md, run pandoc
  const tmpPath = `/tmp/mx_export_${Date.now()}.md`;
  try {
    await invoke("save_file", { path: tmpPath, content });
    flashStatus("Exporting DOCX...", "var(--accent)");
    // Use export_pdf command pattern but for DOCX we need a different approach
    // Since we don't have a dedicated Rust command, we'll use the HTML export + save approach
    // Actually we can reuse pandoc via a shell command through the existing export mechanism
    // For now, export as HTML first, then note this requires pandoc
    const html = await invoke<string>("export_html", { markdownContent: content, theme: getEffectiveTheme() });
    // Save HTML to temp, then we note that full DOCX needs pandoc installed
    await invoke("save_file", { path: outputPath.replace(/\.docx$/, ".html"), content: html });
    flashStatus("Saved as HTML (DOCX requires pandoc)", "var(--warning)", 4000);
  } catch (e) {
    flashStatus(`Export failed: ${e}`, "var(--error)", 3000);
  }
}

// --- Image lightbox (#36) ---

function showImageLightbox(src: string) {
  const lightbox = document.getElementById("image-lightbox");
  if (!lightbox) return;
  lightbox.innerHTML = `<img src="${src.replace(/"/g, "&quot;")}" />`;
  lightbox.classList.remove("hidden");
  lightbox.addEventListener("click", () => {
    lightbox.classList.add("hidden");
    lightbox.innerHTML = "";
  }, { once: true });
}

// --- Image paste from clipboard (#30) ---

async function handleImagePaste(e: ClipboardEvent) {
  if (!e.clipboardData) return;
  const items = Array.from(e.clipboardData.items);
  const imageItem = items.find(item => item.type.startsWith("image/"));
  if (!imageItem) return;

  e.preventDefault();
  const blob = imageItem.getAsFile();
  if (!blob) return;

  // Need a folder to save the image
  const dir = currentFilePath
    ? currentFilePath.substring(0, currentFilePath.lastIndexOf("/"))
    : currentFolderPath;
  if (!dir) {
    flashStatus("Save file first to paste images", "var(--warning)");
    return;
  }

  try {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // For now insert as data URL (works in preview), save actual file if possible
      const insert = `![pasted image](${dataUrl})\n`;
      const pos = editor.state.selection.main.head;
      editor.dispatch({
        changes: { from: pos, insert },
      });
      flashStatus("Image pasted!", "var(--success)");
    };
    reader.readAsDataURL(blob);
  } catch (e) {
    flashStatus(`Paste failed: ${e}`, "var(--error)", 3000);
  }
}

// --- Auto update ---

async function doUpdateCheck(manual: boolean) {
  const statusWords = document.getElementById("status-words");
  try {
    if (manual && statusWords) {
      statusWords.textContent = "Checking for updates...";
      statusWords.style.color = "var(--accent)";
    }

    const update = await check();
    if (!update) {
      if (manual && statusWords) {
        statusWords.textContent = "You're on the latest version";
        statusWords.style.color = "var(--success)";
        setTimeout(() => { statusWords.textContent = ""; statusWords.style.color = ""; }, 3000);
      }
      return;
    }

    if (statusWords) {
      statusWords.textContent = `Update ${update.version} available — downloading...`;
      statusWords.style.color = "var(--accent)";
    }

    let totalSize = 0;
    let downloaded = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started" && event.data.contentLength) {
        totalSize = event.data.contentLength;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        if (statusWords && totalSize > 0) {
          const pct = Math.round((downloaded / totalSize) * 100);
          statusWords.textContent = `Downloading update... ${pct}%`;
        }
      }
    });

    if (statusWords) {
      statusWords.textContent = "Update installed — click to restart";
      statusWords.style.color = "var(--success)";
      statusWords.style.cursor = "pointer";
      statusWords.addEventListener("click", () => relaunch(), { once: true });
    }
  } catch (e) {
    console.error("Update check failed:", e);
    if (manual && statusWords) {
      statusWords.textContent = "Update check failed";
      statusWords.style.color = "var(--error)";
      setTimeout(() => { statusWords.textContent = ""; statusWords.style.color = ""; }, 3000);
    }
  }
}

async function checkForUpdates() {
  const lastCheck = localStorage.getItem("mx-update-last-check");
  const now = Date.now();
  if (lastCheck && now - Number(lastCheck) < 7 * 24 * 60 * 60 * 1000) return;
  localStorage.setItem("mx-update-last-check", String(now));
  await doUpdateCheck(false);
}

// --- Formatting toolbar ---

function applyFormat(fmt: string) {
  const sel = editor.state.selection.main;
  const selected = editor.state.sliceDoc(sel.from, sel.to);
  let insert = "";
  let from = sel.from;
  let to = sel.to;

  switch (fmt) {
    case "bold":
      insert = `**${selected || "bold"}**`;
      break;
    case "italic":
      insert = `*${selected || "italic"}*`;
      break;
    case "heading": {
      const line = editor.state.doc.lineAt(sel.from);
      from = line.from;
      to = line.to;
      insert = `### ${line.text.replace(/^#+\s*/, "")}`;
      break;
    }
    case "link":
      insert = selected ? `[${selected}](url)` : `[link](url)`;
      break;
    case "code":
      insert = `\`${selected || "code"}\``;
      break;
    case "quote": {
      const qline = editor.state.doc.lineAt(sel.from);
      from = qline.from;
      to = qline.to;
      insert = `> ${qline.text}`;
      break;
    }
    case "list": {
      const lline = editor.state.doc.lineAt(sel.from);
      from = lline.from;
      to = lline.to;
      insert = `- ${lline.text}`;
      break;
    }
    case "hr":
      insert = `\n---\n`;
      break;
    default:
      return;
  }

  editor.dispatch({ changes: { from, to, insert } });
  editor.focus();
}

// --- Breadcrumb navigation ---

function updateBreadcrumb() {
  const el = document.getElementById("breadcrumb");
  if (!el) return;
  if (!currentFilePath) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  const parts = currentFilePath.split("/").filter(Boolean);
  const display = parts.slice(-4);
  const startIdx = parts.length - display.length;

  el.innerHTML = display.map((seg, i) => {
    const fullPath = "/" + parts.slice(0, startIdx + i + 1).join("/");
    const span = `<span data-path="${fullPath.replace(/"/g, "&quot;")}">${escapeHtml(seg)}</span>`;
    return i < display.length - 1 ? span + '<span class="sep">/</span>' : span;
  }).join("");

  el.querySelectorAll("span:not(.sep)").forEach(span => {
    const s = span as HTMLElement;
    const isLast = !s.nextElementSibling || !s.nextElementSibling.classList.contains("sep");
    if (!isLast) {
      s.addEventListener("click", () => openFolder(s.dataset.path!));
    }
  });
}

// --- Scroll sync ---

let scrollSyncSource: "editor" | "preview" | null = null;
let scrollSyncTimer: ReturnType<typeof setTimeout> | null = null;

function initScrollSync() {
  const previewPane = document.getElementById("preview-pane");
  const editorScroll = editor.scrollDOM;
  if (!previewPane || !editorScroll) return;

  // Track which pane the user is hovering over
  editorScroll.addEventListener("mouseenter", () => { scrollSyncSource = "editor"; });
  previewPane.addEventListener("mouseenter", () => { scrollSyncSource = "preview"; });

  editorScroll.addEventListener("scroll", () => {
    if (!scrollSyncEnabled || isScrollSyncing || currentViewMode !== "split") return;
    if (scrollSyncSource !== "editor") return;
    isScrollSyncing = true;
    const pct = editorScroll.scrollTop / Math.max(1, editorScroll.scrollHeight - editorScroll.clientHeight);
    previewPane.scrollTop = pct * (previewPane.scrollHeight - previewPane.clientHeight);
    if (scrollSyncTimer) clearTimeout(scrollSyncTimer);
    scrollSyncTimer = setTimeout(() => { isScrollSyncing = false; }, 100);
  });

  previewPane.addEventListener("scroll", () => {
    if (!scrollSyncEnabled || isScrollSyncing || currentViewMode !== "split") return;
    if (scrollSyncSource !== "preview") return;
    isScrollSyncing = true;
    const pct = previewPane.scrollTop / Math.max(1, previewPane.scrollHeight - previewPane.clientHeight);
    editorScroll.scrollTop = pct * (editorScroll.scrollHeight - editorScroll.clientHeight);
    if (scrollSyncTimer) clearTimeout(scrollSyncTimer);
    scrollSyncTimer = setTimeout(() => { isScrollSyncing = false; }, 100);
  });
}

// --- Custom preview CSS ---

async function loadCustomCSS() {
  try {
    const css = await invoke<string>("load_custom_css");
    if (!css) return;
    let style = document.getElementById("custom-preview-css") as HTMLStyleElement;
    if (!style) {
      style = document.createElement("style");
      style.id = "custom-preview-css";
      document.head.appendChild(style);
    }
    style.textContent = css;
  } catch { /* ignore */ }
}

// --- Init ---

window.addEventListener("DOMContentLoaded", () => {
  const editorPane = $("#editor-pane");
  if (!editorPane) return;

  // Apply theme before creating editor
  document.documentElement.setAttribute("data-theme", currentThemeMode);

  editor = new EditorView({
    state: EditorState.create({
      doc: SAMPLE_CONTENT,
      extensions: [
        lineNumbersCompartment.of(showLineNumbers ? lineNumbers() : []),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        closeBrackets(),
        foldGutter(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        search(),
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
          { key: "Mod-n", run: () => { newFile(); return true; } },
          { key: "Mod-p", run: () => { togglePreview(); return true; } },
          { key: "Mod-b", run: () => { toggleSidebar(); return true; } },
          { key: "Mod-e", run: () => { toggleReadMode(); return true; } },
          { key: "Mod-Shift-c", run: () => { copyFormattedHTML(); return true; } },
          { key: "Mod-Shift-p", run: () => { toggleCommandPalette(); return true; } },
          { key: "Mod-Shift-f", run: () => { openFileSearch(); return true; } },
          { key: "Mod-Alt-f", run: () => { sidebarSearchMode ? deactivateSidebarSearch() : activateSidebarSearch(); return true; } },
          { key: "Mod-=", run: () => { zoomIn(); return true; } },
          { key: "Mod--", run: () => { zoomOut(); return true; } },
          { key: "Mod-0", run: () => { zoomReset(); return true; } },
          { key: "Mod-/", run: () => { toggleHelp(); return true; } },
        ]),
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.docChanged || update.selectionSet) {
            if (update.docChanged) onContentChange(update.view);
            updateCursorPosition(update.view);
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
    hideContextMenu();
  });

  // File menu items
  document.getElementById("btn-new")?.addEventListener("click", () => newFile());
  document.getElementById("btn-open")?.addEventListener("click", () => openFileDialog());
  document.getElementById("btn-open-folder")?.addEventListener("click", () => openFolder());
  document.getElementById("btn-recent")?.addEventListener("click", () => toggleRecentPanel());
  document.getElementById("btn-save")?.addEventListener("click", () => saveFile());
  document.getElementById("btn-autosave")?.addEventListener("click", () => toggleAutoSave());
  document.getElementById("btn-export-pdf")?.addEventListener("click", () => exportPDF());
  document.getElementById("btn-export-html")?.addEventListener("click", () => exportHTML());
  document.getElementById("btn-export-docx")?.addEventListener("click", () => exportDOCX());

  // View menu items
  document.getElementById("btn-toggle-sidebar")?.addEventListener("click", () => toggleSidebar());
  document.getElementById("btn-toggle-preview")?.addEventListener("click", () => togglePreview());
  document.getElementById("btn-read-mode")?.addEventListener("click", () => toggleReadMode());
  document.getElementById("btn-toggle-outline")?.addEventListener("click", () => toggleOutline());
  document.getElementById("btn-toggle-linenumbers")?.addEventListener("click", () => toggleLineNumbers());
  document.getElementById("btn-zen-mode")?.addEventListener("click", () => toggleZenMode());

  // Font menu
  document.getElementById("btn-font-menu")?.addEventListener("click", () => cycleFont());

  // Format bar
  document.querySelectorAll(".fmt-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const fmt = (btn as HTMLElement).dataset.fmt;
      if (fmt) applyFormat(fmt);
    });
  });

  // Theme
  document.getElementById("btn-theme")?.addEventListener("click", () => cycleTheme());

  // Help menu items
  document.getElementById("btn-keyboard-shortcuts")?.addEventListener("click", toggleHelp);
  document.getElementById("btn-check-updates")?.addEventListener("click", () => doUpdateCheck(true));
  document.getElementById("btn-about")?.addEventListener("click", () => {
    invoke("plugin:opener|open_url", { url: "https://github.com/vibery-studio/mx" });
  });

  // Theme icon button
  document.getElementById("btn-theme-icon")?.addEventListener("click", () => cycleTheme());

  // Copy mode buttons
  document.getElementById("btn-copy-formatted")?.addEventListener("click", () => copyFormattedHTML());
  document.getElementById("btn-copy-raw")?.addEventListener("click", () => copyRawMarkdown());
  document.getElementById("btn-copy-plain")?.addEventListener("click", () => copyPlainText());

  // Primary toolbar buttons
  document.getElementById("btn-copy-html")?.addEventListener("click", copyFormattedHTML);
  document.getElementById("btn-zoom-in")?.addEventListener("click", zoomIn);
  document.getElementById("btn-zoom-out")?.addEventListener("click", zoomOut);

  // Sidebar action buttons
  document.getElementById("btn-sidebar-new-file")?.addEventListener("click", async () => {
    if (!currentFolderPath) {
      await openFolder();
      if (!currentFolderPath) return;
    }
    const name = await showInputDialog("File name:", "untitled.md");
    if (!name) return;
    try {
      await invoke("create_file", { path: `${currentFolderPath}/${name}` });
      refreshSidebar();
      openFile(`${currentFolderPath}/${name}`);
    } catch (e) {
      flashStatus(`Error: ${e}`, "var(--error)", 3000);
    }
  });
  document.getElementById("btn-sidebar-new-folder")?.addEventListener("click", async () => {
    if (!currentFolderPath) {
      await openFolder();
      if (!currentFolderPath) return;
    }
    const name = await showInputDialog("Folder name:");
    if (!name) return;
    invoke("create_directory", { path: `${currentFolderPath}/${name}` }).then(() => {
      refreshSidebar();
    }).catch(e => flashStatus(`Error: ${e}`, "var(--error)", 3000));
  });
  document.getElementById("btn-sidebar-outline")?.addEventListener("click", () => toggleOutline());
  document.getElementById("btn-sidebar-close")?.addEventListener("click", () => toggleSidebar());

  // Sidebar search button
  document.getElementById("btn-sidebar-search")?.addEventListener("click", () => {
    if (sidebarSearchMode) deactivateSidebarSearch();
    else activateSidebarSearch();
  });

  // Sidebar search input — debounced
  document.getElementById("sidebar-search-input")?.addEventListener("input", (e) => {
    if (sidebarSearchDebounce) clearTimeout(sidebarSearchDebounce);
    sidebarSearchDebounce = setTimeout(() => {
      doSidebarSearch((e.target as HTMLInputElement).value);
    }, 300);
  });

  // Arrow key nav + Escape in sidebar search
  document.getElementById("sidebar-search-input")?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      sidebarSearchSelectedIndex = Math.min(sidebarSearchSelectedIndex + 1, sidebarSearchResults.length - 1);
      renderSidebarSearchResults();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sidebarSearchSelectedIndex = Math.max(sidebarSearchSelectedIndex - 1, 0);
      renderSidebarSearchResults();
    } else if (e.key === "Enter") {
      e.preventDefault();
      openSidebarSearchResult(sidebarSearchSelectedIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      deactivateSidebarSearch();
    }
  });

  // Sidebar title click → exit search mode
  document.getElementById("sidebar-title")?.addEventListener("click", () => {
    if (sidebarSearchMode) deactivateSidebarSearch();
  });

  // Context menu items
  document.getElementById("ctx-new-file")?.addEventListener("click", ctxNewFile);
  document.getElementById("ctx-new-folder")?.addEventListener("click", ctxNewFolder);
  document.getElementById("ctx-rename")?.addEventListener("click", ctxRename);
  document.getElementById("ctx-duplicate")?.addEventListener("click", ctxDuplicate);
  document.getElementById("ctx-copy-absolute")?.addEventListener("click", ctxCopyAbsolutePath);
  document.getElementById("ctx-copy-relative")?.addEventListener("click", ctxCopyRelativePath);
  document.getElementById("ctx-reveal")?.addEventListener("click", ctxReveal);
  document.getElementById("ctx-delete")?.addEventListener("click", ctxDelete);

  // Command palette
  document.getElementById("palette-input")?.addEventListener("input", (e) => {
    paletteSelectedIndex = 0;
    renderPaletteResults((e.target as HTMLInputElement).value);
  });
  document.getElementById("palette-input")?.addEventListener("keydown", handlePaletteKey);
  document.getElementById("palette-backdrop")?.addEventListener("click", toggleCommandPalette);

  // File search
  document.getElementById("filesearch-input")?.addEventListener("input", (e) => {
    fileSearchSelectedIndex = 0;
    renderFileSearchResults((e.target as HTMLInputElement).value);
  });
  document.getElementById("filesearch-input")?.addEventListener("keydown", handleFileSearchKey);
  document.getElementById("filesearch-backdrop")?.addEventListener("click", closeFileSearch);

  // Help modal
  document.getElementById("status-help")?.addEventListener("click", toggleHelp);
  document.getElementById("help-close")?.addEventListener("click", toggleHelp);
  document.getElementById("help-backdrop")?.addEventListener("click", toggleHelp);

  // Divider drag
  initDividerDrag();

  // Sidebar resize
  initSidebarResize();

  // Tauri drag & drop
  initDragDrop();

  // Listen for file open events (double-click .md in Finder, warm start)
  listen<string>("open-file", (event) => {
    openFile(event.payload);
  });

  // Check for file passed on cold start, then session restore
  invoke<string | null>("get_initial_file").then((path) => {
    if (path) {
      openFile(path);
    } else {
      const lastFile = localStorage.getItem("mx-last-file");
      if (lastFile) openFile(lastFile);
    }
  });

  // Image lightbox — click images in preview to zoom
  $("#preview-pane")?.addEventListener("click", (e) => {
    const img = (e.target as HTMLElement).closest("img");
    if (img) {
      e.preventDefault();
      e.stopPropagation();
      showImageLightbox(img.getAttribute("src") || "");
    }
  });

  // Image paste from clipboard
  editor.dom.addEventListener("paste", (e) => handleImagePaste(e as ClipboardEvent));

  // Zen mode keyboard shortcut
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "z") {
      e.preventDefault();
      toggleZenMode();
    }
  });

  // Preview pane link clicks — same-file anchors, cross-file/folder .md links, external URLs
  $("#preview-pane")?.addEventListener("click", (e) => {
    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor) return;
    e.preventDefault();
    const href = anchor.getAttribute("href");
    if (!href) return;

    if (/^https?:\/\//.test(href)) {
      invoke("plugin:opener|open_url", { url: href });
      return;
    }

    // Split href into file path and anchor fragment
    const hashIdx = href.indexOf("#");
    const filePart = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
    const fragment = hashIdx >= 0 ? href.slice(hashIdx + 1) : "";

    // Same-file anchor navigation (e.g. #heading-name or #table-anchor)
    if (!filePart) {
      scrollPreviewToAnchor(fragment);
      return;
    }

    const textExts = [".md", ".markdown", ".txt", ".yaml", ".yml", ".json", ".toml", ".xml", ".csv", ".log"];
    // Extract extension from file part only (not from the fragment)
    const ext = filePart.includes(".") ? "." + filePart.split(".").pop()!.toLowerCase() : "";
    if (!textExts.includes(ext)) return;

    if (currentFilePath) {
      const dir = currentFilePath.substring(0, currentFilePath.lastIndexOf("/"));
      // Normalize relative paths (handles ../ and cross-folder navigation)
      const resolved = new URL(filePart, "file://" + dir + "/").pathname;
      openFile(resolved).then(async () => {
        if (fragment) {
          // Cancel pending debounce and render immediately so the anchor exists in the DOM
          if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
          await updatePreview(editor.state.doc.toString());
          scrollPreviewToAnchor(fragment);
        }
      });
    }
  });

  // Copy-link buttons on headings — copies #anchor-id to clipboard
  $("#preview-pane")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".heading-copy-link") as HTMLElement | null;
    if (!btn) return;
    e.stopPropagation();
    const anchor = btn.dataset.anchor;
    if (!anchor) return;
    navigator.clipboard.writeText("#" + anchor).then(() => {
      btn.classList.add("copied");
      setTimeout(() => btn.classList.remove("copied"), 1500);
    });
  });

  // GitHub link
  document.getElementById("status-github")?.addEventListener("click", (e) => {
    e.preventDefault();
    invoke("plugin:opener|open_url", { url: "https://github.com/vibery-studio/mx" });
  });

  // Initial render
  updateCursorPosition(editor);
  updatePreview(SAMPLE_CONTENT);
  updateWordCount(SAMPLE_CONTENT);
  updateAutoSaveUI();
  updateLineNumbersUI();

  // Update theme label
  const themeLabel = document.getElementById("btn-theme-label");
  if (themeLabel) {
    const labels: Record<ThemeMode, string> = { auto: "System", light: "Light", dark: "Dark" };
    themeLabel.textContent = `Theme: ${labels[currentThemeMode]}`;
  }

  // Restore last folder in sidebar
  if (currentFolderPath) {
    const sidebar = document.getElementById("sidebar");
    const sidebarSaved = localStorage.getItem("mx-sidebar");
    // Show sidebar unless user explicitly closed it
    if (sidebar && sidebarSaved !== "false") {
      sidebar.classList.remove("hidden");
    }
    loadDirectory(currentFolderPath);
    updateSidebarTitle(currentFolderPath);
    startFolderWatch(currentFolderPath);
  }

  // Restore view mode
  if (currentViewMode !== "split") setViewMode(currentViewMode);

  // Restore outline
  if (localStorage.getItem("mx-outline") === "true") toggleOutline();

  // Restore zen mode
  if (localStorage.getItem("mx-zen") === "true") toggleZenMode();

  // Start recovery timer
  scheduleRecovery();

  // Check for crash recovery
  setTimeout(checkRecovery, 500);

  // Check for updates after 3s
  setTimeout(checkForUpdates, 3000);

  // Scroll sync
  initScrollSync();

  // Custom preview CSS
  loadCustomCSS();

  // Apply saved font
  applyFont();
});
