// Opaque-origin iframe. Durable data belongs to the extension server.
import { createPanel } from "./ui.js";

const HOST_READY = "chan:extension-ready:v1";
const HOST_COMMAND = "chan:extension-command:v1";
const HOST_RESULT = "chan:extension-command-result:v1";
const HOST_PRESENT = "chan:extension-presentation:v1";
const SAVE_DELAY_MS = 750;
const STATE_VERSION = 2;
const STRUDEL_SITE = "https://strudel.cc";
const LEARN_URL = `${STRUDEL_SITE}/workshop/getting-started/`;
const DEFAULT_CODE = `// "first steps"
// Click once to unlock audio. Ctrl+Enter plays, Alt+. stops.
setcps(0.5)
$: s("bd hh sd hh")
$: note("c3 e3 g3 b3").s("sawtooth").lpf(800)
`;
// StrudelMirror.updateSettings reconfigures every extension from the object it
// receives, so these keys are always sent together, with their defaults.
const EDITOR_SETTING_KEYS = [
  "keybindings",
  "isBracketMatchingEnabled",
  "isBracketClosingEnabled",
  "isLineNumbersDisplayed",
  "isActiveLineHighlighted",
  "isAutoCompletionEnabled",
  "isPatternHighlightingEnabled",
  "isFlashEnabled",
  "isTooltipEnabled",
  "isLineWrappingEnabled",
  "isTabIndentationEnabled",
  "isMultiCursorEnabled",
  "theme",
  "fontFamily",
  "fontSize",
];
const DEFAULT_SETTINGS = {
  keybindings: "codemirror",
  isBracketMatchingEnabled: false,
  isBracketClosingEnabled: true,
  isLineNumbersDisplayed: true,
  isActiveLineHighlighted: false,
  isAutoCompletionEnabled: false,
  isPatternHighlightingEnabled: true,
  isFlashEnabled: true,
  isTooltipEnabled: false,
  isLineWrappingEnabled: false,
  isTabIndentationEnabled: false,
  isMultiCursorEnabled: false,
  theme: "strudelTheme",
  fontFamily: "monospace",
  fontSize: 18,
  maxPolyphony: 128,
  multiChannelOrbits: false,
  panelPosition: "right",
  isPanelOpen: true,
  activeTab: "welcome",
};
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// Interval ids handed out by the worker timers, far above any native id.
const WORKER_TIMER_BASE = 1_000_000_000;

const el = (id) => document.getElementById(id);
const ui = Object.fromEntries(
  [
    "app",
    "status",
    "notice",
    "popover",
    "stage",
    "panel",
    "about-body",
    "play",
    "update",
    "share",
    "learn",
  ].map((id) => [id, el(id)]),
);
const state = {
  hostKeys: [],
  element: null,
  editor: null,
  doc: emptyDoc(),
  loadFailed: false,
  dirty: false,
  timer: null,
  saving: false,
  resave: false,
  started: false,
  unlocked: false,
  panel: null,
  listeners: new Map(),
};

