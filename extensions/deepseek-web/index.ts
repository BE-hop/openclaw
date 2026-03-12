import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginService,
  PluginCommandContext,
} from "openclaw/plugin-sdk";
import { browserAct } from "../../src/browser/client-actions.js";
import { browserOpenTab, browserTabs, type BrowserTab } from "../../src/browser/client.js";

type ChatRole = "assistant" | "user" | "system" | "unknown";

type NormalizedMessage = {
  role: ChatRole;
  text: string;
};

type StoredMessage = NormalizedMessage & {
  fingerprint: string;
  observedAtMs: number;
  sourceUrl: string;
};

type DeepseekWebState = {
  version: 1;
  watchEnabled: boolean;
  lastPolledAtMs?: number;
  lastError?: string;
  activeUrl?: string;
  activeTargetId?: string;
  window: StoredMessage[];
  events: StoredMessage[];
};

type DeepseekWebConfig = {
  profile: string;
  urlMatch: string;
  openUrl: string;
  autoWatch: boolean;
  pollIntervalMs: number;
  sendWaitMs: number;
  maxWindowMessages: number;
  maxEventMessages: number;
  inputSelector: string;
  sendButtonSelector: string;
  messageSelector: string;
  userSelector?: string;
  assistantSelector?: string;
};

type ExtractResult = {
  url: string;
  messages: NormalizedMessage[];
};

type PollResult = {
  newMessages: StoredMessage[];
  window: StoredMessage[];
  url: string;
  targetId: string;
};

const PLUGIN_ID = "deepseek-web";
const STATE_REL_PATH = ["plugins", PLUGIN_ID, "state.json"] as const;

const DEFAULT_PROFILE = "chrome";
const DEFAULT_URL_MATCH = "chat.deepseek.com";
const DEFAULT_OPEN_URL = "https://chat.deepseek.com/";
const DEFAULT_AUTO_WATCH = true;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_SEND_WAIT_MS = 12_000;
const DEFAULT_MAX_WINDOW_MESSAGES = 80;
const DEFAULT_MAX_EVENT_MESSAGES = 500;
const DEFAULT_INPUT_SELECTOR = "textarea";
const DEFAULT_SEND_BUTTON_SELECTOR =
  "button[type='submit'], button[aria-label*='send' i], button[data-testid*='send' i]";
const DEFAULT_MESSAGE_SELECTOR =
  "main [data-testid*='message' i], main [class*='message' i], main article, main .markdown";

const MIN_POLL_INTERVAL_MS = 3_000;
const MAX_POLL_INTERVAL_MS = 5 * 60_000;
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 3 * 60_000;
const MIN_MAX_WINDOW_MESSAGES = 10;
const MAX_MAX_WINDOW_MESSAGES = 300;
const MIN_MAX_EVENT_MESSAGES = 20;
const MAX_MAX_EVENT_MESSAGES = 2_000;

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeRole(input: unknown): ChatRole {
  const raw = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (raw === "assistant" || raw === "bot" || raw === "ai") {
    return "assistant";
  }
  if (raw === "user" || raw === "human" || raw === "me") {
    return "user";
  }
  if (raw === "system") {
    return "system";
  }
  return "unknown";
}

function normalizeText(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }
  return input.replace(/\s+/g, " ").trim();
}

function fingerprintMessage(msg: NormalizedMessage): string {
  const digest = createHash("sha1");
  digest.update(msg.role);
  digest.update("\n");
  digest.update(msg.text);
  return digest.digest("hex").slice(0, 16);
}

function toStoredMessage(
  message: NormalizedMessage,
  observedAtMs: number,
  sourceUrl: string,
): StoredMessage {
  return {
    ...message,
    fingerprint: fingerprintMessage(message),
    observedAtMs,
    sourceUrl,
  };
}

