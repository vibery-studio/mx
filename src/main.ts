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

const windowLabel = getCurrentWindow().label;
const isMainWindow = windowLabel === "main";

// --- Tab state ---

interface Tab {
  id: string;
  filePath: string | null;
  title: string;
  editorState: EditorState;
  scrollTop: number;
  previewScrollTop: number;
  isModified: boolean;
}

let tabs: Tab[] = [];
let activeTabId: string | null = null;

function getActiveTab(): Tab | null {
  return tabs.find(t => t.id === activeTabId) ?? null;
}

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

// Git state
interface GitFileStatus { path: string; status: string; }
interface GitRepoInfo { is_repo: boolean; branch: string; remote_url: string | null; ahead: number; behind: number; }
interface GitLogEntry { id: string; message: string; author: string; timestamp: number; }
interface GitSyncResult { committed: boolean; pushed: boolean; pulled: boolean; message: string; conflicts: string[]; }

let gitStatusMap: Map<string, string> = new Map();
let gitRepoInfo: GitRepoInfo | null = null;
let autoSyncEnabled = localStorage.getItem("mx-auto-sync") === "true";
let gitRefreshDebounce: ReturnType<typeof setTimeout> | null = null;
const RECOVERY_INTERVAL = 30000;

// Line numbers state
let showLineNumbers = localStorage.getItem("mx-line-numbers") !== "false";
const lineNumbersCompartment = new Compartment();
const keymapCompartment = new Compartment();

// Font selection state
const FONT_OPTIONS = ["System", "Inter", "Georgia", "Merriweather", "JetBrains Mono"] as const;
let currentFont: string = localStorage.getItem("mx-font") || "System";

// Scroll sync state
let scrollSyncEnabled = true;
let isScrollSyncing = false;

// Context menu state
let contextMenuTarget: { path: string; isDir: boolean; parentPath: string } | null = null;
let activeSidebarDir: string | null = null; // last clicked/expanded directory in sidebar

// --- Keybinding registry ---

interface ShortcutDef {
  id: string;
  label: string;
  group: string;
  defaultKey: string;
  action: () => void;
  global?: boolean; // handled via document keydown, not CM6
}

// Action map - functions are assigned after they're defined
const actions: Record<string, () => void> = {};

function getDefaultBindings(): ShortcutDef[] {
  return [
    { id: "file.new", label: "New File", group: "File", defaultKey: "Mod-n", action: actions["file.new"] },
    { id: "file.open", label: "Open File", group: "File", defaultKey: "Mod-o", action: actions["file.open"] },
    { id: "file.save", label: "Save", group: "File", defaultKey: "Mod-s", action: actions["file.save"] },
    { id: "file.close-tab", label: "Close Tab", group: "File", defaultKey: "Mod-w", action: actions["file.close-tab"] },
    { id: "file.new-window", label: "New Window", group: "File", defaultKey: "Mod-Shift-N", action: actions["file.new-window"], global: true },
    { id: "view.toggle-preview", label: "Toggle Preview", group: "View", defaultKey: "Mod-p", action: actions["view.toggle-preview"] },
    { id: "view.read-mode", label: "Read Mode", group: "View", defaultKey: "Mod-e", action: actions["view.read-mode"] },
    { id: "view.toggle-sidebar", label: "Toggle Sidebar", group: "View", defaultKey: "Mod-b", action: actions["view.toggle-sidebar"] },
    { id: "view.zen-mode", label: "Zen Mode", group: "View", defaultKey: "Mod-Shift-z", action: actions["view.zen-mode"], global: true },
    { id: "view.zoom-in", label: "Zoom In", group: "View", defaultKey: "Mod-=", action: actions["view.zoom-in"] },
    { id: "view.zoom-out", label: "Zoom Out", group: "View", defaultKey: "Mod--", action: actions["view.zoom-out"] },
    { id: "view.zoom-reset", label: "Zoom Reset", group: "View", defaultKey: "Mod-0", action: actions["view.zoom-reset"] },
    { id: "edit.copy-formatted", label: "Copy Formatted", group: "Edit", defaultKey: "Mod-Shift-c", action: actions["edit.copy-formatted"] },
    { id: "search.command-palette", label: "Command Palette", group: "Search", defaultKey: "Mod-Shift-p", action: actions["search.command-palette"] },
    { id: "search.file-search", label: "File Search", group: "Search", defaultKey: "Mod-Shift-f", action: actions["search.file-search"] },
    { id: "search.content-search", label: "Content Search", group: "Search", defaultKey: "Mod-Alt-f", action: actions["search.content-search"] },
    { id: "help.shortcuts", label: "Keyboard Shortcuts", group: "Help", defaultKey: "Mod-/", action: actions["help.shortcuts"] },
  ];
}

function getCustomBindings(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem("mx-keybindings") || "{}"); }
  catch { return {}; }
}

function getBinding(id: string): string {
  const custom = getCustomBindings();
  if (id in custom) return custom[id];
  const def = getDefaultBindings().find(d => d.id === id);
  return def?.defaultKey ?? "";
}

function setCustomBinding(id: string, key: string) {
  const custom = getCustomBindings();
  const def = getDefaultBindings().find(d => d.id === id);
  if (def && key === def.defaultKey) {
    delete custom[id]; // back to default, no need to store
  } else {
    custom[id] = key;
  }
  localStorage.setItem("mx-keybindings", JSON.stringify(custom));
  applyBindings();
}

function resetAllBindings() {
  localStorage.removeItem("mx-keybindings");
  applyBindings();
}

function findConflict(key: string, excludeId: string): ShortcutDef | null {
  if (!key) return null;
  const bindings = getDefaultBindings();
  for (const def of bindings) {
    if (def.id === excludeId) continue;
    if (getBinding(def.id).toLowerCase() === key.toLowerCase()) return def;
  }
  return null;
}

const OS_RESERVED = new Set(["mod-q", "mod-h", "mod-m", "mod-,", "mod-tab"]);

function isOSReserved(key: string): boolean {
  return OS_RESERVED.has(key.toLowerCase());
}

function keyEventToCM6(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("Mod");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");

  let key = e.key;
  // Normalize key names
  if (key === " ") key = "Space";
  else if (key === "ArrowUp") key = "Up";
  else if (key === "ArrowDown") key = "Down";
  else if (key === "ArrowLeft") key = "Left";
  else if (key === "ArrowRight") key = "Right";
  // Don't include modifier keys alone
  if (["Control", "Meta", "Shift", "Alt"].includes(key)) return "";
  parts.push(key.length === 1 ? key.toLowerCase() : key);
  return parts.join("-");
}

function cm6KeyToDisplay(key: string): string {
  if (!key) return "";
  return key
    .replace(/Mod/g, "\u2318")
    .replace(/Shift/g, "\u21E7")
    .replace(/Alt/g, "\u2325")
    .replace(/-/g, "")
    .replace(/\b([a-z])\b/g, (_, c) => c.toUpperCase());
}

function cm6KeyMatchesEvent(cm6Key: string, e: KeyboardEvent): boolean {
  if (!cm6Key) return false;
  const parts = cm6Key.split("-");
  const needMod = parts.includes("Mod");
  const needShift = parts.includes("Shift");
  const needAlt = parts.includes("Alt");
  const keyPart = parts.filter(p => p !== "Mod" && p !== "Shift" && p !== "Alt").join("-");

  if (needMod !== (e.metaKey || e.ctrlKey)) return false;
  if (needShift !== e.shiftKey) return false;
  if (needAlt !== e.altKey) return false;

  const eventKey = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return eventKey === keyPart || eventKey.toLowerCase() === keyPart.toLowerCase();
}

function buildKeymap() {
  const bindings = getDefaultBindings().filter(d => !d.global);
  const km: { key: string; run: () => boolean }[] = [];
  for (const def of bindings) {
    const key = getBinding(def.id);
    if (key && def.action) {
      km.push({ key, run: () => { def.action(); return true; } });
    }
  }
  return keymap.of(km);
}

let globalKeyHandler: ((e: KeyboardEvent) => void) | null = null;

function applyBindings() {
  // Reconfigure CM6 keymap
  if (editor) {
    editor.dispatch({ effects: keymapCompartment.reconfigure(buildKeymap()) });
  }

  // Replace global keydown handler
  if (globalKeyHandler) {
    document.removeEventListener("keydown", globalKeyHandler);
  }
  const globalBindings = getDefaultBindings().filter(d => d.global);
  globalKeyHandler = (e: KeyboardEvent) => {
    for (const def of globalBindings) {
      const key = getBinding(def.id);
      if (key && cm6KeyMatchesEvent(key, e) && def.action) {
        e.preventDefault();
        def.action();
        return;
      }
    }
  };
  document.addEventListener("keydown", globalKeyHandler);

  // Re-render shortcuts modal if open
  renderShortcutsContent();
}

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