function emptyDoc() {
  return { version: STATE_VERSION, active: null, patterns: [], settings: {} };
}
function now() {
  return Date.now();
}
function newId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function status(text) {
  ui.status.textContent = text;
}
function notice(text) {
  ui.notice.textContent = text;
  ui.notice.hidden = !text;
}
function on(event, fn) {
  if (!state.listeners.has(event)) state.listeners.set(event, new Set());
  state.listeners.get(event).add(fn);
}
function emit(event) {
  for (const fn of state.listeners.get(event) ?? []) {
    try {
      fn();
    } catch (error) {
      console.error(error);
    }
  }
}
function paragraph(text, className) {
  const node = document.createElement("p");
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

// Worker-backed timers. Browsers throttle a hidden page's main-thread timers
// to about one tick per second, which drags Strudel's scheduler; a dedicated
// worker's timers are left alone, and strudel.cc runs on them too. The
// scheduler's clock reads globalThis.setInterval when it is created, at
// mount, so the swap has to happen before the editor exists.
function installWorkerTimers() {
  const source = [
    "const timers = new Map();",
    "self.onmessage = (event) => {",
    "  const { op, id, delay } = event.data;",
    "  if (op === 'set') timers.set(id, setInterval(() => self.postMessage(id), delay));",
    "  else if (op === 'clear') { clearInterval(timers.get(id)); timers.delete(id); }",
    "};",
  ].join("\n");
  const urls = [
    () => URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
    () => `data:text/javascript;base64,${btoa(source)}`,
  ];
  let worker = null;
  for (const url of urls) {
    try {
      worker = new Worker(url());
      break;
    } catch {
      worker = null;
    }
  }
  if (!worker) return false;
  const nativeSet = globalThis.setInterval;
  const nativeClear = globalThis.clearInterval;
  const active = new Map();
  let next = WORKER_TIMER_BASE;
  let broken = false;
  worker.onmessage = (event) => {
    const entry = active.get(event.data);
    if (entry && entry.native === undefined) entry.callback();
  };
  // A worker that fails after construction (a blocked URL reports through
  // this event) hands every interval back to the native timer.
  worker.onerror = () => {
    if (broken) return;
    broken = true;
    for (const entry of active.values()) {
      if (entry.native === undefined) entry.native = nativeSet(entry.callback, entry.delay);
    }
  };
  globalThis.setInterval = (callback, delay = 0, ...args) => {
    if (typeof callback !== "function") return nativeSet(callback, delay, ...args);
    const id = next++;
    const entry = { callback: () => callback(...args), delay: Math.max(0, Number(delay) || 0) };
    active.set(id, entry);
    if (broken) entry.native = nativeSet(entry.callback, entry.delay);
    else worker.postMessage({ op: "set", id, delay: entry.delay });
    return id;
  };
  globalThis.clearInterval = (id) => {
    const entry = active.get(id);
    if (!entry) {
      nativeClear(id);
      return;
    }
    active.delete(id);
    if (entry.native !== undefined) nativeClear(entry.native);
    else worker.postMessage({ op: "clear", id });
  };
  return true;
}

async function getJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

// The saved record for this Chan session. Version 1 kept one pattern and no
// settings; it becomes the first pattern of a version 2 record.
function normalizeDoc(raw) {
  const doc = emptyDoc();
  let migrated = false;
  if (raw && typeof raw === "object" && Array.isArray(raw.patterns)) {
    for (const pattern of raw.patterns) {
      if (
        pattern &&
        typeof pattern.id === "string" &&
        ID_PATTERN.test(pattern.id) &&
        typeof pattern.code === "string" &&
        !doc.patterns.some((other) => other.id === pattern.id)
      ) {
        doc.patterns.push({
          id: pattern.id,
          code: pattern.code,
          created_at: Number(pattern.created_at) || now(),
          updated_at: Number(pattern.updated_at) || now(),
        });
      }
    }
    if (
      typeof raw.active === "string" &&
      doc.patterns.some((pattern) => pattern.id === raw.active)
    ) {
      doc.active = raw.active;
    }
    if (
      raw.settings &&
      typeof raw.settings === "object" &&
      !Array.isArray(raw.settings)
    ) {
      doc.settings = { ...raw.settings };
    }
  } else if (raw && typeof raw.code === "string") {
    const pattern = {
      id: newId(),
      code: raw.code,
      created_at: now(),
      updated_at: now(),
    };
    doc.patterns.push(pattern);
    doc.active = pattern.id;
    migrated = true;
  }
  return { doc, migrated };
}

function patternById(id) {
  return state.doc.patterns.find((pattern) => pattern.id === id) ?? null;
}
function activePattern() {
  return patternById(state.doc.active);
}
function patternList() {
  return [...state.doc.patterns].sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
  );
}
function currentCode() {
  const code = state.editor?.code;
  return typeof code === "string" ? code : null;
}
// Copy the editor buffer into the active pattern. Returns whether it changed.
function syncBuffer() {
  const pattern = activePattern();
  const code = currentCode();
  if (!pattern || code === null || code === pattern.code) return false;
  pattern.code = code;
  pattern.updated_at = now();
  state.dirty = true;
  emit("patterns");
  return true;
}
function createPattern(code) {
  const pattern = { id: newId(), code, created_at: now(), updated_at: now() };
  state.doc.patterns.push(pattern);
  return pattern;
}
function openPattern(id) {
  const pattern = patternById(id);
  if (!pattern) return;
  syncBuffer();
  state.doc.active = id;
  state.editor?.setCode(pattern.code);
  state.dirty = true;
  scheduleSave();
  emit("patterns");
}
function newPattern() {
  openPattern(createPattern("").id);
}
function duplicatePattern(id) {
  syncBuffer();
  const source = patternById(id) ?? activePattern();
  openPattern(createPattern(source?.code ?? "").id);
}
function deletePattern(id) {
  const index = state.doc.patterns.findIndex((pattern) => pattern.id === id);
  if (index < 0) return;
  state.doc.patterns.splice(index, 1);
  if (state.doc.active === id) {
    state.doc.active = null;
    const next = patternList()[0] ?? createPattern(DEFAULT_CODE);
    openPattern(next.id);
    return;
  }
  state.dirty = true;
  scheduleSave();
  emit("patterns");
}