function normalizeConfigObject(raw: unknown): Partial<DeepseekWebConfig> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const src = raw as Record<string, unknown>;
  const profile = asTrimmedString(src.profile);
  const urlMatch = asTrimmedString(src.urlMatch);
  const openUrl = asTrimmedString(src.openUrl);
  const autoWatch = asBoolean(src.autoWatch);
  const pollIntervalMs = asPositiveNumber(src.pollIntervalMs);
  const sendWaitMs = asPositiveNumber(src.sendWaitMs);
  const maxWindowMessages = asPositiveNumber(src.maxWindowMessages);
  const maxEventMessages = asPositiveNumber(src.maxEventMessages);
  const inputSelector = asTrimmedString(src.inputSelector);
  const sendButtonSelector = asTrimmedString(src.sendButtonSelector);
  const messageSelector = asTrimmedString(src.messageSelector);
  const userSelector = asTrimmedString(src.userSelector);
  const assistantSelector = asTrimmedString(src.assistantSelector);

  return {
    ...(profile ? { profile } : {}),
    ...(urlMatch ? { urlMatch } : {}),
    ...(openUrl ? { openUrl } : {}),
    ...(autoWatch !== undefined ? { autoWatch } : {}),
    ...(pollIntervalMs ? { pollIntervalMs } : {}),
    ...(sendWaitMs ? { sendWaitMs } : {}),
    ...(maxWindowMessages ? { maxWindowMessages } : {}),
    ...(maxEventMessages ? { maxEventMessages } : {}),
    ...(inputSelector ? { inputSelector } : {}),
    ...(sendButtonSelector ? { sendButtonSelector } : {}),
    ...(messageSelector ? { messageSelector } : {}),
    ...(userSelector ? { userSelector } : {}),
    ...(assistantSelector ? { assistantSelector } : {}),
  };
}

function resolvePluginEntryConfig(config: OpenClawConfig, pluginId: string): unknown {
  return config.plugins?.entries?.[pluginId]?.config;
}

function mergeDeepseekConfig(
  base: DeepseekWebConfig,
  patch: Partial<DeepseekWebConfig>,
): DeepseekWebConfig {
  return {
    ...base,
    ...patch,
    pollIntervalMs: clamp(
      patch.pollIntervalMs ?? base.pollIntervalMs,
      MIN_POLL_INTERVAL_MS,
      MAX_POLL_INTERVAL_MS,
    ),
    sendWaitMs: clamp(patch.sendWaitMs ?? base.sendWaitMs, MIN_WAIT_MS, MAX_WAIT_MS),
    maxWindowMessages: clamp(
      patch.maxWindowMessages ?? base.maxWindowMessages,
      MIN_MAX_WINDOW_MESSAGES,
      MAX_MAX_WINDOW_MESSAGES,
    ),
    maxEventMessages: clamp(
      patch.maxEventMessages ?? base.maxEventMessages,
      MIN_MAX_EVENT_MESSAGES,
      MAX_MAX_EVENT_MESSAGES,
    ),
  };
}

function resolveEffectiveConfig(api: OpenClawPluginApi, config: OpenClawConfig): DeepseekWebConfig {
  const defaults: DeepseekWebConfig = {
    profile: DEFAULT_PROFILE,
    urlMatch: DEFAULT_URL_MATCH,
    openUrl: DEFAULT_OPEN_URL,
    autoWatch: DEFAULT_AUTO_WATCH,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    sendWaitMs: DEFAULT_SEND_WAIT_MS,
    maxWindowMessages: DEFAULT_MAX_WINDOW_MESSAGES,
    maxEventMessages: DEFAULT_MAX_EVENT_MESSAGES,
    inputSelector: DEFAULT_INPUT_SELECTOR,
    sendButtonSelector: DEFAULT_SEND_BUTTON_SELECTOR,
    messageSelector: DEFAULT_MESSAGE_SELECTOR,
  };

  const fromApi = normalizeConfigObject(api.pluginConfig);
  const fromRuntime = normalizeConfigObject(resolvePluginEntryConfig(config, api.id));
  return mergeDeepseekConfig(mergeDeepseekConfig(defaults, fromApi), fromRuntime);
}