// --- Obsidian-style callouts ---
// Transforms blockquotes starting with [!type] into styled callout boxes

const CALLOUT_ICONS: Record<string, string> = {
  note: "📝", info: "ℹ️", tip: "💡", hint: "💡", important: "❗",
  success: "✅", check: "✅", done: "✅", question: "❓", help: "❓",
  warning: "⚠️", caution: "⚠️", attention: "⚠️",
  danger: "🔴", failure: "❌", fail: "❌", error: "❌",
  bug: "🐛", example: "📋", quote: "💬", cite: "💬", abstract: "📄",
  summary: "📄", tldr: "📄",
};

function renderCallouts(html: string): string {
  // markdown-it renders blockquotes as <blockquote>\n<p>[!type] title\ncontent</p>\n</blockquote>
  // With breaks:true, newlines become <br>\n
  return html.replace(
    /<blockquote>\s*<p>\[!([\w-]+)\]\s*(.*?)(?:<br>|\n)([\s\S]*?)<\/p>([\s\S]*?)<\/blockquote>/g,
    (_match, type: string, title: string, firstContent: string, rest: string) => {
      const t = type.toLowerCase();
      const icon = CALLOUT_ICONS[t] || "📌";
      const displayTitle = title.trim() || type.charAt(0).toUpperCase() + type.slice(1);
      const content = (firstContent + rest).trim();
      return `<div class="callout callout-${t}"><div class="callout-title">${icon} ${displayTitle}</div><div class="callout-content"><p>${content}</p></div></div>`;
    }
  );
}

// --- Interactive checklists ---

function renderChecklists(html: string): string {
  let idx = 0;
  return html.replace(
    /<li>([\s\S]*?)<\/li>/g,
    (_match, inner: string) => {
      const checkedMatch = inner.match(/^\s*\[([ xX])\]\s*/);
      if (!checkedMatch) return `<li>${inner}</li>`;
      const checked = checkedMatch[1] !== " ";
      const content = inner.replace(/^\s*\[[ xX]\]\s*/, "");
      const id = idx++;
      return `<li class="task-item"><input type="checkbox" class="task-check" data-idx="${id}" ${checked ? "checked" : ""} /><span>${content}</span></li>`;
    }
  );
}

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
    const lk = key.toLowerCase();
    // Render tags/categories/keywords as styled labels
    if ((lk === "tags" || lk === "tag" || lk === "categories" || lk === "keywords") && value) {
      const tags = value.split(",").map(t => t.trim()).filter(Boolean);
      const tagHtml = tags.map(t =>
        `<span class="fm-tag" data-tag="${escapeHtml(t)}">${escapeHtml(t)}<button class="fm-tag-remove" data-tag="${escapeHtml(t)}">×</button></span>`
      ).join("");
      return `<div class="fm-row"><span class="fm-key">${escapeHtml(key)}</span><span class="fm-val fm-tags">${tagHtml}</span></div>`;
    }
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
  html = renderCallouts(html);
  html = renderChecklists(html);
  html = renderKaTeX(html);
  html = processMermaidBlocks(html);
  previewPane.innerHTML = html;
  await renderMermaidDivs();
  // Wire up interactive checklists
  previewPane.querySelectorAll(".task-check").forEach(cb => {
    cb.addEventListener("change", () => {
      const input = cb as HTMLInputElement;
      const checked = input.checked;
      // Find the nth checkbox in source and toggle it
      const doc = editor.state.doc.toString();
      let idx = 0;
      const targetIdx = parseInt(input.dataset.idx || "0");
      const regex = /- \[( |x|X)\]/g;
      let match;
      while ((match = regex.exec(doc)) !== null) {
        if (idx === targetIdx) {
          const from = match.index + 3;
          const to = from + 1;
          const replacement = checked ? "x" : " ";
          editor.dispatch({ changes: { from, to, insert: replacement } });
          break;
        }
        idx++;
      }
    });
  });
  // Wire up tag remove buttons
  previewPane.querySelectorAll(".fm-tag-remove").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const tag = (btn as HTMLElement).dataset.tag;
      if (!tag) return;
      const doc = editor.state.doc.toString();
      // Find and remove the tag line "  - tagname" in frontmatter
      const tagLineRegex = new RegExp(`^([ \\t]+- ${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*$`, "m");
      const match = tagLineRegex.exec(doc);
      if (match) {
        const from = match.index;
        const to = from + match[0].length + 1; // +1 for newline
        editor.dispatch({ changes: { from, to: Math.min(to, doc.length), insert: "" } });
      }
    });
  });
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
  try { await invoke("unwatch_folder"); } catch (e) { console.warn("unwatch_folder failed:", e); }
  if (path) {
    try { await invoke("watch_folder", { path }); } catch (e) { console.warn("watch_folder failed:", e); }
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
  const tab = getActiveTab();
  if (tab && tab.isModified !== value) {
    tab.isModified = value;
    renderTabs();
  }
}

// --- File operations ---