async function save({ unloading = false } = {}) {
  if (!state.dirty || state.loadFailed) return;
  if (state.saving) {
    state.resave = true;
    return;
  }
  state.saving = true;
  state.dirty = false;
  try {
    const response = await fetch("state", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state.doc),
      keepalive: unloading,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    notice("");
  } catch (error) {
    state.dirty = true;
    notice(`Not saved: ${error.message}`);
  } finally {
    state.saving = false;
    if (state.resave) {
      state.resave = false;
      scheduleSave();
    }
  }
}
function scheduleSave() {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    syncBuffer();
    save().catch(() => {});
  }, SAVE_DELAY_MS);
}
function flush() {
  clearTimeout(state.timer);
  state.timer = null;
  syncBuffer();
  save({ unloading: true }).catch(() => {});
}

function currentSettings() {
  return { ...DEFAULT_SETTINGS, ...state.doc.settings };
}
function applyEditorSettings() {
  const settings = currentSettings();
  const editorSettings = Object.fromEntries(
    EDITOR_SETTING_KEYS.map((key) => [key, settings[key]]),
  );
  try {
    state.editor?.updateSettings(editorSettings);
  } catch (error) {
    notice(`Editor settings not applied: ${error.message}`);
  }
  applyChrome(settings.theme);
}
// Strudel publishes each theme's palette on the `settings` global after
// prebake; the chrome follows the editor's colors when they are known.
function applyChrome(theme) {
  const palette = globalThis.settings?.[theme];
  if (!palette || typeof palette !== "object") return;
  const root = document.documentElement.style;
  const assign = (property, ...keys) => {
    const value = keys
      .map((key) => palette[key])
      .find((candidate) => typeof candidate === "string" && candidate.trim());
    if (value) root.setProperty(property, value);
  };
  assign("--bg", "background");
  assign("--fg", "foreground");
  assign("--line", "lineHighlight", "gutterBackground");
  assign("--field", "gutterBackground", "lineHighlight");
  assign("--accent", "caret");
}
// The bundle's own first-click `initAudio({})` resets these, so they are
// applied again once that promise settles.
function applyAudioSettings() {
  const settings = currentSettings();
  try {
    globalThis.setMaxPolyphony?.(settings.maxPolyphony);
    globalThis.setMultiChannelOrbits?.(settings.multiChannelOrbits);
  } catch (error) {
    console.warn("audio settings", error);
  }
}
function applyPanelSettings() {
  const settings = currentSettings();
  ui.app.dataset.panel = settings.panelPosition === "bottom" ? "bottom" : "right";
  ui.app.dataset.panelOpen = String(settings.isPanelOpen !== false);
}
function applyAllSettings() {
  applyEditorSettings();
  applyAudioSettings();
  applyPanelSettings();
}
function setSetting(key, value) {
  state.doc.settings = { ...state.doc.settings, [key]: value };
  if (EDITOR_SETTING_KEYS.includes(key)) applyEditorSettings();
  else if (key === "maxPolyphony" || key === "multiChannelOrbits")
    applyAudioSettings();
  else if (key === "panelPosition" || key === "isPanelOpen")
    applyPanelSettings();
  state.dirty = true;
  scheduleSave();
  emit("settings");
}
function resetSettings() {
  state.doc.settings = {};
  applyAllSettings();
  state.dirty = true;
  scheduleSave();
  emit("settings");
  emit("settings-reset");
}