function resolveStatePath(stateDir: string): string {
  return path.join(stateDir, ...STATE_REL_PATH);
}

function defaultState(watchEnabled: boolean): DeepseekWebState {
  return {
    version: 1,
    watchEnabled,
    window: [],
    events: [],
  };
}

function normalizeStoredMessage(input: unknown): StoredMessage | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const raw = input as Record<string, unknown>;
  const role = normalizeRole(raw.role);
  const text = normalizeText(raw.text);
  if (!text) {
    return null;
  }

  const fallbackFingerprint = fingerprintMessage({ role, text });
  const fingerprint = asTrimmedString(raw.fingerprint) ?? fallbackFingerprint;
  const observedAtMsRaw = asPositiveNumber(raw.observedAtMs);
  const observedAtMs = observedAtMsRaw ? Math.trunc(observedAtMsRaw) : Date.now();
  const sourceUrl = asTrimmedString(raw.sourceUrl) ?? "";

  return {
    role,
    text,
    fingerprint,
    observedAtMs,
    sourceUrl,
  };
}

function normalizeState(raw: unknown, watchEnabled: boolean): DeepseekWebState {
  if (!raw || typeof raw !== "object") {
    return defaultState(watchEnabled);
  }
  const src = raw as Record<string, unknown>;
  const version = src.version === 1 ? 1 : 1;
  const windowRaw = Array.isArray(src.window) ? src.window : [];
  const eventsRaw = Array.isArray(src.events) ? src.events : [];
  const window = windowRaw
    .map((entry) => normalizeStoredMessage(entry))
    .filter((entry): entry is StoredMessage => entry !== null);
  const events = eventsRaw
    .map((entry) => normalizeStoredMessage(entry))
    .filter((entry): entry is StoredMessage => entry !== null);
  const stateWatchEnabled = asBoolean(src.watchEnabled) ?? watchEnabled;
  const lastPolledAtMsRaw = asPositiveNumber(src.lastPolledAtMs);
  const lastError = asTrimmedString(src.lastError);
  const activeUrl = asTrimmedString(src.activeUrl);
  const activeTargetId = asTrimmedString(src.activeTargetId);

  return {
    version,
    watchEnabled: stateWatchEnabled,
    ...(lastPolledAtMsRaw ? { lastPolledAtMs: Math.trunc(lastPolledAtMsRaw) } : {}),
    ...(lastError ? { lastError } : {}),
    ...(activeUrl ? { activeUrl } : {}),
    ...(activeTargetId ? { activeTargetId } : {}),
    window,
    events,
  };
}

async function readState(statePath: string, watchEnabled: boolean): Promise<DeepseekWebState> {
  try {
    const content = await fs.readFile(statePath, "utf8");
    return normalizeState(JSON.parse(content), watchEnabled);
  } catch {
    return defaultState(watchEnabled);
  }
}

async function writeState(statePath: string, state: DeepseekWebState): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function sequenceOverlap(prev: string[], next: string[]): number {
  const max = Math.min(prev.length, next.length);
  for (let n = max; n > 0; n -= 1) {
    let same = true;
    for (let i = 0; i < n; i += 1) {
      const prevIndex = prev.length - n + i;
      if (prev[prevIndex] !== next[i]) {
        same = false;
        break;
      }
    }
    if (same) {
      return n;
    }
  }
  return 0;
}

function detectNewMessages(
  prevWindow: StoredMessage[],
  nextWindow: StoredMessage[],
): StoredMessage[] {
  if (nextWindow.length === 0) {
    return [];
  }
  if (prevWindow.length === 0) {
    return [...nextWindow];
  }

  const prevKeys = prevWindow.map((entry) => entry.fingerprint);
  const nextKeys = nextWindow.map((entry) => entry.fingerprint);
  const overlap = sequenceOverlap(prevKeys, nextKeys);
  if (overlap > 0) {
    return nextWindow.slice(overlap);
  }

  const prevSet = new Set(prevKeys);
  const bySetDiff = nextWindow.filter((entry) => !prevSet.has(entry.fingerprint));
  if (bySetDiff.length > 0) {
    return bySetDiff;
  }

  const last = nextWindow[nextWindow.length - 1];
  return last ? [last] : [];
}

