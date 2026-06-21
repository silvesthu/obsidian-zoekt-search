const {
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  setIcon,
} = require("obsidian");

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const SEARCH_MODE_TEXT = "text";
const SEARCH_MODE_FILE = "file";
const TOGGLE_REGEX_COMMAND_ID = "toggle-regex";

const DEFAULT_SETTINGS = {
  endpoint: "http://127.0.0.1:6070/api/search",
  zoektRepo: "",
  maxResults: 80,
  contextLines: 2,
  regex: false,
  escapeSpace: true,
  logLevel: "Basic",
};

function postJson(endpoint, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch (error) {
      reject(error);
      return;
    }

    const body = JSON.stringify(payload);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      {
        method: "POST",
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.setEncoding("utf8");
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = chunks.join("");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(text || `HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on("timeout", () => req.destroy(new Error("Search request timed out")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function basename(path) {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function folderPath(path) {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function normalizeWinPath(path) {
  return String(path || "").replace(/\//g, "\\").replace(/\\+$/, "");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function queryTerms(query) {
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = re.exec(query))) {
    const term = (match[1] || match[2] || "").trim();
    if (term.length >= 2) terms.push(term);
  }
  return terms.slice(0, 8);
}

function normalizeInitialQuery(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function escapeForContent(term) {
  return escapeRegExp(term).replace(/"/g, "\\x22");
}

function encodeLiteralSpaces(query) {
  return query.replace(/ /g, "\\x20").replace(/\t/g, "\\x09");
}

function normalizeFileQueryInput(raw) {
  return String(raw || "")
    .trim()
    .replace(/^file:/i, "")
    .trim();
}

function transformTextQuery(raw, regex, escapeSpace) {
  let query = String(raw || "").trim();
  if (regex) {
    if (escapeSpace) query = encodeLiteralSpaces(query);
    return query;
  }

  if (escapeSpace) {
    return `content:${encodeLiteralSpaces(escapeForContent(query))}`;
  }

  const terms = query.split(/\s+/).filter(Boolean);
  return terms.map((term) => `content:${escapeForContent(term)}`).join(" ");
}

function transformFileQuery(raw, regex, escapeSpace) {
  let query = normalizeFileQueryInput(raw);
  if (!query) return "";
  if (regex) {
    if (escapeSpace) query = encodeLiteralSpaces(query);
    return `file:${query}`;
  }

  if (escapeSpace) {
    return `file:${encodeLiteralSpaces(escapeRegExp(query))}`;
  }

  const terms = query.split(/\s+/).filter(Boolean);
  return terms.map((term) => `file:${escapeRegExp(term)}`).join(" ");
}

function buildZoektQuery(query, repo) {
  return `repo:^${escapeRegExp(repo)}$ ( ${query} )`;
}

function decodeZoektText(value) {
  if (!value) return "";
  try {
    return Buffer.from(String(value), "base64").toString("utf8");
  } catch (error) {
    return String(value);
  }
}

function splitContextLines(value) {
  const text = decodeZoektText(value).replace(/[\r\n]+$/g, "");
  if (!text) return [];
  return text.split("\n").map((line) => line.replace(/\r$/g, ""));
}

function countLineFragments(lineMatch) {
  const fragments = lineMatch && lineMatch.LineFragments;
  return Array.isArray(fragments) ? Math.max(1, fragments.length) : 1;
}

function flattenZoektResponse(data, max, contextLines) {
  const rows = [];
  const files = data?.Result?.Files;
  if (!Array.isArray(files)) {
    return { rows, shown: 0, total: 0 };
  }

  let shownFragments = 0;
  outer: for (const file of files) {
    const repo = String(file.Repository || "");
    const fileName = String(file.FileName || "");
    if (Array.isArray(file.LineMatches) && file.LineMatches.length) {
      for (const match of file.LineMatches) {
        if (rows.length >= max) break outer;
        rows.push({
          kind: "line",
          repo,
          file: fileName,
          line: Number(match.LineNumber || 0),
          text: decodeZoektText(match.Line).replace(/[\r\n]+$/g, ""),
          before: contextLines > 0 ? splitContextLines(match.Before) : [],
          after: contextLines > 0 ? splitContextLines(match.After) : [],
        });
        shownFragments += countLineFragments(match);
      }
    } else if (Array.isArray(file.ChunkMatches) && file.ChunkMatches.length) {
      for (const match of file.ChunkMatches) {
        if (rows.length >= max) break outer;
        rows.push({
          kind: "chunk",
          repo,
          file: fileName,
          line: Number(match.ContentStart?.LineNumber || 0),
          text: decodeZoektText(match.Content).replace(/[\r\n]+$/g, ""),
          before: [],
          after: [],
        });
        shownFragments += Array.isArray(match.Ranges)
          ? Math.max(1, match.Ranges.length)
          : 1;
      }
    } else if (fileName) {
      if (rows.length >= max) break outer;
      rows.push({
        kind: "file",
        repo,
        file: fileName,
        line: 0,
        text: fileName,
        before: [],
        after: [],
      });
      shownFragments += 1;
    }
  }

  const matchCount = Number(data?.Result?.MatchCount || 0);
  const total = Math.max(matchCount, shownFragments, rows.length);
  return { rows, shown: rows.length, total };
}

function logValue(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/\s+/g, "_")
    .replace(/[|]/g, "_");
}

function rowsToResults(rows, plugin) {
  const results = [];
  for (const [index, row] of (rows || []).entries()) {
    const path = plugin.toVaultRelativePath(row.file);
    if (!path || path.startsWith(".obsidian/")) continue;
    const line = Number(row.line || 0);
    results.push({
      id: `${path}:${line}:${index}`,
      path,
      title: basename(path),
      folder: folderPath(path),
      kind: row.kind || "line",
      line,
      text: row.text || "",
      before: row.before || [],
      after: row.after || [],
    });
  }
  return results;
}

class ZoektSearchPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.logDiag("probe", "onload", {
      endpoint: this.settings.endpoint,
      repo: this.getZoektRepo(),
      logLevel: this.settings.logLevel,
    });

    this.addCommand({
      id: "vault-search",
      name: "Search Text",
      callback: () => new ZoektSearchModal(this, SEARCH_MODE_TEXT).open(),
    });

    this.addCommand({
      id: "search-file",
      name: "Search File",
      callback: () => new ZoektSearchModal(this, SEARCH_MODE_FILE).open(),
    });

    this.addCommand({
      id: TOGGLE_REGEX_COMMAND_ID,
      name: "Toggle Regex in search window",
      callback: () => {
        const modal = this.activeSearchModal;
        if (modal && Date.now() - (modal.lastScopedToggleAt || 0) > 100) {
          modal.toggleRegex("command_toggle_regex");
        }
      },
    });

    this.addRibbonIcon("search", "Zoekt search", () => {
      new ZoektSearchModal(this, SEARCH_MODE_TEXT).open();
    });

    this.addSettingTab(new ZoektSearchSettingTab(this.app, this));
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getPluginCommandId(id) {
    return `${this.manifest.id}:${id}`;
  }

  getToggleRegexShortcutLabel() {
    const hotkeys = this.getToggleRegexHotkeys();
    if (!hotkeys.length) return "No hotkey";
    return hotkeys.map((hotkey) => this.formatHotkey(hotkey)).join(", ");
  }

  getToggleRegexHotkeys() {
    const manager = this.app.hotkeyManager;
    const commandId = this.getPluginCommandId(TOGGLE_REGEX_COMMAND_ID);
    if (manager && typeof manager.getHotkeys === "function") {
      return manager.getHotkeys(commandId) || [];
    }
    if (manager && manager.customKeys) {
      return manager.customKeys[commandId] || [];
    }
    return [];
  }

  formatHotkey(hotkey) {
    const modifiers = hotkey.modifiers || [];
    const key = hotkey.key || "";
    return [...modifiers, key]
      .filter(Boolean)
      .map((part) => (part === "Mod" ? "Ctrl/Cmd" : part))
      .join("+");
  }

  getVaultBasePath() {
    const adapter = this.app.vault.adapter;
    if (adapter && typeof adapter.getBasePath === "function") {
      return adapter.getBasePath();
    }
    return "";
  }

  getDefaultZoektRepo() {
    const basePath = this.getVaultBasePath();
    if (!basePath) return "";
    return path.basename(normalizeWinPath(basePath)).toLowerCase();
  }

  getZoektRepo() {
    return String(this.settings.zoektRepo || "").trim() || this.getDefaultZoektRepo();
  }

  getDebugLogPath() {
    const basePath = this.getVaultBasePath();
    if (!basePath) {
      throw new Error("Vault base path is unavailable");
    }
    return path.join(
      basePath,
      ".obsidian",
      "plugins",
      "obsidian-zoekt-search",
      "debug.log",
    );
  }

  logDiag(phase, caseName, fields = {}) {
    try {
      if (!this.shouldLog(phase, caseName)) return;
      const logPath = this.getDebugLogPath();
      const parts = [
        "AI_DIAG",
        "task=obsidian_zoekt_search",
        `phase=${logValue(phase)}`,
        `case=${logValue(caseName)}`,
        `at=${new Date().toISOString()}`,
      ];
      for (const [key, value] of Object.entries(fields)) {
        parts.push(`${logValue(key)}=${logValue(value)}`);
      }
      fs.appendFileSync(logPath, `${parts.join("|")}\n`, "utf8");
    } catch (error) {
      console.warn("obsidian-zoekt-search: failed to write debug log", error);
    }
  }

  shouldLog(phase, caseName) {
    if (this.settings.logLevel === "Verbose") return true;
    if (caseName === "onload") return true;
    return /error|missing|fail|unavailable|timeout/i.test(`${phase} ${caseName}`);
  }

  toVaultRelativePath(path) {
    if (!path) return "";
    let value = String(path).replace(/\\/g, "/");
    const base = this.getVaultBasePath();
    if (base) {
      const normalizedBase = normalizeWinPath(base).replace(/\\/g, "/");
      if (value.toLowerCase().startsWith(normalizedBase.toLowerCase() + "/")) {
        value = value.slice(normalizedBase.length + 1);
      }
    }
    return normalizePath(value.replace(/^\/+/, ""));
  }

  async search(query, options = {}) {
    const context = Number(this.settings.contextLines) || 0;
    const max = Number(this.settings.maxResults) || 80;
    const repo = this.getZoektRepo();
    if (!repo) {
      throw new Error("Zoekt repo is not configured and vault folder name is unavailable.");
    }
    const mode = options.mode || SEARCH_MODE_TEXT;
    const regex = Boolean(options.regex);
    const transformed =
      mode === SEARCH_MODE_FILE
        ? transformFileQuery(query, regex, Boolean(this.settings.escapeSpace))
        : transformTextQuery(query, regex, Boolean(this.settings.escapeSpace));
    const body = {
      Q: buildZoektQuery(transformed, repo),
      Opts: {
        NumContextLines: context,
        MaxDocDisplayCount: max,
        MaxMatchDisplayCount: max,
      },
    };

    this.logDiag("probe", "search_request", {
      query,
      mode,
      regex,
      repo,
      max,
      context,
    });

    try {
      const data = await postJson(this.settings.endpoint, body);
      const flattened = flattenZoektResponse(data, max, context);
      this.logDiag("metric", "search_response", {
        rows: flattened.rows.length,
        shown: flattened.shown,
        total: flattened.total,
      });
      return flattened;
    } catch (error) {
      this.logDiag("result", "search_error", {
        message: error && error.message ? error.message : error,
      });
      throw error;
    }
  }

  async openResult(result) {
    this.logDiag("probe", "open_result_start", {
      path: result && result.path,
      line: result && result.line,
    });
    const file = this.app.vault.getAbstractFileByPath(result.path);
    if (!(file instanceof TFile)) {
      this.logDiag("result", "open_result_file_missing", {
        path: result && result.path,
      });
      new Notice(`File not found: ${result.path}`);
      return false;
    }

    try {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file, { active: true });
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const hasEditor = Boolean(view && view.editor);
      if (hasEditor && result.line > 0) {
        const line = Math.max(0, result.line - 1);
        view.editor.setCursor({ line, ch: 0 });
        view.editor.scrollIntoView(
          { from: { line, ch: 0 }, to: { line, ch: 0 } },
          true,
        );
      }
      this.logDiag("result", "open_result_done", {
        path: result.path,
        line: result.line,
        hasEditor,
      });
      return true;
    } catch (error) {
      this.logDiag("result", "open_result_error", {
        path: result.path,
        message: error && error.message ? error.message : error,
      });
      new Notice(`Open failed: ${error && error.message ? error.message : error}`);
      return false;
    }
  }
}

class ZoektSearchModal extends Modal {
  constructor(plugin, mode = SEARCH_MODE_TEXT) {
    super(plugin.app);
    this.plugin = plugin;
    this.mode = mode;
    this.regex = Boolean(plugin.settings.regex);
    this.results = [];
    this.selectedIndex = 0;
    this.requestId = 0;
    this.debounce = null;
    this.sourceView = this.app.workspace.getActiveViewOfType(MarkdownView);
    this.initialQuery = this.getInitialQuery("constructor");

    this.modalEl.replaceChildren();
    this.modalEl.addClass("zoekt-search-modal", "prompt");
    this.modalEl.removeClass("modal");
    this.modalEl.tabIndex = -1;

    this.scope.register([], "ArrowDown", (event) => {
      event.preventDefault();
      this.moveSelection(1, "scope_arrow_down");
    });
    this.scope.register([], "ArrowUp", (event) => {
      event.preventDefault();
      this.moveSelection(-1, "scope_arrow_up");
    });
    this.scope.register([], "Enter", (event) => {
      event.preventDefault();
      this.openSelected("scope_enter");
    });
    this.registerToggleRegexHotkeys();
  }

  onOpen() {
    this.plugin.logDiag("probe", "modal_open");
    this.plugin.activeSearchModal = this;
    this.modalEl.empty();
    const initialQuery =
      this.initialQuery || this.getInitialQuery("on_open");

    const inputContainer = this.modalEl.createDiv({
      cls: "zoekt-search-input-container",
    });
    const inputWrap = inputContainer.createDiv({
      cls: "zoekt-search-input-field",
    });
    this.inputEl = inputWrap.createEl("input", {
      type: "text",
      cls: "prompt-input",
      attr: {
        placeholder:
          this.mode === SEARCH_MODE_FILE
            ? "Search File - Vault"
            : "Search Text - Vault",
        spellcheck: "false",
      },
    });
    this.regexStatusEl = inputContainer.createDiv({
      cls: "zoekt-search-regex-status",
      attr: {
        title: "Toggle regex",
      },
    });
    this.regexStatusEl.addEventListener("mousedown", (event) =>
      event.preventDefault(),
    );
    this.regexStatusEl.addEventListener("click", (event) => {
      event.preventDefault();
      this.toggleRegex("mouse_toggle_regex");
      this.inputEl.focus();
    });
    this.updateRegexStatus();
    if (initialQuery) {
      this.inputEl.value = initialQuery;
      this.plugin.logDiag("probe", "initial_query_from_selection", {
        length: initialQuery.length,
        query: initialQuery,
      });
    }

    this.resultsEl = this.modalEl.createDiv({
      cls: "prompt-results",
      attr: {
        role: "presentation",
      },
    });
    this.resultsEl.addEventListener("mousedown", (event) => event.preventDefault());

    this.inputEl.addEventListener("input", () => this.scheduleSearch());
    this.inputEl.addEventListener("keydown", (event) => this.onKeydown(event));
    window.setTimeout(() => {
      this.inputEl.focus();
      if (initialQuery) {
        this.inputEl.select();
        this.runSearch();
      }
      this.logModalMetrics("after_focus");
    }, 0);
  }

  onClose() {
    this.plugin.logDiag("probe", "modal_close");
    if (this.plugin.activeSearchModal === this) {
      this.plugin.activeSearchModal = null;
    }
    window.clearTimeout(this.debounce);
    this.modalEl.empty();
  }

  onKeydown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.moveSelection(1, "dom_arrow_down");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.moveSelection(-1, "dom_arrow_up");
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.openSelected("dom_enter");
    }
  }

  toggleRegex(source) {
    this.regex = !this.regex;
    this.plugin.logDiag("probe", "toggle_regex", {
      source,
      mode: this.mode,
      regex: this.regex,
    });
    this.updateRegexStatus();
    if (this.inputEl && this.inputEl.value.trim()) {
      this.scheduleSearch();
    }
  }

  registerToggleRegexHotkeys() {
    const hotkeys = this.plugin.getToggleRegexHotkeys();
    const seen = new Set();
    for (const hotkey of hotkeys) {
      const modifiers = hotkey.modifiers || [];
      const key = hotkey.key || "";
      if (!key) continue;
      const keys = key.length === 1 ? [key, key.toUpperCase()] : [key];
      for (const candidate of keys) {
        const signature = `${modifiers.join("+")}+${candidate}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        this.scope.register(modifiers, candidate, (event) => {
          event.preventDefault();
          this.lastScopedToggleAt = Date.now();
          this.toggleRegex("scope_hotkey_toggle_regex");
        });
      }
    }
    this.plugin.logDiag("probe", "register_toggle_regex_hotkeys", {
      count: seen.size,
      label: this.plugin.getToggleRegexShortcutLabel(),
    });
  }

  updateRegexStatus() {
    if (!this.regexStatusEl) return;
    const shortcut = this.plugin.getToggleRegexShortcutLabel();
    this.regexStatusEl.setText(
      `Regex: ${this.regex ? "ON" : "OFF"} (${shortcut})`,
    );
    this.regexStatusEl.setAttr("title", `Toggle regex (${shortcut})`);
    this.regexStatusEl.toggleClass("is-enabled", this.regex);
  }

  getInitialQuery(stage) {
    const candidates = [];
    const sourceView = this.sourceView;
    const activeView = this.app.workspace.activeLeaf?.view;
    const workspaceEditor = this.app.workspace.activeEditor?.editor;

    if (sourceView?.editor?.getSelection) {
      candidates.push(["source_view", sourceView.editor.getSelection()]);
    }
    if (
      activeView instanceof MarkdownView &&
      activeView !== sourceView &&
      activeView.editor?.getSelection
    ) {
      candidates.push(["active_leaf", activeView.editor.getSelection()]);
    }
    if (workspaceEditor?.getSelection) {
      candidates.push(["workspace_editor", workspaceEditor.getSelection()]);
    }

    for (const [source, value] of candidates) {
      const query = normalizeInitialQuery(value);
      if (query) {
        this.plugin.logDiag("probe", "initial_query_probe", {
          stage,
          source,
          length: query.length,
        });
        return query;
      }
    }

    try {
      const selection = window.getSelection ? window.getSelection() : null;
      const domText = selection ? normalizeInitialQuery(selection.toString()) : "";
      if (!selection || selection.isCollapsed || !selection.rangeCount || !domText) {
        this.plugin.logDiag("probe", "initial_query_probe", {
          stage,
          source: "none",
          candidates: candidates.length,
        });
        return "";
      }
      const range = selection.getRangeAt(0);
      const viewContainer =
        sourceView?.containerEl ||
        (activeView instanceof MarkdownView ? activeView.containerEl : null);
      if (!viewContainer?.contains(range.commonAncestorContainer)) {
        this.plugin.logDiag("probe", "initial_query_probe", {
          stage,
          source: "dom_outside_view",
          length: domText.length,
        });
        return "";
      }
      this.plugin.logDiag("probe", "initial_query_probe", {
        stage,
        source: "dom_selection",
        length: domText.length,
      });
      return domText;
    } catch (error) {
      this.plugin.logDiag("result", "initial_query_error", {
        message: error && error.message ? error.message : error,
      });
      return "";
    }
  }

  logModalMetrics(caseName) {
    try {
      const rect = this.modalEl.getBoundingClientRect();
      const inputRect = this.inputEl
        ? this.inputEl.getBoundingClientRect()
        : { width: 0, top: 0, left: 0 };
      this.plugin.logDiag("metric", caseName, {
        modalClass: this.modalEl.className,
        modalTop: Math.round(rect.top),
        modalLeft: Math.round(rect.left),
        modalWidth: Math.round(rect.width),
        inputWidth: Math.round(inputRect.width),
        inputTop: Math.round(inputRect.top),
        mode: this.mode,
        regex: this.regex,
        results: this.results.length,
      });
    } catch (error) {
      this.plugin.logDiag("result", "modal_metric_error", {
        message: error && error.message ? error.message : error,
      });
    }
  }

  moveSelection(delta, source) {
    if (!this.results.length) return;
    this.selectedIndex =
      (this.selectedIndex + delta + this.results.length) % this.results.length;
    this.plugin.logDiag("probe", "move_selection", {
      source,
      selectedIndex: this.selectedIndex,
      results: this.results.length,
      path: this.results[this.selectedIndex] && this.results[this.selectedIndex].path,
      line: this.results[this.selectedIndex] && this.results[this.selectedIndex].line,
    });
    this.updateSelection();
  }

  async openSelected(source) {
    const result = this.results[this.selectedIndex];
    this.plugin.logDiag("probe", "open_selected", {
      source,
      selectedIndex: this.selectedIndex,
      results: this.results.length,
      path: result && result.path,
      line: result && result.line,
    });
    if (!result) return;
    const opened = await this.plugin.openResult(result);
    if (opened) this.close();
  }

  scheduleSearch() {
    window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => this.runSearch(), 140);
  }

  async runSearch() {
    const query = this.inputEl.value.trim();
    const id = ++this.requestId;
    if (!query) {
      this.results = [];
      this.resultsEl.empty();
      return;
    }

    this.plugin.logDiag("probe", "input_query", { query });
    this.resultsEl.setText("Searching...");
    try {
      const data = await this.plugin.search(query, {
        mode: this.mode,
        regex: this.regex,
      });
      if (id !== this.requestId) return;
      this.results = rowsToResults(data.rows || [], this.plugin);
      this.selectedIndex = 0;
      const shown = Number(data.shown || (data.rows || []).length);
      const total = Number(data.total || shown);
      this.renderResults();
      this.logModalMetrics("after_render");
      if (!this.results.length) {
        this.resultsEl.setText("We found 0 results for your search here.");
      } else if (shown < total) {
        this.resultsEl.createDiv({
          cls: "prompt-instructions",
          text: `${shown} of ${total} matches`,
        });
      }
    } catch (error) {
      if (id !== this.requestId) return;
      this.results = [];
      this.resultsEl.empty();
      this.resultsEl.setText(String(error && error.message ? error.message : error));
      this.plugin.logDiag("result", "render_search_error", {
        message: error && error.message ? error.message : error,
      });
    }
  }

  updateSelection() {
    const items = this.resultsEl.querySelectorAll(".suggestion-item");
    items.forEach((item, index) => {
      item.classList.toggle("is-selected", index === this.selectedIndex);
    });
  }

  renderResults() {
    this.resultsEl.empty();
    const highlightQuery =
      this.mode === SEARCH_MODE_FILE
        ? normalizeFileQueryInput(this.inputEl.value)
        : this.inputEl.value.trim();
    const terms = this.regex
      ? []
      : queryTerms(highlightQuery);

    this.results.forEach((result, index) => {
      const item = this.resultsEl.createDiv({
        cls: "suggestion-item zoekt-search-result",
        attr: {
          "data-result-id": result.path,
          "data-match-id": result.id,
          role: "button",
          tabindex: "0",
        },
      });
      if (index === this.selectedIndex) item.addClass("is-selected");
      item.addEventListener("mousemove", () => {
        if (this.selectedIndex === index) return;
        this.selectedIndex = index;
        this.plugin.logDiag("probe", "hover_select", {
          selectedIndex: index,
          path: result.path,
          line: result.line,
        });
        this.updateSelection();
      });
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.selectedIndex = index;
        this.openSelected("mouse_click");
      });

      const main = item.createDiv({
        cls: "zoekt-search-result__content",
      });
      const titleContainer = main.createDiv({
        cls: "zoekt-search-result__title-container",
      });
      const title = titleContainer.createSpan({
        cls: "zoekt-search-result__title",
      });
      const icon = title.createSpan({ cls: "zoekt-search-result__icon" });
      setIcon(icon, "file-text");
      title.createSpan({ text: result.title });
      const counterText = result.line ? `line ${result.line}` : "";
      titleContainer.createSpan({
        cls: "zoekt-search-result__counter",
        text: counterText,
      });

      if (result.folder) {
        const folder = main.createDiv({
          cls: "zoekt-search-result__folder-path",
        });
        const folderIcon = folder.createSpan({ cls: "zoekt-search-result__icon" });
        setIcon(folderIcon, "folder");
        folder.createSpan({ text: result.folder });
      }

      const excerptWrap = main.createDiv();
      excerptWrap.setAttr("style", "display: flex; flex-direction: row;");
      const body = excerptWrap.createDiv({ cls: "zoekt-search-result__body" });
      const excerpt = [
        ...result.before.slice(-1),
        result.text,
        ...result.after.slice(0, 1),
      ]
        .filter(Boolean)
        .join(" ");
      this.appendHighlightedText(body, excerpt, terms);
    });
  }

  appendHighlightedText(parent, text, terms) {
    if (!terms.length) {
      parent.setText(text);
      return;
    }

    const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "ig");
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (match.index > lastIndex) {
        parent.createSpan({ text: text.slice(lastIndex, match.index) });
      }
      parent.createSpan({
        cls: "zoekt-search-highlight zoekt-search-default-highlight",
        text: match[0],
      });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      parent.createSpan({ text: text.slice(lastIndex) });
    }
  }
}

class ZoektSearchSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Search endpoint")
      .setDesc("Raw Zoekt API endpoint.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.endpoint)
          .onChange(async (value) => {
            this.plugin.settings.endpoint = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Zoekt repo")
      .setDesc(
        `Blank uses the vault folder name lowercased when available: ${this.plugin.getDefaultZoektRepo() || "unavailable"}.`,
      )
      .addText((text) =>
        text
          .setPlaceholder(this.plugin.getDefaultZoektRepo())
          .setValue(this.plugin.settings.zoektRepo || "")
          .onChange(async (value) => {
            this.plugin.settings.zoektRepo = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Log level")
      .setDesc("Basic logs startup and errors. Verbose logs search, UI, and selection diagnostics.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("Basic", "Basic")
          .addOption("Verbose", "Verbose")
          .setValue(this.plugin.settings.logLevel || "Basic")
          .onChange(async (value) => {
            this.plugin.settings.logLevel = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Maximum matches")
      .setDesc("Maximum match rows to request and display for a single search.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxResults))
          .onChange(async (value) => {
            this.plugin.settings.maxResults = Math.max(1, Number(value) || 80);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Context lines")
      .setDesc("Number of surrounding lines Zoekt should return for each match.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.contextLines))
          .onChange(async (value) => {
            this.plugin.settings.contextLines = Math.max(0, Number(value) || 0);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Regex")
      .setDesc("Pass the query through as a raw Zoekt/RE2 expression instead of literal text.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.regex).onChange(async (value) => {
          this.plugin.settings.regex = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Literal spaces")
      .setDesc("Treat spaces as part of one literal phrase. Turn off to search each word as an AND term.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.escapeSpace)
          .onChange(async (value) => {
            this.plugin.settings.escapeSpace = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}

module.exports = ZoektSearchPlugin;