function setFilename(path: string | null) {
  currentFilePath = path;
  const el = document.getElementById("filename");
  if (el) el.textContent = path ? path.split("/").pop()! : "No file open";
  if (path) localStorage.setItem("mx-last-file", path);
  else localStorage.removeItem("mx-last-file");
  const tab = getActiveTab();
  if (tab) {
    tab.filePath = path;
    tab.title = path ? path.split("/").pop()! : "Untitled";
    renderTabs();
  }
  updateBreadcrumb();
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
      persistOpenTabs();
      if (autoSyncEnabled && currentFolderPath) gitAutoSync(path);
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
    persistOpenTabs();
    if (autoSyncEnabled && currentFolderPath) gitAutoSync(currentFilePath);
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
  // Check if file is already open in a tab
  const existingTab = tabs.find(t => t.filePath === path);
  if (existingTab) {
    switchToTab(existingTab.id);
    return;
  }

  try {
    saveScrollPosition();
    const result = await invoke<{ path: string; content: string }>("read_file", { path });

    // Check again after async (race condition guard)
    const existingAfter = tabs.find(t => t.filePath === result.path);
    if (existingAfter) {
      switchToTab(existingAfter.id);
      return;
    }

    // Save current tab state before switching
    saveActiveTabState();

    const tab = createTab(result.path, result.content);
    tabs.push(tab);
    activeTabId = tab.id;
    currentFilePath = result.path;

    editor.setState(tab.editorState);
    setFilename(result.path);
    setModified(false);
    addRecentFile(result.path);
    deleteRecoveryForCurrent(); // clean up stale recovery for this file
    renderTabs();
    persistOpenTabs();
    // Use result.content directly to avoid stale editor state on Windows
    updatePreview(result.content);
    updateWordCount(result.content);
    updateCursorPosition(editor);
    startFileWatch(result.path);
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
    // No folder — create a new untitled tab
    saveActiveTabState();
    const tab = createTab(null, "");
    tabs.push(tab);
    activeTabId = tab.id;
    currentFilePath = null;
    editor.setState(tab.editorState);
    setFilename(null);
    setModified(false);
    renderTabs();
    persistOpenTabs();
    updatePreview(editor.state.doc.toString());
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

// --- Git integration ---

async function refreshGitStatus() {
  if (!currentFolderPath) return;
  try {
    const info = await invoke<GitRepoInfo>("git_repo_info", { folderPath: currentFolderPath });
    gitRepoInfo = info;
    if (!info.is_repo) { gitStatusMap.clear(); updateGitUI(); return; }
    const statuses = await invoke<GitFileStatus[]>("git_status", { folderPath: currentFolderPath });
    gitStatusMap.clear();
    for (const s of statuses) gitStatusMap.set(s.path, s.status);
    updateGitUI();
    updateTreeGitDots();
  } catch { /* ignore non-git folders */ }
}

function debounceGitRefresh() {
  if (gitRefreshDebounce) clearTimeout(gitRefreshDebounce);
  gitRefreshDebounce = setTimeout(() => refreshGitStatus(), 500);
}

function updateTreeGitDots() {
  if (!currentFolderPath) return;
  const repoRoot = gitRepoInfo ? currentFolderPath : null;
  if (!repoRoot) return;
  document.querySelectorAll("#sidebar-tree .tree-item").forEach(el => {
    const itemEl = el as HTMLElement;
    const filePath = itemEl.dataset.path;
    if (!filePath) return;
    // Remove existing dot
    itemEl.querySelector(".git-dot")?.remove();
    // Compute relative path from folder root
    const rel = filePath.startsWith(repoRoot + "/") ? filePath.slice(repoRoot.length + 1) : filePath;
    const status = gitStatusMap.get(rel);
    if (status) {
      const dot = document.createElement("span");
      dot.className = `git-dot git-${status}`;
      itemEl.appendChild(dot);
    }
  });
}

function updateGitUI() {
  // Status bar branch
  const branchEl = document.getElementById("status-branch");
  if (branchEl) {
    if (gitRepoInfo?.is_repo) {
      branchEl.classList.remove("hidden");
      if (gitRepoInfo.remote_url) {
        // Connected to remote — show sync status
        if (gitRepoInfo.ahead > 0) {
          branchEl.textContent = `⟳ ${gitRepoInfo.ahead} unsaved`;
        } else {
          branchEl.textContent = "✓ Synced";
        }
      } else {
        branchEl.textContent = "Local only";
      }
    } else {
      branchEl.classList.add("hidden");
    }
  }

  // Git panel
  const gitPanel = document.getElementById("git-panel");
  const syncSetup = document.getElementById("sync-setup");
  const syncStatus = document.getElementById("sync-status");
  const changedFiles = document.getElementById("git-changed-files");
  const commitArea = document.getElementById("git-commit-area");
  const panelHeader = document.getElementById("git-panel-header");

  if (gitPanel) {
    if (!gitRepoInfo?.is_repo) {
      // Not a repo — show setup prompt
      if (syncSetup) syncSetup.classList.remove("hidden");
      if (changedFiles) changedFiles.innerHTML = "";
      if (commitArea) commitArea.style.display = "none";
      if (panelHeader) panelHeader.style.display = "none";
      if (syncStatus) syncStatus.textContent = "";
    } else if (!gitRepoInfo.remote_url) {
      // Repo but no remote — show setup
      if (syncSetup) syncSetup.classList.remove("hidden");
      if (commitArea) commitArea.style.display = "";
      if (panelHeader) panelHeader.style.display = "none";
      if (syncStatus) { syncStatus.textContent = "Not connected to cloud"; syncStatus.className = ""; }
      populateChangedFiles(changedFiles);
    } else {
      // Connected — show full panel
      if (syncSetup) syncSetup.classList.add("hidden");
      if (commitArea) commitArea.style.display = "";
      if (panelHeader) panelHeader.style.display = "";
      const branchName = document.getElementById("git-branch-name");
      if (branchName) branchName.textContent = gitRepoInfo.branch;
      if (syncStatus) {
        if (gitStatusMap.size === 0 && gitRepoInfo.ahead === 0) {
          syncStatus.textContent = "✓ All synced";
          syncStatus.className = "synced";
        } else if (gitRepoInfo.ahead > 0) {
          syncStatus.textContent = `${gitRepoInfo.ahead} changes waiting to sync`;
          syncStatus.className = "";
        } else {
          syncStatus.textContent = `${gitStatusMap.size} unsaved changes`;
          syncStatus.className = "";
        }
      }
      populateChangedFiles(changedFiles);
    }
  }

  // Auto-sync label
  const syncLabel = document.getElementById("autosync-git-label");
  if (syncLabel) syncLabel.textContent = autoSyncEnabled ? "On" : "Off";
}

function populateChangedFiles(container: HTMLElement | null) {
  if (!container) return;
  container.innerHTML = "";
  gitStatusMap.forEach((status, path) => {
    const item = document.createElement("div");
    item.className = "git-file-item";
    const dot = document.createElement("span");
    dot.className = `git-dot git-${status}`;
    const name = document.createElement("span");
    name.className = "git-file-name";
    name.textContent = path;
    name.title = path;
    item.appendChild(dot);
    item.appendChild(name);
    item.addEventListener("click", () => {
      if (currentFolderPath) openFile(currentFolderPath + "/" + path);
    });
    container.appendChild(item);
  });
  if (gitStatusMap.size === 0) {
    container.innerHTML = '<div class="git-empty">No changes</div>';
  }
}

function toggleAutoSync() {
  autoSyncEnabled = !autoSyncEnabled;
  localStorage.setItem("mx-auto-sync", String(autoSyncEnabled));
  updateGitUI();
  flashStatus(`Auto-sync ${autoSyncEnabled ? "enabled" : "disabled"}`, "var(--accent)");
}

function gitAutoSync(filePath: string) {
  if (!filePath || !currentFolderPath) return;
  // Fire-and-forget — don't block the editor
  invoke<GitSyncResult>("git_auto_sync", {
    folderPath: currentFolderPath,
    filePath: filePath,
  }).then(result => {
    if (result.conflicts.length > 0) {
      flashStatus(`${result.conflicts.length} files need attention`, "var(--error)", 5000);
      if (currentFolderPath) showConflictResolver(currentFolderPath + "/" + result.conflicts[0]);
    } else if (result.pushed) {
      flashStatus("✓ Synced", "var(--success)");
    }
    debounceGitRefresh();
  }).catch(() => { /* silent — don't interrupt typing */ });
}

async function gitManualCommit() {
  if (!currentFolderPath) return;
  const input = document.getElementById("git-commit-input") as HTMLInputElement | null;
  const userMsg = input?.value?.trim();
  // Auto-generate message from changed files if empty
  const message = userMsg || (() => {
    const count = gitStatusMap.size;
    if (count === 0) return "Update files";
    if (count === 1) {
      const [path, status] = [...gitStatusMap.entries()][0];
      const name = path.split("/").pop() || path;
      return status === "new" ? `Add ${name}` : `Update ${name}`;
    }
    return `Update ${count} files`;
  })();
  try {
    await invoke<string>("git_commit", { folderPath: currentFolderPath, files: [], message });
    if (input) input.value = "";
    flashStatus("✓ Saved", "var(--success)");
    // Push in background
    invoke<string>("git_push", { folderPath: currentFolderPath })
      .then(() => { flashStatus("✓ Synced", "var(--success)"); debounceGitRefresh(); })
      .catch(() => debounceGitRefresh());
  } catch (e) {
    flashStatus(`Save failed: ${e}`, "var(--error)", 3000);
  }
}

function gitSync() {
  if (!currentFolderPath) return;
  const folder = currentFolderPath;
  flashStatus("Syncing...", "var(--accent)");
  invoke<GitSyncResult>("git_pull", { folderPath: folder }).then(pullResult => {
    if (pullResult.conflicts.length > 0) {
      flashStatus(`${pullResult.conflicts.length} files need attention`, "var(--error)", 5000);
      showConflictResolver(folder + "/" + pullResult.conflicts[0]);
      debounceGitRefresh();
      return;
    }
    invoke<string>("git_push", { folderPath: folder })
      .then(() => flashStatus("✓ All synced", "var(--success)"))
      .catch(() => flashStatus("✓ Up to date", "var(--success)"))
      .finally(() => { debounceGitRefresh(); refreshSidebar(); });
  }).catch(e => {
    flashStatus(`Sync: ${e}`, "var(--error)", 3000);
  });
}

function timeAgo(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString();
}

function showSyncSetup() {
  const modal = document.getElementById("sync-setup-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  // Check auth status
  checkSyncAuth();
}

function hideSyncSetup() {
  document.getElementById("sync-setup-modal")?.classList.add("hidden");
}

async function checkSyncAuth() {
  const statusEl = document.getElementById("sync-auth-status");
  if (!statusEl) return;
  try {
    const hasAuth = await invoke<boolean>("git_check_auth", { remoteUrl: "https://github.com" });
    if (hasAuth) {
      statusEl.textContent = "✓ GitHub connection found";
      statusEl.className = "ok";
    } else {
      statusEl.textContent = "No GitHub credentials found. Run \"gh auth login\" in terminal, or add an SSH key.";
      statusEl.className = "fail";
    }
  } catch {
    statusEl.className = "";
    statusEl.style.display = "none";
  }
}

async function connectSync() {
  if (!currentFolderPath) return;
  const urlInput = document.getElementById("sync-repo-url") as HTMLInputElement;
  const errorEl = document.getElementById("sync-setup-error");
  const btn = document.getElementById("btn-sync-connect") as HTMLButtonElement;
  let url = urlInput?.value?.trim();
  if (!url) { if (errorEl) { errorEl.textContent = "Paste a repository URL"; errorEl.classList.remove("hidden"); } return; }

  // Auto-fix common URL patterns
  if (url.match(/^[\w-]+\/[\w.-]+$/) && !url.includes("://")) {
    url = `https://github.com/${url}.git`; // "user/repo" → full URL
  }
  if (url.startsWith("https://github.com/") && !url.endsWith(".git")) {
    url += ".git";
  }

  if (btn) { btn.disabled = true; btn.textContent = "Connecting..."; }
  if (errorEl) errorEl.classList.add("hidden");

  try {
    const info = await invoke<GitRepoInfo>("git_setup_sync", { folderPath: currentFolderPath, remoteUrl: url });
    gitRepoInfo = info;
    autoSyncEnabled = true;
    localStorage.setItem("mx-auto-sync", "true");
    hideSyncSetup();
    flashStatus("Sync connected!", "var(--success)");
    debounceGitRefresh();
  } catch (e) {
    if (errorEl) {
      errorEl.textContent = `${e}`;
      errorEl.classList.remove("hidden");
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Connect & Sync"; }
  }
}

// --- Conflict resolution (#98) ---

interface GitConflictInfo { path: string; local_content: string; remote_content: string; base_content: string; }
let conflictFilePath: string | null = null;

async function showConflictResolver(filePath: string) {
  if (!currentFolderPath) return;
  conflictFilePath = filePath;
  try {
    const info = await invoke<GitConflictInfo>("git_conflict_info", { folderPath: currentFolderPath, filePath });
    const modal = document.getElementById("conflict-modal");
    const title = document.getElementById("conflict-title");
    const localEl = document.getElementById("conflict-local");
    const remoteEl = document.getElementById("conflict-remote");
    if (!modal || !localEl || !remoteEl) return;
    if (title) title.textContent = `Resolve: ${info.path}`;
    localEl.textContent = info.local_content;
    remoteEl.textContent = info.remote_content;
    modal.classList.remove("hidden");
  } catch (e) {
    flashStatus(`${e}`, "var(--error)", 3000);
  }
}

async function resolveConflict(choice: "local" | "remote" | "both") {
  if (!conflictFilePath || !currentFolderPath) return;
  const localEl = document.getElementById("conflict-local");
  const remoteEl = document.getElementById("conflict-remote");
  if (!localEl || !remoteEl) return;
  let content: string;
  if (choice === "local") content = localEl.textContent || "";
  else if (choice === "remote") content = remoteEl.textContent || "";
  else content = (localEl.textContent || "") + "\n" + (remoteEl.textContent || "");

  try {
    await invoke("git_resolve_conflict", { folderPath: currentFolderPath, filePath: conflictFilePath, content });
    document.getElementById("conflict-modal")?.classList.add("hidden");
    flashStatus("✓ Conflict resolved", "var(--success)");
    // Reload file if open
    if (currentFilePath === conflictFilePath) {
      const info = await invoke<{ content: string }>("read_file", { path: conflictFilePath });
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: info.content } });
      setModified(false);
    }
    debounceGitRefresh();
  } catch (e) {
    flashStatus(`Resolve failed: ${e}`, "var(--error)", 3000);
  }
}

// --- Version history & snapshots (#111) ---

interface SnapshotInfo { file_path: string; timestamp: number; snap_path: string; }
let historyDiffFilePath: string | null = null;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
const SNAPSHOT_INTERVAL = 60000; // auto-snapshot every 60s if changed
let lastSnapshotContent: string = "";

function scheduleSnapshot() {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    if (!currentFilePath) return;
    const content = editor.state.doc.toString();
    if (content !== lastSnapshotContent && content.length > 0) {
      lastSnapshotContent = content;
      invoke("save_snapshot", { filePath: currentFilePath, content }).catch(() => {});
    }
  }, SNAPSHOT_INTERVAL);
}

