// The panel beside the editor: the tabs strudel.cc shows, rebuilt on the
// component's API and the globals Strudel publishes after prebake.
const LOG_LIMIT = 100;
const GLOBAL_POLL_MS = 300;
const GLOBAL_POLL_LIMIT_MS = 60000;
const TABS = [
  ["welcome", "welcome"],
  ["patterns", "patterns"],
  ["sounds", "sounds"],
  ["reference", "reference"],
  ["export", "export"],
  ["console", "console"],
  ["settings", "settings"],
];
const SOUND_FILTERS = [
  ["samples", "samples"],
  ["drums", "drum-machines"],
  ["synths", "synths"],
  ["wavetables", "wavetables"],
];
const THEME_NAMES = [
  "strudelTheme",
  "algoboy",
  "archBtw",
  "androidstudio",
  "atomone",
  "aura",
  "bbedit",
  "blackscreen",
  "bluescreen",
  "bluescreenlight",
  "CutiePi",
  "darcula",
  "dracula",
  "duotoneDark",
  "eclipse",
  "fruitDaw",
  "githubDark",
  "githubLight",
  "greenText",
  "gruvboxDark",
  "gruvboxLight",
  "sonicPink",
  "materialDark",
  "materialLight",
  "monokai",
  "noctisLilac",
  "nord",
  "redText",
  "solarizedDark",
  "solarizedLight",
  "sublime",
  "teletext",
  "tokyoNight",
  "tokyoNightDay",
  "tokyoNightStorm",
  "vscodeDark",
  "vscodeLight",
  "whitescreen",
  "xcodeLight",
];
const FONT_FAMILIES = [
  "monospace",
  "ui-monospace",
  "Courier New",
  "Consolas",
  "Menlo",
  "JetBrains Mono",
  "Fira Code",
  "Hack",
];
const KEYBINDINGS = [
  ["codemirror", "CodeMirror"],
  ["vim", "Vim"],
  ["emacs", "Emacs"],
  ["vscode", "VSCode"],
];
const EDITOR_TOGGLES = [
  ["isBracketMatchingEnabled", "Enable bracket matching"],
  ["isBracketClosingEnabled", "Auto close brackets"],
  ["isLineNumbersDisplayed", "Display line numbers"],
  ["isActiveLineHighlighted", "Highlight active line"],
  ["isPatternHighlightingEnabled", "Highlight events in code"],
  ["isAutoCompletionEnabled", "Enable auto-completion"],
  ["isTooltipEnabled", "Enable tooltips on Ctrl and hover"],
  ["isLineWrappingEnabled", "Enable line wrapping"],
  ["isTabIndentationEnabled", "Enable Tab indentation"],
  ["isMultiCursorEnabled", "Enable multi-cursor (Ctrl+Click)"],
  ["isFlashEnabled", "Enable flashing on evaluation"],
];
const ALLOW_MANY = ["by", "url", "genre", "license", "tag"];

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "value") node.value = value;
    else if (key === "checked") node.checked = Boolean(value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}
function button(label, onclick, attrs = {}) {
  return h("button", { type: "button", onclick, ...attrs }, label);
}
// A destructive action needs two clicks within three seconds: dialogs are
// blocked in the sandbox, so this stands in for a confirmation.
function armedButton(label, confirmLabel, action) {
  let armed = null;
  const node = button(label, () => {
    if (armed) {
      clearTimeout(armed);
      armed = null;
      node.textContent = label;
      action();
      return;
    }
    node.textContent = confirmLabel;
    armed = setTimeout(() => {
      armed = null;
      node.textContent = label;
    }, 3000);
  });
  return node;
}
function formItem(label, ...controls) {
  return h("div", { class: "form-item" }, h("span", { class: "label" }, label), ...controls);
}
function buttonGroup(options, current, onChange) {
  const group = h("div", { class: "row group", role: "group" });
  for (const [value, label] of options) {
    group.append(
      button(label, () => onChange(value), {
        "aria-pressed": String(value === current),
      }),
    );
  }
  return group;
}
function whenGlobal(name, fn) {
  if (globalThis[name] !== undefined) {
    fn(globalThis[name]);
    return;
  }
  const started = Date.now();
  const timer = setInterval(() => {
    if (globalThis[name] !== undefined) {
      clearInterval(timer);
      fn(globalThis[name]);
    } else if (Date.now() - started > GLOBAL_POLL_LIMIT_MS) {
      clearInterval(timer);
    }
  }, GLOBAL_POLL_MS);
}