function trimMessages<T>(messages: T[], max: number): T[] {
  if (messages.length <= max) {
    return messages;
  }
  return messages.slice(messages.length - max);
}

function buildExtractEvalFn(cfg: DeepseekWebConfig): string {
  const payload = JSON.stringify({
    messageSelector: cfg.messageSelector,
    userSelector: cfg.userSelector ?? "",
    assistantSelector: cfg.assistantSelector ?? "",
    maxWindowMessages: cfg.maxWindowMessages,
  });

  return `(() => {
    const cfg = ${payload};
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();

    const toRole = (value) => {
      const v = norm(value).toLowerCase();
      if (v === "assistant" || v === "bot" || v === "ai") return "assistant";
      if (v === "user" || v === "human" || v === "me") return "user";
      if (v === "system") return "system";
      return "unknown";
    };

    const inferRole = (node) => {
      const marker = [
        node.getAttribute("data-role") || "",
        node.getAttribute("aria-label") || "",
        node.className || "",
      ].join(" ").toLowerCase();
      if (marker.includes("assistant") || marker.includes("bot") || marker.includes("ai")) {
        return "assistant";
      }
      if (marker.includes("user") || marker.includes("human") || marker.includes("me")) {
        return "user";
      }
      return "unknown";
    };

    const sortDomOrder = (a, b) => {
      if (a.node === b.node) return 0;
      const pos = a.node.compareDocumentPosition(b.node);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    };

    const dedupeNestedNodes = (nodes) => {
      return nodes.filter((node, index) => {
        for (let i = 0; i < nodes.length; i += 1) {
          if (i === index) continue;
          const other = nodes[i];
          if (other && other !== node && other.contains(node)) {
            return false;
          }
        }
        return true;
      });
    };

    const rows = [];
    const appendBySelector = (selector, roleHint) => {
      if (!selector) return;
      const nodes = dedupeNestedNodes(Array.from(document.querySelectorAll(selector)));
      for (const node of nodes) {
        const text = norm(node.textContent || "");
        if (!text) continue;
        rows.push({
          node,
          role: toRole(roleHint || inferRole(node)),
          text,
        });
      }
    };

    appendBySelector(cfg.userSelector, "user");
    appendBySelector(cfg.assistantSelector, "assistant");

    if (rows.length === 0) {
      appendBySelector(cfg.messageSelector, "");
    }

    if (rows.length === 0) {
      const fallbackNodes = dedupeNestedNodes(
        Array.from(document.querySelectorAll("main p, main article, main [role='article']")),
      );
      for (const node of fallbackNodes) {
        const text = norm(node.textContent || "");
        if (!text) continue;
        rows.push({ node, role: "unknown", text });
      }
    }

    // DeepSeek sometimes renders chat text in custom containers where
    // selector-based extraction can miss everything. Fall back to main text lines.
    if (rows.length === 0) {
      const main = document.querySelector("main");
      const rawMainText = String((main && main.innerText) || "").replace(/\\r/g, "");
      const lines = rawMainText
        .split("\\n")
        .map((line) => norm(line))
        .filter(Boolean);
      const bounded = lines.slice(-Math.max(10, Math.min(cfg.maxWindowMessages || 80, 300)));
      for (const line of bounded) {
        rows.push({ node: main || document.body, role: "unknown", text: line });
      }
    }

    rows.sort(sortDomOrder);

    const lines = [];
    const seen = new Set();
    for (const row of rows) {
      const text = norm(row.text);
      if (!text) continue;
      const key = row.role + "|" + text;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({ role: row.role, text });
    }

    return {
      ok: true,
      href: location.href,
      title: document.title || "",
      messages: lines.slice(-Math.max(10, Math.min(cfg.maxWindowMessages || 80, 300))),
    };
  })()`;
}