async function showFileHistory() {
  if (!currentFilePath || !currentFolderPath) return;
  historyDiffFilePath = currentFilePath;
  const modal = document.getElementById("history-modal");
  const list = document.getElementById("history-list");
  const diffView = document.getElementById("history-diff");
  if (!modal || !list || !diffView) return;
  list.classList.remove("hidden");
  diffView.classList.add("hidden");
  // Activate commits tab by default
  document.getElementById("history-tab-commits")?.classList.add("active");
  document.getElementById("history-tab-snapshots")?.classList.remove("active");
  await loadHistoryCommits();
  modal.classList.remove("hidden");
}

async function loadHistoryCommits() {
  if (!historyDiffFilePath || !currentFolderPath) return;
  const list = document.getElementById("history-list");
  if (!list) return;
  list.innerHTML = "";
  try {
    const entries = await invoke<GitLogEntry[]>("git_log", {
      folderPath: currentFolderPath, filePath: historyDiffFilePath, limit: 50
    });
    if (entries.length === 0) {
      list.innerHTML = '<div class="history-empty">No commits for this file</div>';
      return;
    }
    for (const entry of entries) {
      const item = document.createElement("div");
      item.className = "history-item";
      const ago = timeAgo(entry.timestamp);
      item.innerHTML = `<span class="history-actions"><button data-action="view" data-id="${entry.id}">View</button><button data-action="restore" data-id="${entry.id}">Restore</button></span><span class="history-sha">${entry.id}</span> <span class="history-msg">${escapeHtml(entry.message)}</span><br><span class="history-meta">${escapeHtml(entry.author)} · ${ago}</span>`;
      item.querySelector('[data-action="view"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        showHistoryDiff(entry.id, entry.message, "commit");
      });
      item.querySelector('[data-action="restore"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        restoreFromCommit(entry.id);
      });
      list.appendChild(item);
    }
  } catch (e) {
    list.innerHTML = `<div class="history-empty">Error: ${e}</div>`;
  }
}

async function loadHistorySnapshots() {
  if (!historyDiffFilePath) return;
  const list = document.getElementById("history-list");
  if (!list) return;
  list.innerHTML = "";
  try {
    const snaps = await invoke<SnapshotInfo[]>("list_snapshots", { filePath: historyDiffFilePath });
    if (snaps.length === 0) {
      list.innerHTML = '<div class="history-empty">No snapshots yet. Snapshots are saved automatically as you edit.</div>';
      return;
    }
    for (const snap of snaps) {
      const item = document.createElement("div");
      item.className = "history-item";
      const ago = timeAgo(snap.timestamp);
      const date = new Date(snap.timestamp * 1000).toLocaleString();
      item.innerHTML = `<span class="history-actions"><button data-action="view">View</button><button data-action="restore">Restore</button></span><span class="history-sha">snapshot</span> <span class="history-msg">${date}</span><br><span class="history-meta">${ago}</span>`;
      item.querySelector('[data-action="view"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        showSnapshotDiff(snap.snap_path, date);
      });
      item.querySelector('[data-action="restore"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        restoreFromSnapshot(snap.snap_path);
      });
      list.appendChild(item);
    }
  } catch (e) {
    list.innerHTML = `<div class="history-empty">Error: ${e}</div>`;
  }
}

async function showHistoryDiff(commitId: string, label: string, _type: string) {
  if (!historyDiffFilePath || !currentFolderPath) return;
  try {
    const oldContent = await invoke<string>("git_file_at_commit", {
      folderPath: currentFolderPath, filePath: historyDiffFilePath, commitId
    });
    const newContent = editor.state.doc.toString();
    displayHistoryDiff(oldContent, newContent, `${commitId} — ${label}`);
  } catch (e) {
    flashStatus(`${e}`, "var(--error)", 3000);
  }
}

async function showSnapshotDiff(snapPath: string, label: string) {
  try {
    const oldContent = await invoke<string>("read_snapshot", { snapPath });
    const newContent = editor.state.doc.toString();
    displayHistoryDiff(oldContent, newContent, label);
  } catch (e) {
    flashStatus(`${e}`, "var(--error)", 3000);
  }
}

function displayHistoryDiff(oldContent: string, newContent: string, title: string) {
  const list = document.getElementById("history-list");
  const diffView = document.getElementById("history-diff");
  const diffTitle = document.getElementById("history-diff-title");
  const diffOld = document.getElementById("history-diff-old");
  const diffNew = document.getElementById("history-diff-new");
  if (!list || !diffView || !diffOld || !diffNew) return;
  list.classList.add("hidden");
  diffView.classList.remove("hidden");
  if (diffTitle) diffTitle.textContent = title;
  diffOld.textContent = oldContent;
  diffNew.textContent = newContent;
}

function hideHistoryDiff() {
  document.getElementById("history-list")?.classList.remove("hidden");
  document.getElementById("history-diff")?.classList.add("hidden");
}

async function restoreFromCommit(commitId: string) {
  if (!historyDiffFilePath || !currentFolderPath) return;
  try {
    await invoke("git_restore_file", { folderPath: currentFolderPath, filePath: historyDiffFilePath, commitId });
    if (currentFilePath === historyDiffFilePath) {
      const info = await invoke<{ content: string }>("read_file", { path: historyDiffFilePath });
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: info.content } });
      setModified(false);
    }
    flashStatus("✓ File restored", "var(--success)");
    document.getElementById("history-modal")?.classList.add("hidden");
    debounceGitRefresh();
  } catch (e) {
    flashStatus(`Restore failed: ${e}`, "var(--error)", 3000);
  }
}

async function restoreFromSnapshot(snapPath: string) {
  if (!historyDiffFilePath) return;
  try {
    const content = await invoke<string>("read_snapshot", { snapPath });
    if (currentFilePath === historyDiffFilePath) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: content } });
      setModified(true);
    } else {
      await invoke("save_file", { path: historyDiffFilePath, content });
    }
    flashStatus("✓ Snapshot restored", "var(--success)");
    document.getElementById("history-modal")?.classList.add("hidden");
  } catch (e) {
    flashStatus(`Restore failed: ${e}`, "var(--error)", 3000);
  }
}