async function loadAbout() {
  try {
    const meta = await getJson("meta");
    ui["about-body"].replaceChildren(
      paragraph(
        `Strudel ${meta.strudel.version} (${meta.strudel.name}), AGPL-3.0-or-later, by the Strudel contributors.`,
      ),
      paragraph(STRUDEL_SITE),
      paragraph(`${meta.strudel.repository} at ${meta.strudel.tag}`),
      paragraph(
        `Reference data from ${meta.reference.name} ${meta.reference.version}.`,
        "muted",
      ),
      paragraph(
        `chan-ext-strudel ${meta.extension.version}: ${meta.extension.repository}/releases/tag/v${meta.extension.version}`,
      ),
      paragraph(
        "The release archive carries the corresponding source under source/.",
        "muted",
      ),
    );
  } catch (error) {
    ui["about-body"].replaceChildren(
      paragraph(`About unavailable: ${error.message}`),
    );
  }
}

function hidePopover() {
  ui.popover.hidden = true;
  ui.popover.replaceChildren();
}
// Links cannot open from the sandbox (no popups, no clipboard permission), so
// a link is shown as selectable text, with a copy attempt for browsers that
// allow it.
function showPopover(title, text, hint) {
  const heading = document.createElement("strong");
  heading.textContent = title;
  const field = document.createElement("input");
  field.type = "text";
  field.readOnly = true;
  field.value = text;
  field.setAttribute("aria-label", title);
  const row = document.createElement("div");
  row.className = "row";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "copy";
  copy.addEventListener("click", async () => {
    field.select();
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "copied";
    } catch {
      copy.textContent = "select and copy";
    }
  });
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "close";
  close.addEventListener("click", hidePopover);
  row.append(copy, close);
  ui.popover.replaceChildren(heading, field, paragraph(hint, "muted"), row);
  ui.popover.hidden = false;
  field.focus();
  field.select();
}
function shareUrl() {
  const encode = globalThis.code2hash;
  if (typeof encode !== "function") return null;
  return `${STRUDEL_SITE}/#${encode(currentCode() ?? "")}`;
}

function renderHeader() {
  ui.play.textContent = state.started ? "stop" : "play";
  ui.play.disabled = !state.editor;
  ui.update.disabled = !state.editor;
}
function wireHeader() {
  ui.play.addEventListener("click", () => {
    try {
      state.editor?.toggle();
    } catch (error) {
      notice(error.message);
    }
  });
  ui.update.addEventListener("click", () => {
    try {
      state.editor?.evaluate();
    } catch (error) {
      notice(error.message);
    }
  });
  ui.share.addEventListener("click", () => {
    const url = shareUrl();
    if (!url) {
      notice("Strudel is still loading; try again in a moment.");
      return;
    }
    showPopover(
      "Share link",
      url,
      "Opens this pattern in the REPL on strudel.cc.",
    );
  });
  ui.learn.addEventListener("click", () => {
    showPopover(
      "Learn Strudel",
      LEARN_URL,
      "The interactive workshop on strudel.cc, which also hosts the full documentation.",
    );
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !ui.popover.hidden) hidePopover();
  });
  renderHeader();
}