function buildSendEvalFn(params: {
  inputSelector: string;
  sendButtonSelector: string;
  text: string;
}): string {
  const payload = JSON.stringify(params);
  return `(() => {
    const cfg = ${payload};
    const input = document.querySelector(cfg.inputSelector);
    if (!input) {
      return { ok: false, error: "input-not-found (" + cfg.inputSelector + ")" };
    }

    const setNativeValue = (el, value) => {
      let applied = false;
      try {
        if (el instanceof HTMLTextAreaElement) {
          const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
          if (desc && typeof desc.set === "function") {
            desc.set.call(el, value);
            applied = true;
          }
        } else if (el instanceof HTMLInputElement) {
          const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
          if (desc && typeof desc.set === "function") {
            desc.set.call(el, value);
            applied = true;
          }
        }
      } catch {
        // ignored
      }

      if (!applied) {
        try {
          el.value = value;
        } catch {
          // ignored
        }
      }
    };

    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      setNativeValue(input, cfg.text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (input instanceof HTMLElement && input.isContentEditable) {
      input.focus();
      input.textContent = cfg.text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      return { ok: false, error: "input-not-editable" };
    }

    let via = "keyboard";
    const button = cfg.sendButtonSelector
      ? document.querySelector(cfg.sendButtonSelector)
      : null;
    if (button instanceof HTMLElement && !button.hasAttribute("disabled") && button.getAttribute("aria-disabled") !== "true") {
      button.click();
      via = "button";
      return { ok: true, via };
    }

    const form = input.closest("form");
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit();
      via = "form";
      return { ok: true, via };
    }

    const keydown = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
    });
    input.dispatchEvent(keydown);

    const keyup = new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
    });
    input.dispatchEvent(keyup);

    return { ok: true, via };
  })()`;
}

function parseExtractResult(raw: unknown): ExtractResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("extract evaluate returned empty result");
  }
  const src = raw as Record<string, unknown>;
  if (src.ok === false) {
    const message = asTrimmedString(src.error) ?? "extract evaluate failed";
    throw new Error(message);
  }
  const messagesRaw = Array.isArray(src.messages) ? src.messages : [];
  const normalized: NormalizedMessage[] = [];
  for (const item of messagesRaw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const msg = item as Record<string, unknown>;
    const role = normalizeRole(msg.role);
    const text = normalizeText(msg.text);
    if (!text) {
      continue;
    }
    normalized.push({ role, text });
  }
  const url = asTrimmedString(src.href) ?? "";
  return {
    url,
    messages: normalized,
  };
}

function parseSendResult(raw: unknown): { via?: string } {
  if (!raw || typeof raw !== "object") {
    throw new Error("send evaluate returned empty result");
  }
  const src = raw as Record<string, unknown>;
  if (src.ok === false) {
    const message = asTrimmedString(src.error) ?? "send evaluate failed";
    throw new Error(message);
  }
  if (src.ok !== true) {
    throw new Error("send evaluate did not return ok=true");
  }
  const via = asTrimmedString(src.via);
  return via ? { via } : {};
}

async function resolveTargetTab(cfg: DeepseekWebConfig): Promise<BrowserTab> {
  const tabs = await browserTabs(undefined, { profile: cfg.profile });
  const tab = tabs.find((entry) => {
    if (!cfg.urlMatch) {
      return true;
    }
    return entry.url.includes(cfg.urlMatch);
  });

  if (tab) {
    return tab;
  }

  if (!cfg.openUrl) {
    throw new Error(`No browser tab matched urlMatch='${cfg.urlMatch}'`);
  }

  return await browserOpenTab(undefined, cfg.openUrl, { profile: cfg.profile });
}