async function gitDiscardFile(filePath: string) {
  if (!currentFolderPath) return;
  try {
    await invoke("git_discard_file", { folderPath: currentFolderPath, filePath });
    flashStatus("Discarded changes", "var(--success)");
    // Reload the file if it's currently open
    if (currentFilePath === filePath) {
      const info = await invoke<{ content: string }>("read_file", { path: filePath });
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: info.content } });
      setModified(false);
    }
    debounceGitRefresh();
  } catch (e) {
    flashStatus(`Discard: ${e}`, "var(--error)", 3000);
  }
}

// --- Crash recovery ---

function scheduleRecovery() {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(async () => {
    if (currentFilePath && isEditorDirty()) {
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
  scheduleSnapshot();
}

// --- Divider drag to resize ---

function initDividerDrag() {
  const divider = $("#divider");
  const editorWrapper = $("#editor-wrapper");
  const previewPane = $("#preview-pane");
  const container = $("#editor-container");
  if (!divider || !editorWrapper || !previewPane || !container) return;

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
    editorWrapper.style.flexBasis = `${pct}%`;
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
  const editorWrapper = $("#editor-wrapper");
  if (!previewPane || !divider || !editorWrapper) return;

  currentViewMode = mode;
  localStorage.setItem("mx-view-mode", mode);

  if (mode === "split") {
    editorWrapper.style.display = "";
    editorWrapper.style.flexBasis = "";
    divider.style.display = "";
    previewPane.style.display = "";
    previewPane.style.flexBasis = "";
    updatePreview(editor.state.doc.toString());
  } else if (mode === "editor") {
    editorWrapper.style.display = "";
    editorWrapper.style.flexBasis = "100%";
    divider.style.display = "none";
    previewPane.style.display = "none";
  } else if (mode === "preview") {
    editorWrapper.style.display = "none";
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

function showPandocInstallGuide(format: string) {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999";
  const dialog = document.createElement("div");
  dialog.style.cssText = "background:var(--bg-secondary,#313244);color:var(--fg,#cdd6f4);border-radius:12px;padding:24px 28px;max-width:420px;font-size:14px;line-height:1.6";
  dialog.innerHTML = `
    <h3 style="margin:0 0 12px;font-size:16px">${format} export requires Pandoc</h3>
    <p style="margin:0 0 8px;opacity:0.8">Pandoc is a free document converter. Install it:</p>
    <ul style="margin:0 0 16px;padding-left:20px;opacity:0.8">
      <li><b>macOS:</b> brew install pandoc</li>
      <li><b>Windows:</b> winget install pandoc</li>
      <li><b>Linux:</b> sudo apt install pandoc</li>
    </ul>
    <p style="margin:0 0 16px;opacity:0.8">PDF also needs a TeX engine (e.g. <code style="background:rgba(255,255,255,0.1);padding:2px 5px;border-radius:3px">brew install basictex</code>)</p>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button id="pandoc-guide-dl" style="padding:6px 16px;border-radius:6px;border:none;background:var(--accent,#89b4fa);color:#1e1e2e;cursor:pointer;font-weight:600">Download Pandoc</button>
      <button id="pandoc-guide-close" style="padding:6px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:inherit;cursor:pointer">Close</button>
    </div>`;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  dialog.querySelector("#pandoc-guide-close")!.addEventListener("click", () => overlay.remove());
  dialog.querySelector("#pandoc-guide-dl")!.addEventListener("click", () => {
    invoke("plugin:opener|open_url", { url: "https://pandoc.org/installing.html" });
    overlay.remove();
  });
}

// --- Export to PDF ---

async function exportPDF() {
  const content = preprocessForPdfExport(editor.state.doc.toString());

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

  // Listen for progress updates from backend
  const unlisten = await listen<string>("pdf-progress", (event) => {
    if (statusWords) {
      statusWords.textContent = event.payload;
      statusWords.style.color = "var(--accent)";
    }
  });

  if (statusWords) {
    statusWords.textContent = "Exporting PDF...";
    statusWords.style.color = "var(--accent)";
  }

  // Run in background — don't await inline, use .then/.catch
  invoke<string>("export_pdf", {
    markdownContent: content,
    outputPath,
  }).then((result) => {
    unlisten();
    if (statusWords) {
      statusWords.textContent = `PDF saved: ${result.split("/").pop()} (click to open)`;
      statusWords.style.color = "var(--success)";
      statusWords.style.cursor = "pointer";
      statusWords.title = result;
      const openHandler = () => {
        invoke("reveal_in_finder", { path: result });
        statusWords.removeEventListener("click", openHandler);
      };
      statusWords.addEventListener("click", openHandler);
      setTimeout(() => {
        statusWords.textContent = prevText;
        statusWords.style.color = "";
        statusWords.style.cursor = "";
        statusWords.title = "";
        statusWords.removeEventListener("click", openHandler);
      }, 5000);
    }
  }).catch((e) => {
    unlisten();
    console.error("PDF export failed:", e);
    const err = String(e);
    if (err.toLowerCase().includes("pandoc")) {
      showPandocInstallGuide("PDF");
    } else if (statusWords) {
      statusWords.textContent = `PDF failed: ${err}`;
      statusWords.style.color = "var(--error)";
      setTimeout(() => {
        statusWords.textContent = prevText;
        statusWords.style.color = "";
      }, 5000);
    }
  });
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
    debounceGitRefresh();
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
        activeSidebarDir = entry.path;
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
        activeSidebarDir = entry.path.substring(0, entry.path.lastIndexOf("/"));
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
  // Pull before loading if auto-sync is on
  if (autoSyncEnabled) {
    try { await invoke("git_pull", { folderPath: path }); } catch { /* no remote or not a repo */ }
  }
  loadDirectory(path);
  updateSidebarTitle(path);
  startFolderWatch(path);
}

function refreshSidebar() {
  if (!currentFolderPath) return;
  // Reset activeSidebarDir if it's outside the current folder
  if (activeSidebarDir && !activeSidebarDir.startsWith(currentFolderPath)) {
    activeSidebarDir = null;
  }
  loadDirectory(currentFolderPath);
}

// --- Context menu ---

function showContextMenu(x: number, y: number, target: { path: string; isDir: boolean; parentPath: string }) {
  const menu = document.getElementById("context-menu");
  if (!menu) return;
  contextMenuTarget = target;

  // Always show New File/Folder (for files, uses parent directory)

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
  if (!contextMenuTarget) return;
  const dir = contextMenuTarget.isDir ? contextMenuTarget.path : contextMenuTarget.parentPath;
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
  if (!contextMenuTarget) return;
  const dir = contextMenuTarget.isDir ? contextMenuTarget.path : contextMenuTarget.parentPath;
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
  // Helper to get display shortcut from registry
  const sk = (id: string) => cm6KeyToDisplay(getBinding(id)) || undefined;
  return [
    { label: "New File", shortcut: sk("file.new"), action: newFile },
    { label: "Open File", shortcut: sk("file.open"), action: openFileDialog },
    { label: "Open Folder", action: () => openFolder() },
    { label: "New Window", shortcut: sk("file.new-window"), action: () => invoke("create_window", { filePath: null }) },
    { label: "Save", shortcut: sk("file.save"), action: saveFile },
    { label: "Close Tab", shortcut: sk("file.close-tab"), action: closeActiveTab },
    { label: "Toggle Preview", shortcut: sk("view.toggle-preview"), action: togglePreview },
    { label: "Toggle Sidebar", shortcut: sk("view.toggle-sidebar"), action: toggleSidebar },
    { label: "Read Mode", shortcut: sk("view.read-mode"), action: toggleReadMode },
    { label: "Copy Formatted HTML", shortcut: sk("edit.copy-formatted"), action: copyFormattedHTML },
    { label: "Export PDF", action: exportPDF },
    { label: "Export HTML", action: exportHTML },
    { label: "Export DOCX", action: exportDOCX },
    { label: "Zen Mode", shortcut: sk("view.zen-mode"), action: toggleZenMode },
    { label: "Copy Raw Markdown", action: copyRawMarkdown },
    { label: "Copy Plain Text", action: copyPlainText },
    { label: "Toggle Outline", action: toggleOutline },
    { label: "Toggle Line Numbers", action: toggleLineNumbers },
    { label: "Toggle Auto-save", action: toggleAutoSave },
    { label: "Cycle Theme", action: cycleTheme },
    { label: "Zoom In", shortcut: sk("view.zoom-in"), action: zoomIn },
    { label: "Zoom Out", shortcut: sk("view.zoom-out"), action: zoomOut },
    { label: "Zoom Reset", shortcut: sk("view.zoom-reset"), action: zoomReset },
    { label: "File Search", shortcut: sk("search.file-search"), action: openFileSearch },
    { label: "Search in Files", shortcut: sk("search.content-search"), action: () => { sidebarSearchMode ? deactivateSidebarSearch() : activateSidebarSearch(); } },
    { label: "Customize Shortcuts", action: toggleShortcutsModal },
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

// --- Tab management ---

function createEditorExtensions() {
  return [
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
    ]),
    keymapCompartment.of(buildKeymap()),
    EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged || update.selectionSet) {
        if (update.docChanged) onContentChange(update.view);
        updateCursorPosition(update.view);
        updateSelectionCount(update.view);
      }
    }),
  ];
}

function createTab(filePath: string | null, content: string): Tab {
  return {
    id: crypto.randomUUID(),
    filePath,
    title: filePath ? filePath.split("/").pop()! : "Untitled",
    editorState: EditorState.create({ doc: content, extensions: createEditorExtensions() }),
    scrollTop: 0,
    previewScrollTop: 0,
    isModified: false,
  };
}

function saveActiveTabState() {
  const tab = getActiveTab();
  if (!tab || !editor) return;
  tab.editorState = editor.state;
  tab.scrollTop = editor.scrollDOM.scrollTop;
  const previewPane = document.getElementById("preview-pane");
  if (previewPane) tab.previewScrollTop = previewPane.scrollTop;
}

function switchToTab(tabId: string) {
  if (tabId === activeTabId) return;

  // Save current tab state
  saveActiveTabState();

  const newTab = tabs.find(t => t.id === tabId);
  if (!newTab) return;

  activeTabId = tabId;
  currentFilePath = newTab.filePath;

  // Restore editor state
  editor.setState(newTab.editorState);
  // Get content from new tab state before any async operations
  const tabContent = newTab.editorState.doc.toString();

  // Restore scroll positions after layout
  requestAnimationFrame(() => {
    editor.scrollDOM.scrollTop = newTab.scrollTop;
    const previewPane = document.getElementById("preview-pane");
    if (previewPane) previewPane.scrollTop = newTab.previewScrollTop;
  });

  // Update UI
  const el = document.getElementById("filename");
  if (el) el.textContent = newTab.filePath ? newTab.filePath.split("/").pop()! : "No file open";
  if (newTab.filePath) localStorage.setItem("mx-last-file", newTab.filePath);

  const indicator = document.getElementById("modified-indicator");
  if (indicator) indicator.classList.toggle("hidden", !newTab.isModified);

  updateBreadcrumb();
  startFileWatch(newTab.filePath);
  updatePreview(tabContent);
  updateWordCount(tabContent);
  updateCursorPosition(editor);
  renderTabs();
  persistOpenTabs();
}

function renderTabs() {
  const tabBar = document.getElementById("tab-bar");
  if (!tabBar) return;

  // Hide tab bar if 0 or 1 tabs
  if (tabs.length <= 1) {
    tabBar.innerHTML = "";
    return;
  }

  tabBar.innerHTML = tabs.map(tab => {
    const activeClass = tab.id === activeTabId ? " active" : "";
    const modifiedDot = tab.isModified ? '<span class="tab-modified">●</span>' : "";
    const title = tab.title || "Untitled";
    return `<div class="tab${activeClass}" data-tab-id="${tab.id}">
      <span class="tab-title">${escapeHtml(title)}</span>
      ${modifiedDot}
      <span class="tab-close" data-tab-id="${tab.id}">✕</span>
    </div>`;
  }).join("");

  // Event listeners
  tabBar.querySelectorAll(".tab").forEach(el => {
    const tabId = (el as HTMLElement).dataset.tabId!;

    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("tab-close")) return;
      switchToTab(tabId);
    });

    // Middle-click to close
    el.addEventListener("mousedown", (e) => {
      if ((e as MouseEvent).button === 1) {
        e.preventDefault();
        closeTab(tabId);
      }
    });

    // Right-click context menu
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showTabContextMenu((e as MouseEvent).clientX, (e as MouseEvent).clientY, tabId);
    });
  });

  tabBar.querySelectorAll(".tab-close").forEach(el => {
    const tabId = (el as HTMLElement).dataset.tabId!;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tabId);
    });
  });
}