// The component creates its StrudelMirror synchronously on connect and keeps
// the current document text on `editor.code`.
function mountEditor(code) {
  const element = document.createElement("strudel-editor");
  element.setAttribute("code", code);
  ui.stage.append(element);
  state.element = element;
  state.editor = element.editor ?? null;
  if (!state.editor) {
    notice("The Strudel editor did not start. Reload the tab.");
    return;
  }
  element.addEventListener("update", (event) => {
    const detail = event.detail;
    if (
      detail &&
      typeof detail.started === "boolean" &&
      detail.started !== state.started
    ) {
      state.started = detail.started;
      renderHeader();
      status(detail.started ? "Playing" : "Stopped");
      emit("transport");
    }
    if (detail?.error) status("Error, see the console tab");
    scheduleSave();
  });
}

function runCommand(message) {
  let ok = true;
  let result = "";
  if (message.id === "toggle-presentation") {
    window.parent.postMessage({ type: HOST_PRESENT, action: "toggle" }, "*");
  } else {
    ok = false;
    result = `Unknown Strudel command: ${message.id}`;
  }
  window.parent.postMessage(
    {
      type: HOST_RESULT,
      request_id: message.request_id,
      ok,
      message: result || undefined,
    },
    "*",
  );
}

for (const type of ["keyup", "input", "paste", "cut"]) {
  document.addEventListener(type, scheduleSave);
}
window.addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flush();
});
// The bundle unlocks audio on the first mousedown; a tap sends one too.
document.addEventListener(
  "mousedown",
  () => {
    state.unlocked = true;
    status("Ready. Ctrl+Enter plays, Alt+. stops.");
    const init = globalThis.initAudioOnFirstClick;
    Promise.resolve(typeof init === "function" ? init() : null)
      .then(applyAudioSettings)
      .catch(() => {});
  },
  { once: true },
);
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.type === HOST_COMMAND && typeof message.id === "string") {
    runCommand(message);
  }
});
// Chan's keyboard relay. Chan advertises the shell chords it claims as key
// tokens under its layout-aware contract: the letter or punctuation symbol
// the layout types, the top-row digit by position, or a named key, each with
// exact modifiers. A keydown that resolves to one is relayed with its raw
// fields, and Chan resolves and checks it again before acting on it. The
// listener runs in the capture phase, ahead of the editor's own keymap.
const HOST_KEYMAP = "chan:extension-host-keymap:v2";
const HOST_KEYDOWN = "chan:extension-keydown:v2";
const PUNCTUATION_KEYS = new Set(["`", "[", "]", ",", "=", "-", ".", ";", "/"]);
const SHIFTED_KEYS = new Map([
  ["~", "`"],
  ["{", "["],
  ["}", "]"],
  ["<", ","],
  ["+", "="],
  ["_", "-"],
  [">", "."],
  [":", ";"],
  ["?", "/"],
]);
const PUNCTUATION_CODES = new Map([
  ["Backquote", "`"],
  ["BracketLeft", "["],
  ["BracketRight", "]"],
  ["Comma", ","],
  ["Equal", "="],
  ["Minus", "-"],
  ["Period", "."],
  ["Semicolon", ";"],
  ["Slash", "/"],
]);
const MODIFIER_KEYS = new Set([
  "Shift",
  "Alt",
  "Control",
  "Meta",
  "AltGraph",
  "Unidentified",
]);
const MAC = /Mac OS X|Macintosh/.test(navigator.userAgent);
// A lone modifier, an IME composition, AltGr off macOS, and a dead key the
// Option fallback cannot place name no chord. A letter or supported symbol
// the layout typed always wins; only when Option left neither does the
// physical position decide.
function shortcutKey(event) {
  const key = event.key;
  if (!key || MODIFIER_KEYS.has(key) || event.isComposing || key === "Process")
    return null;
  if (!MAC && event.getModifierState("AltGraph")) return null;
  const token = (name, shifted = false, consumable = false) => ({
    key: name,
    shifted,
    consumable,
  });
  const digit = /^Digit([0-9])$/.exec(event.code);
  if (digit) return token(digit[1]);
  if (/^[a-z]$/i.test(key)) return token(key.toUpperCase());
  if (PUNCTUATION_KEYS.has(key)) return token(key, false, true);
  if (SHIFTED_KEYS.has(key)) return token(SHIFTED_KEYS.get(key), true);
  if (event.altKey) {
    const letter = /^Key([A-Z])$/.exec(event.code);
    const position = letter ? letter[1] : PUNCTUATION_CODES.get(event.code);
    if (position) return token(position);
  }
  if (key === "Dead") return null;
  return token(key.length === 1 ? key.toUpperCase() : key);
}
// The exact chord, or the same chord without a Shift that only typed a
// punctuation symbol.
function claimedByHost(event) {
  const resolved = shortcutKey(event);
  if (!resolved) return false;
  const matches = (key, shiftKey) =>
    key?.key === resolved.key &&
    key.ctrlKey === event.ctrlKey &&
    key.altKey === event.altKey &&
    key.metaKey === event.metaKey &&
    key.shiftKey === shiftKey;
  return (state.hostKeys ?? []).some(
    (key) =>
      matches(key, event.shiftKey || resolved.shifted) ||
      (event.shiftKey && resolved.consumable && matches(key, false)),
  );
}
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  if (event.data?.type === HOST_KEYMAP && Array.isArray(event.data.keys))
    state.hostKeys = event.data.keys;
});
window.addEventListener(
  "keydown",
  (event) => {
    if (event.defaultPrevented || !claimedByHost(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.parent.postMessage(
      {
        type: HOST_KEYDOWN,
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        isComposing: event.isComposing,
        altGraph: event.getModifierState("AltGraph"),
      },
      "*",
    );
  },
  true,
);
// End of Chan's keyboard relay.

installWorkerTimers();

const api = {
  defaults: DEFAULT_SETTINGS,
  editorKeys: EDITOR_SETTING_KEYS,
  editor: () => state.editor,
  settings: currentSettings,
  setSetting,
  resetSettings,
  patterns: {
    list: patternList,
    activeId: () => state.doc.active,
    open: openPattern,
    create: newPattern,
    duplicate: duplicatePattern,
    remove: deletePattern,
  },
  appendCode(code) {
    state.editor?.appendCode(code);
    scheduleSave();
  },
  isStarted: () => state.started,
  on,
  notice,
  status,
  flush,
};

async function start() {
  loadAbout().catch(() => {});
  let migrated = false;
  try {
    ({ doc: state.doc, migrated } = normalizeDoc(await getJson("state")));
  } catch (error) {
    state.loadFailed = true;
    notice(`Saved patterns unavailable, nothing will be saved: ${error.message}`);
  }
  if (!state.doc.patterns.length) {
    state.doc.active = createPattern(DEFAULT_CODE).id;
    migrated = true;
  }
  if (!activePattern()) {
    state.doc.active = patternList()[0].id;
    migrated = true;
  }
  mountEditor(activePattern().code);
  applyAllSettings();
  // Globals appear once prebake resolves; the audio setters are among them.
  Promise.resolve(state.editor?.prebaked)
    .then(applyAudioSettings)
    .catch(() => {});
  state.panel = createPanel(api, ui.panel);
  wireHeader();
  if (migrated) {
    state.dirty = true;
    scheduleSave();
  }
  if (state.editor) status("Click once to unlock audio, then Ctrl+Enter.");
  window.parent.postMessage({ type: HOST_READY }, "*");
}
start().catch((error) => notice(error.message));