async function extractMessagesFromPage(cfg: DeepseekWebConfig): Promise<{
  target: BrowserTab;
  result: ExtractResult;
}> {
  const target = await resolveTargetTab(cfg);

  const evaluation = await browserAct(
    undefined,
    {
      kind: "evaluate",
      targetId: target.targetId,
      fn: buildExtractEvalFn(cfg),
      timeoutMs: 20_000,
    },
    { profile: cfg.profile },
  );

  const parsed = parseExtractResult(evaluation.result);
  return {
    target,
    result: parsed,
  };
}

async function sendMessageToPage(
  cfg: DeepseekWebConfig,
  text: string,
): Promise<{ target: BrowserTab; via?: string }> {
  const target = await resolveTargetTab(cfg);

  await browserAct(
    undefined,
    {
      kind: "wait",
      targetId: target.targetId,
      selector: cfg.inputSelector,
      timeoutMs: 15_000,
    },
    { profile: cfg.profile },
  );

  const sent = await browserAct(
    undefined,
    {
      kind: "evaluate",
      targetId: target.targetId,
      fn: buildSendEvalFn({
        inputSelector: cfg.inputSelector,
        sendButtonSelector: cfg.sendButtonSelector,
        text,
      }),
      timeoutMs: 20_000,
    },
    { profile: cfg.profile },
  );

  const parsed = parseSendResult(sent.result);
  return {
    target,
    ...parsed,
  };
}

async function runPoll(params: {
  cfg: DeepseekWebConfig;
  statePath: string;
  watchDefault: boolean;
}): Promise<PollResult> {
  const [state, extracted] = await Promise.all([
    readState(params.statePath, params.watchDefault),
    extractMessagesFromPage(params.cfg),
  ]);

  const observedAtMs = Date.now();
  const sourceUrl = extracted.result.url || extracted.target.url || "";
  const window = trimMessages(
    extracted.result.messages.map((msg) => toStoredMessage(msg, observedAtMs, sourceUrl)),
    params.cfg.maxWindowMessages,
  );
  const newlyDetected = detectNewMessages(state.window, window);

  const nextState: DeepseekWebState = {
    ...state,
    version: 1,
    lastPolledAtMs: observedAtMs,
    lastError: undefined,
    activeUrl: sourceUrl,
    activeTargetId: extracted.target.targetId,
    window,
    events: trimMessages([...state.events, ...newlyDetected], params.cfg.maxEventMessages),
  };

  await writeState(params.statePath, nextState);

  return {
    newMessages: newlyDetected,
    window,
    url: sourceUrl,
    targetId: extracted.target.targetId,
  };
}

async function writeWatchFlag(params: {
  statePath: string;
  watchDefault: boolean;
  watchEnabled: boolean;
}): Promise<DeepseekWebState> {
  const state = await readState(params.statePath, params.watchDefault);
  const next: DeepseekWebState = {
    ...state,
    version: 1,
    watchEnabled: params.watchEnabled,
  };
  await writeState(params.statePath, next);
  return next;
}

async function writePollError(params: {
  statePath: string;
  watchDefault: boolean;
  error: unknown;
}): Promise<void> {
  const state = await readState(params.statePath, params.watchDefault);
  const message = String((params.error as Error)?.message ?? params.error);
  const next: DeepseekWebState = {
    ...state,
    version: 1,
    lastError: message,
  };
  await writeState(params.statePath, next);
}