async function closeTab(tabId: string) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  // Check for unsaved changes
  if (tab.isModified) {
    // If not active, switch to it first so user can see the content
    if (tabId !== activeTabId) switchToTab(tabId);
    const shouldSave = await showConfirmDialog(`Save changes to ${tab.title}? (Y/N)`);
    if (shouldSave) {
      await saveFile();
    }
    // If user chose not to save, proceed to close. There's no cancel path with showConfirmDialog.
  }

  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  tabs.splice(idx, 1);

  if (tabs.length === 0) {
    // Create a new untitled tab
    const newTab = createTab(null, "");
    tabs.push(newTab);
    activeTabId = newTab.id;
    currentFilePath = null;
    editor.setState(newTab.editorState);
    setFilename(null);
    setModified(false);
    renderTabs();
    persistOpenTabs();
    return;
  }

  if (tabId === activeTabId) {
    // Switch to adjacent tab
    const newIdx = Math.min(idx, tabs.length - 1);
    activeTabId = tabs[newIdx].id;
    const newTab = tabs[newIdx];
    currentFilePath = newTab.filePath;
    editor.setState(newTab.editorState);

    requestAnimationFrame(() => {
      editor.scrollDOM.scrollTop = newTab.scrollTop;
      const previewPane = document.getElementById("preview-pane");
      if (previewPane) previewPane.scrollTop = newTab.previewScrollTop;
    });

    const el = document.getElementById("filename");
    if (el) el.textContent = newTab.filePath ? newTab.filePath.split("/").pop()! : "No file open";
    if (newTab.filePath) localStorage.setItem("mx-last-file", newTab.filePath);

    const indicator = document.getElementById("modified-indicator");
    if (indicator) indicator.classList.toggle("hidden", !newTab.isModified);

    updateBreadcrumb();
    startFileWatch(newTab.filePath);
    updatePreview(editor.state.doc.toString());
    updateWordCount(editor.state.doc.toString());
    updateCursorPosition(editor);
  }

  renderTabs();
  persistOpenTabs();
}

function closeActiveTab() {
  if (activeTabId) closeTab(activeTabId);
}

// --- Tab context menu ---

let tabContextTarget: string | null = null;

function showTabContextMenu(x: number, y: number, tabId: string) {
  const menu = document.getElementById("tab-context-menu");
  if (!menu) return;
  tabContextTarget = tabId;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.remove("hidden");
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;
  });
}

function hideTabContextMenu() {
  const menu = document.getElementById("tab-context-menu");
  if (menu) menu.classList.add("hidden");
  tabContextTarget = null;
}

async function closeOtherTabs(tabId: string) {
  const toClose = tabs.filter(t => t.id !== tabId).map(t => t.id);
  for (const id of toClose) await closeTab(id);
}

async function closeTabsToRight(tabId: string) {
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  const toClose = tabs.slice(idx + 1).map(t => t.id);
  for (const id of toClose) await closeTab(id);
}

async function closeAllTabs() {
  const toClose = tabs.map(t => t.id);
  for (const id of toClose) await closeTab(id);
}