// Strudel's own title and tag syntax: `// "title"` as the first comment, and
// `@by name` style tags in any comment.
export function patternMetadata(code) {
  const comments = [...(code ?? "").matchAll(/\/\*([\s\S]*?)\*\/|\/\/(.*)$/gm)].map(
    (match) => (match[1] || match[2] || "").trim(),
  );
  const tags = {};
  const [prefix, title] = (comments[0] || "").split('"');
  if (prefix.trim() === "" && title !== undefined) tags.title = title;
  for (const comment of comments) {
    for (const tagMatch of comment.split("@").slice(1)) {
      let [tag, value] = tagMatch.split(/ (.*)/s);
      tag = tag.trim();
      value = (value || "").replaceAll(/ +/g, " ").trim();
      if (ALLOW_MANY.includes(tag)) {
        const list = value
          .split(/[,\n]/)
          .map((item) => item.trim())
          .filter(Boolean);
        tags[tag] = tag in tags ? tags[tag].concat(list) : list;
      } else {
        value = value.replaceAll(/\s+/g, " ");
        tags[tag] = tag in tags ? `${tags[tag]} ${value}` : value;
      }
    }
  }
  return tags;
}
export function patternLabel(pattern) {
  const meta = patternMetadata(pattern.code);
  let title = meta.title;
  if (title == null || title === "") {
    const date = new Date(pattern.created_at);
    title = Number.isNaN(date.getTime()) ? pattern.id : date.toLocaleString();
  }
  const author = Array.isArray(meta.by) ? meta.by.join(",") : "Anonymous";
  return `${title} by ${author.slice(0, 100)}`.slice(0, 60);
}

// Strudel's logger raises a document event per message; the console tab shows
// the last hundred, with repeats counted and a loaded sample replacing its
// loading line.
const log = { entries: [], next: 1, listeners: new Set() };
document.addEventListener("strudel.log", (event) => {
  const detail = event.detail ?? {};
  const { message, type, data } = detail;
  if (typeof message !== "string") return;
  const entries = log.entries;
  const last = entries[entries.length - 1];
  if (type === "loaded-sample") {
    const index = entries.findIndex(
      (entry) => entry.type === "load-sample" && entry.data?.url === data?.url,
    );
    const entry = { message, type, data, count: 0, id: log.next++ };
    if (index >= 0) entries[index] = entry;
    else entries.push(entry);
  } else if (last && last.message === message) {
    last.count = (last.count || 1) + 1;
  } else {
    entries.push({ message, type, data, count: 0, id: log.next++ });
  }
  if (entries.length > LOG_LIMIT) entries.splice(0, entries.length - LOG_LIMIT);
  for (const fn of log.listeners) fn();
});