function trimForDisplay(text: string, max = 240): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}...`;
}

function formatMessages(messages: StoredMessage[], limit: number): string {
  if (messages.length === 0) {
    return "(no captured messages)";
  }
  const slice = messages.slice(-Math.max(1, Math.min(limit, 20)));
  return slice
    .map((msg, index) => `${index + 1}. [${msg.role}] ${trimForDisplay(msg.text)}`)
    .join("\n");
}

function formatStatus(params: { cfg: DeepseekWebConfig; state: DeepseekWebState }): string {
  const { cfg, state } = params;
  const latest = state.window[state.window.length - 1];
  const lines = [
    "DeepSeek Web status:",
    `- watch: ${state.watchEnabled ? "on" : "off"}`,
    `- profile: ${cfg.profile}`,
    `- urlMatch: ${cfg.urlMatch}`,
    `- pollIntervalMs: ${cfg.pollIntervalMs}`,
    `- lastPolledAtMs: ${state.lastPolledAtMs ?? "(never)"}`,
    `- activeUrl: ${state.activeUrl ?? "(none)"}`,
    `- capturedWindow: ${state.window.length}`,
    `- eventHistory: ${state.events.length}`,
  ];

  if (state.lastError) {
    lines.push(`- lastError: ${state.lastError}`);
  }

  if (latest) {
    lines.push(`- latest: [${latest.role}] ${trimForDisplay(latest.text, 160)}`);
  }

  lines.push("");
  lines.push("Commands:");
  lines.push("/deepseek status");
  lines.push("/deepseek poll");
  lines.push("/deepseek fetch [n]");
  lines.push("/deepseek send <text>");
  lines.push("/deepseek ask <text>");
  lines.push("/deepseek watch on|off");
  lines.push("/deepseek logs [n]");

  return lines.join("\n");
}

function parseActionAndRest(args: string): { action: string; rest: string } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { action: "status", rest: "" };
  }
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) {
    return { action: trimmed.toLowerCase(), rest: "" };
  }
  const action = trimmed.slice(0, firstSpace).toLowerCase();
  const rest = trimmed.slice(firstSpace + 1).trim();
  return { action, rest };
}

function parseOptionalLimit(raw: string, fallback: number): number {
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(n, 20));
}

export default function register(api: OpenClawPluginApi) {
  let serviceInterval: ReturnType<typeof setInterval> | null = null;
  let opChain: Promise<void> = Promise.resolve();

  function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = opChain.then(task, task);
    opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function withCurrentConfig(config?: OpenClawConfig): Promise<DeepseekWebConfig> {
    const cfg = config ?? api.runtime.config.loadConfig();
    return resolveEffectiveConfig(api, cfg);
  }

  async function runPollWithCurrentConfig(
    statePath: string,
    watchDefault: boolean,
  ): Promise<PollResult> {
    const cfg = await withCurrentConfig();
    return await runPoll({
      cfg,
      statePath,
      watchDefault,
    });
  }

  const pollService: OpenClawPluginService = {
    id: "deepseek-web-poller",
    start: async (ctx) => {
      const baseConfig = resolveEffectiveConfig(api, ctx.config);
      const statePath = resolveStatePath(ctx.stateDir);

      const tick = async () => {
        await runExclusive(async () => {
          const currentConfig = await withCurrentConfig();
          const state = await readState(statePath, currentConfig.autoWatch);
          if (!state.watchEnabled) {
            return;
          }
          try {
            const result = await runPollWithCurrentConfig(statePath, currentConfig.autoWatch);
            if (result.newMessages.length > 0) {
              api.logger.info(
                `deepseek-web: captured ${result.newMessages.length} new message(s) from ${result.url || "(unknown url)"}`,
              );
            }
          } catch (err) {
            await writePollError({
              statePath,
              watchDefault: currentConfig.autoWatch,
              error: err,
            });
            api.logger.warn(`deepseek-web: poll failed: ${String((err as Error)?.message ?? err)}`);
          }
        });
      };

      await tick().catch(() => {});

      serviceInterval = setInterval(() => {
        tick().catch(() => {});
      }, baseConfig.pollIntervalMs);
      serviceInterval.unref?.();
    },
    stop: async () => {
      if (serviceInterval) {
        clearInterval(serviceInterval);
        serviceInterval = null;
      }
    },
  };

  api.registerService(pollService);

  api.registerCommand({
    name: "deepseek",
    description: "Send/wait/fetch DeepSeek web messages from your logged-in browser tab.",
    acceptsArgs: true,
    handler: async (ctx: PluginCommandContext) => {
      const config = resolveEffectiveConfig(api, ctx.config);
      const statePath = resolveStatePath(api.runtime.state.resolveStateDir());
      const args = ctx.args?.trim() ?? "";
      const { action, rest } = parseActionAndRest(args);

      if (action === "status" || action === "help") {
        const state = await readState(statePath, config.autoWatch);
        return { text: formatStatus({ cfg: config, state }) };
      }

      if (action === "watch") {
        const normalized = rest.toLowerCase();
        if (normalized !== "on" && normalized !== "off") {
          return { text: "Usage: /deepseek watch on|off" };
        }
        const next = await runExclusive(
          async () =>
            await writeWatchFlag({
              statePath,
              watchDefault: config.autoWatch,
              watchEnabled: normalized === "on",
            }),
        );
        return {
          text: `DeepSeek watch is now ${next.watchEnabled ? "on" : "off"}.`,
        };
      }

      if (action === "poll") {
        return await runExclusive(async () => {
          try {
            const result = await runPoll({
              cfg: config,
              statePath,
              watchDefault: config.autoWatch,
            });
            const preview = formatMessages(
              result.newMessages.length > 0 ? result.newMessages : result.window,
              5,
            );
            return {
              text:
                `Poll completed. New messages: ${result.newMessages.length}\n` +
                `URL: ${result.url || "(unknown)"}\n\n` +
                preview,
            };
          } catch (err) {
            await writePollError({ statePath, watchDefault: config.autoWatch, error: err });
            throw err;
          }
        });
      }

      if (action === "fetch") {
        const limit = parseOptionalLimit(rest, 5);
        const state = await readState(statePath, config.autoWatch);
        return {
          text:
            `Latest captured messages (${Math.min(limit, state.window.length)}/${state.window.length}):\n` +
            formatMessages(state.window, limit),
        };
      }

      if (action === "logs") {
        const limit = parseOptionalLimit(rest, 8);
        const state = await readState(statePath, config.autoWatch);
        return {
          text:
            `Recent new-message events (${Math.min(limit, state.events.length)}/${state.events.length}):\n` +
            formatMessages(state.events, limit),
        };
      }

      if (action === "send") {
        if (!rest) {
          return { text: "Usage: /deepseek send <text>" };
        }

        return await runExclusive(async () => {
          const sent = await sendMessageToPage(config, rest);
          return {
            text:
              `Sent to DeepSeek tab.\n` +
              `targetId=${sent.target.targetId}\n` +
              `url=${sent.target.url}\n` +
              `via=${sent.via ?? "unknown"}`,
          };
        });
      }

      if (action === "ask") {
        if (!rest) {
          return { text: "Usage: /deepseek ask <text>" };
        }

        return await runExclusive(async () => {
          const sent = await sendMessageToPage(config, rest);

          await browserAct(
            undefined,
            {
              kind: "wait",
              targetId: sent.target.targetId,
              timeMs: config.sendWaitMs,
              timeoutMs: config.sendWaitMs + 2_000,
            },
            { profile: config.profile },
          );

          const polled = await runPoll({
            cfg: config,
            statePath,
            watchDefault: config.autoWatch,
          });

          const latest = polled.window[polled.window.length - 1];
          return {
            text:
              `Sent + waited ${config.sendWaitMs}ms, then fetched latest.\n` +
              `URL: ${polled.url || sent.target.url}\n\n` +
              (latest
                ? `Latest: [${latest.role}] ${trimForDisplay(latest.text)}`
                : "No messages captured yet."),
          };
        });
      }

      return {
        text: "Unknown action. Use: /deepseek status | poll | fetch [n] | send <text> | ask <text> | watch on|off | logs [n]",
      };
    },
  });
}

export const __testing = {
  normalizeRole,
  normalizeText,
  normalizeConfigObject,
  mergeDeepseekConfig,
  sequenceOverlap,
  detectNewMessages,
  parseActionAndRest,
};