function persistOpenTabs() {
  if (!isMainWindow) return;
  localStorage.setItem("mx-open-tabs", JSON.stringify(
    tabs.map(t => ({ filePath: t.filePath, isActive: t.id === activeTabId }))
  ));
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
    // Build from registry + some fixed entries
    const registryBindings = getDefaultBindings();
    const groups = new Map<string, [string, string][]>();
    for (const def of registryBindings) {
      if (!groups.has(def.group)) groups.set(def.group, []);
      groups.get(def.group)!.push([cm6KeyToDisplay(getBinding(def.id)), def.label]);
    }
    // Add fixed shortcuts not in registry
    if (!groups.has("Search")) groups.set("Search", []);
    groups.get("Search")!.push(["⌘F", "Find in file"], ["⌘H", "Find & replace"]);
    if (!groups.has("Edit")) groups.set("Edit", []);
    groups.get("Edit")!.push(["⌘Z/⌘⇧Z", "Undo/redo"], ["Tab/⇧Tab", "Indent/outdent"]);

    content.innerHTML = Array.from(groups.entries()).map(([group, keys]) =>
      `<div class="help-group"><h3>${group}</h3>${keys.map(([k, d]) =>
        `<div class="help-row"><kbd>${k || "—"}</kbd><span>${d}</span></div>`
      ).join("")}</div>`
    ).join("") + `<div class="help-customize"><button id="help-customize-btn">Customize Shortcuts...</button></div>`;

    document.getElementById("help-customize-btn")?.addEventListener("click", () => {
      modal.classList.add("hidden");
      toggleShortcutsModal();
    });
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

/** Pre-process markdown for HTML export: convert callouts to HTML divs */
function preprocessForHtmlExport(content: string): string {
  let result = content;
  // Convert callout blockquotes to HTML divs
  result = result.replace(
    /^(> \[!([\w-]+)\]\s*(.*)\n(?:> .*\n)*)/gm,
    (_match, block: string, type: string, title: string) => {
      const lines = block.split("\n").map((l: string) => l.replace(/^>\s?/, "")).filter((l: string) => l.trim());
      lines.shift(); // remove [!type] line
      const t = type.toLowerCase();
      const icon = CALLOUT_ICONS[t] || "📌";
      const displayTitle = title.trim() || type.charAt(0).toUpperCase() + type.slice(1);
      const body = lines.join("<br>");
      return `<div class="callout callout-${t}"><div class="callout-title">${icon} ${displayTitle}</div><div class="callout-content">${body}</div></div>\n`;
    }
  );
  // Convert checklists to HTML checkboxes
  result = result.replace(/^- \[x\] /gm, "- ☑ ");
  result = result.replace(/^- \[ \] /gm, "- ☐ ");
  // Convert frontmatter tags to styled spans
  result = result.replace(/^---\n([\s\S]*?)\n---\n?/, (match, yaml: string) => {
    const tagMatch = yaml.match(/^tags:\s*\n((?:\s+-\s+.*\n?)+)/m);
    if (!tagMatch) return match;
    const tags = tagMatch[1].split("\n").map(l => l.replace(/^\s+-\s+/, "").trim()).filter(Boolean);
    const tagHtml = tags.map(t => `<span class="fm-tag">${t}</span>`).join(" ");
    const cleanYaml = yaml.replace(/^tags:\s*\n(?:\s+-\s+.*\n?)+/m, `tags: ${tagHtml}`);
    return `---\n${cleanYaml}\n---\n`;
  });
  return result;
}

/** Pre-process markdown for PDF export (Pandoc): convert to Pandoc-friendly markdown */
function preprocessForPdfExport(content: string): string {
  let result = content;
  // Strip frontmatter
  result = result.replace(/^---\n[\s\S]*?\n---\n?/, "");
  // Convert callout blockquotes to styled blockquotes with bold title
  result = result.replace(
    /^(> \[!([\w-]+)\]\s*(.*)\n(?:> .*\n)*)/gm,
    (_match, block: string, type: string, title: string) => {
      const lines = block.split("\n").map((l: string) => l.replace(/^>\s?/, "")).filter((l: string) => l.trim());
      lines.shift(); // remove [!type] line
      const icon = CALLOUT_ICONS[type.toLowerCase()] || "📌";
      const displayTitle = title.trim() || type.charAt(0).toUpperCase() + type.slice(1);
      const bodyLines = lines.map(l => `> ${l}`).join("\n");
      return `> **${icon} ${displayTitle}**\n>\n${bodyLines}\n\n`;
    }
  );
  // Ensure blank line before lists (Pandoc needs this to recognize list start)
  result = result.replace(/^([^\n-][^\n]*)\n(- \[[ xX]\])/gm, "$1\n\n$2");
  result = result.replace(/^([^\n-][^\n]*)\n(- [^[[])/gm, "$1\n\n$2");
  return result;
}

async function exportHTML() {
  const content = preprocessForHtmlExport(editor.state.doc.toString());
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

  try {
    flashStatus("Exporting DOCX...", "var(--accent)");
    await invoke<string>("export_docx", {
      markdownContent: content,
      outputPath,
    });
    flashStatus("DOCX exported!", "var(--success)", 3000);
  } catch (e) {
    const err = String(e);
    if (err.toLowerCase().includes("pandoc")) {
      showPandocInstallGuide("DOCX");
    } else {
      flashStatus(`Export failed: ${err}`, "var(--error)", 4000);
    }
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

// --- Register keybinding actions (must be after function definitions) ---

actions["file.new"] = () => newFile();
actions["file.open"] = () => openFileDialog();
actions["file.save"] = () => saveFile();
actions["file.close-tab"] = () => closeActiveTab();
actions["file.new-window"] = () => invoke("create_window", { filePath: null });
actions["view.toggle-preview"] = () => togglePreview();
actions["view.read-mode"] = () => toggleReadMode();
actions["view.toggle-sidebar"] = () => toggleSidebar();
actions["view.zen-mode"] = () => toggleZenMode();
actions["view.zoom-in"] = () => zoomIn();
actions["view.zoom-out"] = () => zoomOut();
actions["view.zoom-reset"] = () => zoomReset();
actions["edit.copy-formatted"] = () => copyFormattedHTML();
actions["search.command-palette"] = () => toggleCommandPalette();
actions["search.file-search"] = () => openFileSearch();
actions["search.content-search"] = () => { sidebarSearchMode ? deactivateSidebarSearch() : activateSidebarSearch(); };
actions["help.shortcuts"] = () => toggleHelp();

// --- Shortcuts settings modal ---

function renderShortcutsContent() {
  const content = document.getElementById("shortcuts-content");
  if (!content || document.getElementById("shortcuts-modal")?.classList.contains("hidden")) return;

  const bindings = getDefaultBindings();
  const groups = new Map<string, ShortcutDef[]>();
  for (const def of bindings) {
    if (!groups.has(def.group)) groups.set(def.group, []);
    groups.get(def.group)!.push(def);
  }

  const custom = getCustomBindings();
  content.innerHTML = Array.from(groups.entries()).map(([group, defs]) =>
    `<div class="shortcut-group"><h3>${group}</h3>${defs.map(def => {
      const current = getBinding(def.id);
      const isCustom = def.id in custom;
      const display = cm6KeyToDisplay(current) || "Unbound";
      return `<div class="shortcut-row" data-id="${def.id}">
        <span class="shortcut-label">${def.label}</span>
        <kbd class="shortcut-key${isCustom ? " custom" : ""}">${display}</kbd>
        <button class="shortcut-edit" title="Click to rebind">Edit</button>
      </div>`;
    }).join("")}</div>`
  ).join("");

  // Wire edit buttons
  content.querySelectorAll(".shortcut-edit").forEach(btn => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".shortcut-row") as HTMLElement;
      startCapture(row);
    });
  });

  // Wire row clicks too
  content.querySelectorAll(".shortcut-row").forEach(row => {
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("shortcut-edit")) return;
      startCapture(row as HTMLElement);
    });
  });
}

function startCapture(row: HTMLElement) {
  const id = row.dataset.id!;
  // Remove any existing capture
  document.querySelectorAll(".shortcut-row.capturing").forEach(r => r.classList.remove("capturing"));

  row.classList.add("capturing");
  const kbd = row.querySelector(".shortcut-key")!;
  const originalText = kbd.textContent;
  kbd.textContent = "Press shortcut...";

  const handler = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      cleanup();
      kbd.textContent = originalText;
      row.classList.remove("capturing");
      return;
    }

    if (e.key === "Backspace" || e.key === "Delete") {
      cleanup();
      setCustomBinding(id, "");
      return;
    }

    const cm6Key = keyEventToCM6(e);
    if (!cm6Key) return; // modifier-only press

    const conflict = findConflict(cm6Key, id);
    if (conflict) {
      kbd.textContent = `${cm6KeyToDisplay(cm6Key)} (used by ${conflict.label})`;
      kbd.classList.add("conflict");
      // Wait for Enter to confirm, Escape to cancel
      const confirmHandler = (e2: KeyboardEvent) => {
        e2.preventDefault();
        e2.stopPropagation();
        if (e2.key === "Enter") {
          // Swap: give conflict the old binding
          const oldKey = getBinding(id);
          setCustomBinding(conflict.id, oldKey);
          setCustomBinding(id, cm6Key);
          cleanupConfirm();
        } else if (e2.key === "Escape") {
          cleanupConfirm();
          kbd.textContent = originalText;
          kbd.classList.remove("conflict");
          row.classList.remove("capturing");
        }
      };
      const cleanupConfirm = () => {
        document.removeEventListener("keydown", confirmHandler, true);
        kbd.classList.remove("conflict");
      };
      document.removeEventListener("keydown", handler, true);
      document.addEventListener("keydown", confirmHandler, true);
      return;
    }

    if (isOSReserved(cm6Key)) {
      kbd.textContent = `${cm6KeyToDisplay(cm6Key)} (system shortcut!)`;
    }

    cleanup();
    setCustomBinding(id, cm6Key);
  };

  const cleanup = () => {
    document.removeEventListener("keydown", handler, true);
    row.classList.remove("capturing");
  };

  document.addEventListener("keydown", handler, true);
}

function toggleShortcutsModal() {
  const modal = document.getElementById("shortcuts-modal");
  if (!modal) return;
  if (!modal.classList.contains("hidden")) {
    modal.classList.add("hidden");
    return;
  }
  modal.classList.remove("hidden");
  renderShortcutsContent();
}