export function createPanel(api, root) {
  const tabs = new Map();
  const nav = h("nav", { class: "tabs", "aria-label": "Panel tabs" });
  const bar = h(
    "div",
    { class: "panel-bar" },
    button("\u00d7", () => api.setSetting("isPanelOpen", false), {
      class: "panel-toggle",
      title: "Close the panel",
      "aria-label": "Close the panel",
    }),
    nav,
  );
  const body = h("div", { class: "panel-body" });
  const opener = button("\u2039", () => api.setSetting("isPanelOpen", true), {
    class: "panel-open",
    title: "Open the panel",
    "aria-label": "Open the panel",
  });
  root.replaceChildren(opener, bar, body);
  const renderers = {
    welcome: renderWelcome,
    patterns: renderPatterns,
    sounds: renderSounds,
    reference: renderReference,
    export: renderExport,
    console: renderConsole,
    settings: renderSettings,
  };
  for (const [name, label] of TABS) {
    const tab = h("button", { type: "button", class: "tab", onclick: () => show(name) }, label);
    const pane = h("section", { class: "pane", hidden: true, "aria-label": label });
    nav.append(tab);
    body.append(pane);
    tabs.set(name, { tab, pane, mounted: false });
  }
  function show(name) {
    if (!tabs.has(name)) name = "welcome";
    for (const [other, entry] of tabs) {
      const active = other === name;
      entry.tab.classList.toggle("active", active);
      entry.pane.hidden = !active;
      if (active && !entry.mounted) {
        entry.mounted = true;
        try {
          renderers[other](entry.pane, api);
        } catch (error) {
          entry.pane.replaceChildren(h("p", { class: "muted" }, `This tab failed: ${error.message}`));
        }
      }
    }
    if (api.settings().activeTab !== name) api.setSetting("activeTab", name);
  }
  show(api.settings().activeTab);
  return { show };
}

function renderWelcome(pane) {
  pane.append(
    h("h2", {}, "welcome"),
    h(
      "p",
      {},
      "This is Strudel, a live coding platform for writing dynamic music in the browser, running on your own Chan devserver. It is free and open source, made for beginners and experts alike.",
    ),
    h("p", {}, "1. click anywhere once to unlock audio, 2. hit play or Ctrl+Enter, 3. change something, 4. hit update."),
    h("p", {}, "Alt+. stops. Your patterns are saved on the devserver as you type and come back when you reopen the tab."),
    h("h2", {}, "learn"),
    h(
      "p",
      {},
      "The interactive workshop and the full documentation live on strudel.cc; the learn button above shows the link. The reference tab here lists every documented function, and clicking an example appends it to the editor.",
    ),
    h("h2", {}, "about"),
    h(
      "p",
      {},
      "Strudel is a JavaScript port of TidalCycles, made by the Strudel contributors and published under the GNU Affero General Public License at codeberg.org/uzu/strudel. The default sound banks have their own licensing notes in the dough-samples repository. This Chan extension embeds the published Strudel REPL unchanged; the About menu names the exact release.",
    ),
  );
}