// --- Init ---

window.addEventListener("DOMContentLoaded", () => {
  const editorPane = $("#editor-pane");
  if (!editorPane) return;

  // Apply theme before creating editor
  document.documentElement.setAttribute("data-theme", currentThemeMode);

  // Create initial tab
  const initialTab = createTab(null, SAMPLE_CONTENT);
  tabs.push(initialTab);
  activeTabId = initialTab.id;

  editor = new EditorView({
    state: initialTab.editorState,
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
    hideTabContextMenu();
  });

  // File menu items
  document.getElementById("btn-new")?.addEventListener("click", () => newFile());
  document.getElementById("btn-open")?.addEventListener("click", () => openFileDialog());
  document.getElementById("btn-open-folder")?.addEventListener("click", () => openFolder());
  document.getElementById("btn-new-window")?.addEventListener("click", () => invoke("create_window", { filePath: null }));
  document.getElementById("btn-recent")?.addEventListener("click", () => toggleRecentPanel());
  document.getElementById("btn-save")?.addEventListener("click", () => saveFile());
  document.getElementById("btn-autosave")?.addEventListener("click", () => toggleAutoSave());
  document.getElementById("btn-autosync")?.addEventListener("click", () => toggleAutoSync());
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
  document.getElementById("btn-customize-shortcuts")?.addEventListener("click", toggleShortcutsModal);
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
    const dir = activeSidebarDir || currentFolderPath;
    const name = await showInputDialog("File name:", "untitled.md");
    if (!name) return;
    try {
      await invoke("create_file", { path: `${dir}/${name}` });
      refreshSidebar();
      openFile(`${dir}/${name}`);
    } catch (e) {
      flashStatus(`Error: ${e}`, "var(--error)", 3000);
    }
  });
  document.getElementById("btn-sidebar-new-folder")?.addEventListener("click", async () => {
    if (!currentFolderPath) {
      await openFolder();
      if (!currentFolderPath) return;
    }
    const dir = activeSidebarDir || currentFolderPath;
    const name = await showInputDialog("Folder name:");
    if (!name) return;
    invoke("create_directory", { path: `${dir}/${name}` }).then(() => {
      refreshSidebar();
    }).catch(e => flashStatus(`Error: ${e}`, "var(--error)", 3000));
  });
  document.getElementById("btn-sidebar-refresh")?.addEventListener("click", () => refreshSidebar());
  document.getElementById("btn-sidebar-outline")?.addEventListener("click", () => toggleOutline());
  document.getElementById("btn-sidebar-close")?.addEventListener("click", () => toggleSidebar());

  // Git panel
  document.getElementById("btn-sidebar-git")?.addEventListener("click", () => {
    const panel = document.getElementById("git-panel");
    if (panel) panel.classList.toggle("hidden");
  });
  document.getElementById("btn-git-sync")?.addEventListener("click", () => gitSync());
  document.getElementById("btn-git-commit")?.addEventListener("click", () => gitManualCommit());
  document.getElementById("git-commit-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") gitManualCommit();
  });

  // Sync setup
  document.getElementById("btn-sync-setup")?.addEventListener("click", () => showSyncSetup());
  document.getElementById("btn-sync-connect")?.addEventListener("click", () => connectSync());
  document.getElementById("sync-setup-close")?.addEventListener("click", () => hideSyncSetup());
  document.getElementById("sync-setup-backdrop")?.addEventListener("click", () => hideSyncSetup());
  document.getElementById("sync-repo-url")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") connectSync();
  });
  document.getElementById("sync-create-repo-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    invoke("plugin:opener|open_url", { url: "https://github.com/new" });
  });

  // History modal
  document.getElementById("history-close")?.addEventListener("click", () => {
    document.getElementById("history-modal")?.classList.add("hidden");
  });
  document.getElementById("history-backdrop")?.addEventListener("click", () => {
    document.getElementById("history-modal")?.classList.add("hidden");
  });
  document.getElementById("history-tab-commits")?.addEventListener("click", () => {
    document.getElementById("history-tab-commits")?.classList.add("active");
    document.getElementById("history-tab-snapshots")?.classList.remove("active");
    hideHistoryDiff();
    loadHistoryCommits();
  });
  document.getElementById("history-tab-snapshots")?.addEventListener("click", () => {
    document.getElementById("history-tab-snapshots")?.classList.add("active");
    document.getElementById("history-tab-commits")?.classList.remove("active");
    hideHistoryDiff();
    loadHistorySnapshots();
  });
  document.getElementById("history-diff-back")?.addEventListener("click", () => hideHistoryDiff());
  document.getElementById("history-diff-restore")?.addEventListener("click", () => {
    // Restore from the currently viewed diff (old content)
    const oldContent = document.getElementById("history-diff-old")?.textContent || "";
    if (currentFilePath) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: oldContent } });
      setModified(true);
      flashStatus("✓ Version restored", "var(--success)");
      document.getElementById("history-modal")?.classList.add("hidden");
    }
  });

  // Conflict resolution
  document.getElementById("conflict-close")?.addEventListener("click", () => {
    document.getElementById("conflict-modal")?.classList.add("hidden");
  });
  document.getElementById("conflict-backdrop")?.addEventListener("click", () => {
    document.getElementById("conflict-modal")?.classList.add("hidden");
  });
  document.getElementById("conflict-accept-local")?.addEventListener("click", () => resolveConflict("local"));
  document.getElementById("conflict-accept-remote")?.addEventListener("click", () => resolveConflict("remote"));
  document.getElementById("conflict-accept-both")?.addEventListener("click", () => resolveConflict("both"));

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
  document.getElementById("ctx-git-history")?.addEventListener("click", () => {
    const target = contextMenuTarget;
    hideContextMenu();
    if (target && !target.isDir) {
      currentFilePath = target.path;
      showFileHistory();
    }
  });
  document.getElementById("ctx-git-discard")?.addEventListener("click", () => {
    const target = contextMenuTarget;
    hideContextMenu();
    if (target && !target.isDir) {
      gitDiscardFile(target.path);
    }
  });
  document.getElementById("ctx-delete")?.addEventListener("click", ctxDelete);

  // Tab context menu items
  document.getElementById("tab-ctx-close")?.addEventListener("click", () => {
    if (tabContextTarget) closeTab(tabContextTarget);
    hideTabContextMenu();
  });
  document.getElementById("tab-ctx-close-others")?.addEventListener("click", () => {
    if (tabContextTarget) closeOtherTabs(tabContextTarget);
    hideTabContextMenu();
  });
  document.getElementById("tab-ctx-close-right")?.addEventListener("click", () => {
    if (tabContextTarget) closeTabsToRight(tabContextTarget);
    hideTabContextMenu();
  });
  document.getElementById("tab-ctx-close-all")?.addEventListener("click", () => {
    closeAllTabs();
    hideTabContextMenu();
  });

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

  // Shortcuts modal
  document.getElementById("shortcuts-close")?.addEventListener("click", toggleShortcutsModal);
  document.getElementById("shortcuts-backdrop")?.addEventListener("click", toggleShortcutsModal);
  document.getElementById("shortcuts-reset")?.addEventListener("click", () => {
    resetAllBindings();
    renderShortcutsContent();
  });

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

  // Check for file passed on cold start, then restore tabs (main window only)
  invoke<string | null>("get_initial_file").then(async (path) => {
    if (path) {
      await openFile(path);
    } else if (isMainWindow) {
      // Restore tabs from previous session
      try {
        const saved = JSON.parse(localStorage.getItem("mx-open-tabs") || "[]") as { filePath: string | null; isActive: boolean }[];
        const fileTabs = saved.filter(t => t.filePath);
        if (fileTabs.length > 0) {
          let activeFilePath: string | null = null;
          for (const t of fileTabs) {
            if (t.isActive) activeFilePath = t.filePath;
          }
          // Open first tab (replaces the initial sample tab)
          await openFile(fileTabs[0].filePath!);
          // Remove the initial sample tab
          const sampleTab = tabs.find(t => !t.filePath);
          if (sampleTab) {
            tabs = tabs.filter(t => t.id !== sampleTab.id);
          }
          // Open remaining tabs
          for (let i = 1; i < fileTabs.length; i++) {
            await openFile(fileTabs[i].filePath!);
          }
          // Switch to the previously active tab
          if (activeFilePath) {
            const active = tabs.find(t => t.filePath === activeFilePath);
            if (active) switchToTab(active.id);
          }
          renderTabs();
        } else {
          const lastFile = localStorage.getItem("mx-last-file");
          if (lastFile) openFile(lastFile);
        }
      } catch {
        const lastFile = localStorage.getItem("mx-last-file");
        if (lastFile) openFile(lastFile);
      }
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

  // Apply customizable keybindings (sets up global keydown handler from registry)
  applyBindings();

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
  updateGitUI();

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