function renderPatterns(pane, api) {
  const search = h("input", { type: "search", placeholder: "Search", "aria-label": "Search patterns" });
  const actions = h(
    "div",
    { class: "row" },
    button("new", () => api.patterns.create()),
    button("duplicate", () => api.patterns.duplicate(api.patterns.activeId())),
    armedButton("delete", "really delete?", () => api.patterns.remove(api.patterns.activeId())),
  );
  const list = h("div", { class: "list", role: "list" });
  pane.append(search, actions, list);
  function matches(pattern, query) {
    if (!query) return true;
    const meta = patternMetadata(pattern.code);
    const haystack = [
      patternLabel(pattern),
      ...(Array.isArray(meta.tag) ? meta.tag : []),
      ...(Array.isArray(meta.genre) ? meta.genre : []),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  }
  function render() {
    const query = search.value.trim().toLowerCase();
    const active = api.patterns.activeId();
    const items = api.patterns
      .list()
      .filter((pattern) => matches(pattern, query))
      .map((pattern) =>
        button(patternLabel(pattern), () => api.patterns.open(pattern.id), {
          class: pattern.id === active ? "list-item active" : "list-item",
          role: "listitem",
          title: pattern.id,
        }),
      );
    list.replaceChildren(...items);
    if (!items.length) list.append(h("p", { class: "muted" }, query ? "No patterns found" : "No patterns yet"));
  }
  search.addEventListener("input", render);
  api.on("patterns", render);
  render();
}

function renderSounds(pane, api) {
  let filter = "samples";
  let held = null;
  let digit = 0;
  const search = h("input", { type: "search", placeholder: "Search", "aria-label": "Search sounds" });
  const filters = h("div");
  const list = h("div", { class: "sounds" });
  const hint = h("p", { class: "muted" }, "Loading sounds...");
  pane.append(search, filters, list, hint);
  function renderFilters() {
    filters.replaceChildren(
      buttonGroup(SOUND_FILTERS, filter, (value) => {
        filter = value;
        renderFilters();
        render();
      }),
    );
  }
  function accept(data) {
    const type = data?.type;
    if (filter === "drums") return type === "sample" && data.tag === "drum-machines";
    if (filter === "samples") return type === "sample" && data.tag !== "drum-machines";
    if (filter === "synths") return type === "synth" || type === "soundfont";
    if (filter === "wavetables") return type === "wavetable";
    return true;
  }
  function count(data) {
    const size = (value) =>
      Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : 1;
    if (data?.type === "sample") return `(${size(data.samples)})`;
    if (data?.type === "wavetable") return `(${size(data.tables)})`;
    if (data?.type === "soundfont") return `(${data.fonts?.length ?? 0})`;
    return "";
  }
  async function preview(name, entry) {
    const getContext = globalThis.getAudioContext;
    const connect = globalThis.connectToDestination;
    if (typeof getContext !== "function" || typeof entry?.onTrigger !== "function") return;
    const context = getContext();
    const params = {
      note: ["synth", "soundfont"].includes(entry.data?.type) ? "a3" : undefined,
      s: name,
      n: digit,
      clip: 1,
      release: 0.5,
      sustain: 1,
      duration: 0.5,
    };
    const onended = () => held?.node?.disconnect?.();
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const ref = await entry.onTrigger(context.currentTime + 0.05, params, onended);
        held = ref;
        if (ref?.node) {
          if (typeof connect === "function") connect(ref.node);
          return;
        }
      } catch {
        // The sample is still loading; try again shortly.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  function render() {
    const sounds = globalThis.soundMap?.get?.();
    if (!sounds) return;
    const query = search.value.trim().toLowerCase();
    const entries = Object.entries(sounds)
      .filter(([name]) => !name.startsWith("_"))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .filter(([name]) => name.toLowerCase().includes(query))
      .filter(([, entry]) => accept(entry?.data));
    list.replaceChildren(
      ...entries.map(([name, entry]) =>
        h(
          "span",
          {
            class: "sound",
            title: "Hold to preview; hold a digit for another sample index",
            onmousedown: () => preview(name, entry),
          },
          `${name}${count(entry?.data)}`,
        ),
      ),
    );
    hint.textContent = entries.length
      ? "Hold a name to preview it. Hold a digit key for another sample index."
      : query
        ? "No sounds found"
        : "No sounds loaded";
  }
  document.addEventListener("mouseup", () => {
    const ref = held;
    held = null;
    try {
      ref?.stop?.(globalThis.getAudioContext?.().currentTime + 0.01);
    } catch {
      // Already stopped.
    }
  });
  document.addEventListener("keydown", (event) => {
    if (/^[0-9]$/.test(event.key)) digit = Number(event.key);
  });
  document.addEventListener("keyup", () => {
    digit = 0;
  });
  search.addEventListener("input", render);
  renderFilters();
  whenGlobal("soundMap", (map) => {
    let timer = null;
    map.subscribe?.(() => {
      clearTimeout(timer);
      timer = setTimeout(render, 150);
    });
    render();
  });
}

let referenceIndex = null;
function loadReference() {
  referenceIndex ??= import("./strudel-reference.mjs").then((module) => {
    const docs = module.reference?.docs ?? (Array.isArray(module.reference) ? module.reference : []);
    const seen = new Set();
    const functions = [];
    for (const doc of docs) {
      if (!doc?.name || doc.name.startsWith("_") || !doc.description) continue;
      functions.push(doc);
      for (const synonym of doc.synonyms ?? []) {
        if (!synonym || seen.has(synonym)) continue;
        seen.add(synonym);
        const others = [doc.name, ...(doc.synonyms ?? [])].filter((name) => name && name !== synonym);
        functions.push({ ...doc, name: synonym, synonyms: others });
      }
    }
    return functions.sort((a, b) => a.name.localeCompare(b.name));
  });
  return referenceIndex;
}
function renderReference(pane, api) {
  const search = h("input", { type: "search", placeholder: "Search", "aria-label": "Search the reference" });
  const names = h("div", { class: "reference-list" });
  const doc = h("div", { class: "reference-doc" });
  pane.append(search, h("div", { class: "reference" }, names, doc));
  doc.append(h("p", { class: "muted" }, "Loading the reference..."));
  loadReference()
    .then((functions) => {
      function render() {
        const query = search.value.trim().toLowerCase();
        const visible = functions.filter(
          (entry) =>
            !query ||
            entry.name.toLowerCase().includes(query) ||
            (entry.synonyms ?? []).some((synonym) => synonym.toLowerCase().includes(query)),
        );
        const sections = visible.map((entry, index) => {
          const section = h("section", { id: `doc-${index}` }, h("h3", {}, entry.name));
          if (entry.synonyms?.length) {
            section.append(h("p", { class: "muted" }, `Synonyms: ${entry.synonyms.join(", ")}`));
          }
          const description = h("div");
          description.innerHTML = entry.description;
          section.append(description);
          if (entry.params?.length) {
            section.append(
              h(
                "ul",
                {},
                ...entry.params.map((param) =>
                  h("li", {}, `${param.name}: ${param.type?.names?.join(" | ") ?? ""} ${textOf(param.description)}`),
                ),
              ),
            );
          }
          for (const example of entry.examples ?? []) {
            section.append(
              h(
                "pre",
                {
                  title: "Click to append this example to the editor",
                  onclick: () => {
                    api.appendCode(`\n${example}\n`);
                    api.status("Example appended to the editor");
                  },
                },
                example,
              ),
            );
          }
          return section;
        });
        names.replaceChildren(
          ...visible.map((entry, index) =>
            button(entry.name, () => {
              doc.querySelector(`#doc-${index}`)?.scrollIntoView({ block: "start" });
            }),
          ),
        );
        doc.replaceChildren(
          h("h2", {}, "API reference"),
          h(
            "p",
            { class: "muted" },
            "Every documented function. You do not need all of them: a small set already makes music.",
          ),
          ...sections,
        );
        if (!visible.length) doc.append(h("p", { class: "muted" }, "Nothing matches"));
      }
      search.addEventListener("input", render);
      render();
    })
    .catch((error) => {
      doc.replaceChildren(h("p", { class: "muted" }, `Reference unavailable: ${error.message}`));
    });
}
function textOf(html) {
  if (!html) return "";
  const node = document.createElement("div");
  node.innerHTML = html;
  return node.textContent ?? "";
}

function renderExport(pane, api) {
  const name = h("input", { type: "text", placeholder: "Leave empty for a timestamp", "aria-label": "File name" });
  const begin = h("input", { type: "number", min: "0", step: "1", value: "0", "aria-label": "Start cycle" });
  const end = h("input", { type: "number", min: "1", step: "1", value: "4", "aria-label": "End cycle" });
  const sampleRate = h("input", { type: "number", min: "8000", step: "1", value: "48000", "aria-label": "Sample rate" });
  const polyphony = h("input", { type: "number", min: "1", step: "1", value: "1024", "aria-label": "Maximum polyphony" });
  const orbits = h("input", { type: "checkbox", checked: true });
  const progress = h("div", { class: "progress" }, h("div"));
  const result = h("p", { class: "muted" }, "The file is written on the devserver under the extension's data directory.");
  const run = button("Export to WAV", async () => {
    run.disabled = true;
    result.textContent = "Rendering...";
    const bar = progress.firstChild;
    bar.style.width = "2%";
    let poll = null;
    try {
      const parameters = {
        begin: Math.max(0, Number(begin.value) || 0),
        end: Math.max(1, Number(end.value) || 1),
        sampleRate: Math.max(8000, Number(sampleRate.value) || 48000),
        maxPolyphony: Math.max(1, Number(polyphony.value) || 1024),
        multiChannelOrbits: orbits.checked,
      };
      if (parameters.end <= parameters.begin) parameters.end = parameters.begin + 1;
      poll = setInterval(() => {
        const context = globalThis.getAudioContext?.();
        if (context instanceof OfflineAudioContext && context.length) {
          bar.style.width = `${Math.min(99, 2 + (context.currentTime * context.sampleRate * 97) / context.length)}%`;
        }
      }, 200);
      const saved = await exportWav(api, name.value, parameters);
      bar.style.width = "100%";
      result.textContent = `Saved ${saved.path} (${Math.round(saved.bytes / 1024)} KiB)`;
      api.status("Export saved");
    } catch (error) {
      result.textContent = `Export failed: ${error.message}`;
    } finally {
      clearInterval(poll);
      run.disabled = false;
      setTimeout(() => {
        bar.style.width = "0";
      }, 1500);
    }
  });
  pane.append(
    formItem("File name", name),
    h("div", { class: "row" }, formItem("Start cycle", begin), formItem("End cycle", end)),
    h("div", { class: "row" }, formItem("Sample rate", sampleRate), formItem("Maximum polyphony", polyphony)),
    h("label", {}, orbits, "Multi-channel orbits"),
    run,
    progress,
    result,
  );
}
// Strudel renders offline and hands the WAV to a download, which the sandbox
// blocks. The blob is captured while the render runs and sent to the server.
async function exportWav(api, requestedName, parameters) {
  const editor = api.editor();
  const render = globalThis.renderPatternAudio;
  const initAudio = globalThis.initAudio;
  if (!editor || typeof render !== "function" || typeof initAudio !== "function") {
    throw new Error("Strudel is still loading");
  }
  await editor.evaluate(false);
  editor.repl.scheduler.stop();
  let captured = null;
  const createObjectURL = URL.createObjectURL;
  const click = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = function (object) {
    if (object instanceof Blob && object.type === "audio/wav") captured = object;
    return createObjectURL.call(URL, object);
  };
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && captured) return undefined;
    return click.call(this);
  };
  try {
    await render(
      editor.repl.state.pattern,
      editor.repl.scheduler.cps,
      parameters.begin,
      parameters.end,
      parameters.sampleRate,
      parameters.maxPolyphony,
      parameters.multiChannelOrbits,
      requestedName || undefined,
    );
  } finally {
    URL.createObjectURL = createObjectURL;
    HTMLAnchorElement.prototype.click = click;
    const settings = api.settings();
    try {
      await initAudio({
        maxPolyphony: settings.maxPolyphony,
        multiChannelOrbits: settings.multiChannelOrbits,
      });
    } catch (error) {
      console.warn("audio restart", error);
    }
    editor.repl.scheduler.stop();
  }
  if (!captured) throw new Error("No audio was rendered");
  const response = await fetch(`export?name=${encodeURIComponent(requestedName)}`, {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: captured,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function renderConsole(pane) {
  const list = h("div", { class: "log", role: "log", "aria-live": "polite" });
  const clear = button("clear", () => {
    log.entries.length = 0;
    render();
  });
  pane.append(h("div", { class: "row" }, clear), list);
  function render() {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.replaceChildren(
      ...log.entries.map((entry) => {
        const line = h(
          "div",
          {
            class: entry.type === "error" ? "log-error" : entry.type === "highlight" ? "log-highlight" : "",
          },
          entry.count ? `${entry.message} (${entry.count})` : entry.message,
        );
        const color = entry.data?.hap?.value?.color;
        if (typeof color === "string") line.style.color = color;
        return line;
      }),
    );
    if (!log.entries.length) list.append(h("p", { class: "muted" }, "Nothing logged yet"));
    if (atBottom) list.scrollTop = list.scrollHeight;
  }
  log.listeners.add(render);
  render();
}

function renderSettings(pane, api) {
  function render() {
    const settings = api.settings();
    const themes = Object.keys(globalThis.themes ?? {});
    const themeNames = themes.length ? themes : THEME_NAMES;
    const fonts = FONT_FAMILIES.includes(settings.fontFamily)
      ? FONT_FAMILIES
      : [settings.fontFamily, ...FONT_FAMILIES];
    const select = (options, current, onChange, label) =>
      h(
        "select",
        { "aria-label": label, onchange: (event) => onChange(event.target.value) },
        ...options.map((option) => h("option", { value: option, selected: option === current }, option)),
      );
    const fontSizeLabel = h("span", { class: "label" }, `Font size: ${settings.fontSize}`);
    const fontSize = h("input", {
      type: "range",
      min: "10",
      max: "40",
      step: "1",
      value: String(settings.fontSize),
      "aria-label": "Font size",
      oninput: (event) => {
        fontSizeLabel.textContent = `Font size: ${event.target.value}`;
        api.setSetting("fontSize", Number(event.target.value));
      },
    });
    const polyphony = h("input", {
      type: "number",
      min: "1",
      step: "1",
      value: String(settings.maxPolyphony),
      "aria-label": "Maximum polyphony",
      onchange: (event) => api.setSetting("maxPolyphony", Math.max(1, Number(event.target.value) || 1)),
    });
    pane.replaceChildren(
      formItem("Theme", select(themeNames, settings.theme, (value) => api.setSetting("theme", value), "Theme")),
      formItem(
        "Font family",
        select(fonts, settings.fontFamily, (value) => api.setSetting("fontFamily", value), "Font family"),
      ),
      h("div", { class: "form-item" }, fontSizeLabel, fontSize),
      formItem("Keybindings", buttonGroup(KEYBINDINGS, settings.keybindings, (value) => api.setSetting("keybindings", value))),
      formItem(
        "Panel position",
        buttonGroup(
          [
            ["right", "Right"],
            ["bottom", "Bottom"],
          ],
          settings.panelPosition,
          (value) => api.setSetting("panelPosition", value),
        ),
      ),
      formItem("Maximum polyphony", polyphony),
      h(
        "label",
        {},
        h("input", {
          type: "checkbox",
          checked: settings.multiChannelOrbits,
          onchange: (event) => api.setSetting("multiChannelOrbits", event.target.checked),
        }),
        "Multi-channel orbits",
      ),
      h(
        "div",
        { class: "form-item toggles" },
        h("span", { class: "label" }, "Editor"),
        ...EDITOR_TOGGLES.map(([key, label]) =>
          h(
            "label",
            {},
            h("input", {
              type: "checkbox",
              checked: Boolean(settings[key]),
              onchange: (event) => api.setSetting(key, event.target.checked),
            }),
            label,
          ),
        ),
      ),
      h("div", { class: "row" }, armedButton("restore default settings", "really restore?", () => api.resetSettings())),
      h(
        "p",
        { class: "muted" },
        "Audio output device, WebMIDI, and imported sample folders need permissions Chan's extension sandbox does not grant.",
      ),
    );
  }
  // Controls apply their own change; only a reset rebuilds the form.
  api.on("settings-reset", render);
  render();
}
