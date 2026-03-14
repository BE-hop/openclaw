import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/compat";
import { browserNavigate } from "../../../src/browser/client-actions-core.js";
import { browserAct } from "../../../src/browser/client-actions.js";
import {
  browserOpenTab,
  browserSnapshot,
  browserTabs,
  type BrowserTab,
  type SnapshotAriaNode,
} from "../../../src/browser/client.js";
import { resolveWechatOfficialAccount } from "./accounts.js";
import type { ResolvedWechatOfficialAccount, WechatInboundMessage } from "./types.js";

type BridgeKind = "deepseek" | "chatgpt";

type DeepseekTaskStatus = "queued" | "running" | "done" | "error";

type DeepseekTaskRecord = {
  id: string;
  bridgeKind: BridgeKind;
  accountId: string;
  senderId: string;
  prompt: string;
  forceNewConversation?: boolean;
  status: DeepseekTaskStatus;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  targetId?: string;
  targetUrl?: string;
  preview?: string;
  answer?: string;
  fetchCursor?: number;
  error?: string;
};

type DeepseekConversationState = {
  targetId?: string;
  targetUrl?: string;
  turnsInConversation: number;
  updatedAtMs: number;
};

type DeepseekBridgeState = {
  version: 1;
  tasks: Record<string, DeepseekTaskRecord>;
  order: string[];
  conversations: Record<string, DeepseekConversationState>;
};

type DeepseekCommand =
  | { kind: "none" }
  | { kind: "enqueue"; prompt: string; forceNewConversation?: boolean }
  | { kind: "fetch"; taskId?: string };

type RunDeepseekTaskResult =
  | {
      status: "done";
      answer: string;
      preview: string;
      targetId: string;
      targetUrl: string;
      turnsInConversation: number;
    }
  | {
      status: "error";
      error: string;
      preview?: string;
      targetId?: string;
      targetUrl?: string;
      turnsInConversation?: number;
    };

const STATE_REL_PATH = ["plugins", "wechat-official", "deepseek-bridge.json"] as const;

const DEFAULT_INPUT_SELECTOR = "textarea";
const DEFAULT_SEND_BUTTON_SELECTOR =
  "button[type='submit'], button[aria-label*='send' i], button[data-testid*='send' i]";
const CHATGPT_INPUT_SELECTOR = "div#prompt-textarea[contenteditable='true']";
const CHATGPT_SEND_BUTTON_SELECTOR =
  "button[data-testid='send-button'], button[aria-label*='send' i], button[type='submit']";

const MAX_PREVIEW_CHARS = 300;
const MAX_INLINE_ANSWER_CHARS = 40_000;
const MAX_FETCH_CHUNK_BYTES = 1_500;
const MAX_RECENT_TASKS = 120;
const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 10_000;
const MAX_TURNS_PER_CONVERSATION = 10;
const BROWSER_OPERATION_HARD_TIMEOUT_MS = 35_000;

let stateLockChain: Promise<void> = Promise.resolve();
const runningAccountRunners = new Set<string>();

function resolveBridgeDisplayName(bridgeKind: BridgeKind): string {
  return bridgeKind === "chatgpt" ? "ChatGPT" : "DeepSeek";
}

function resolveConversationStateKey(bridgeKind: BridgeKind, accountId: string): string {
  return `${bridgeKind}:${accountId}`;
}

function resolveRunnerKey(bridgeKind: BridgeKind, accountId: string): string {
  return `${bridgeKind}:${accountId}`;
}

function resolveBridgeConfig(
  account: ResolvedWechatOfficialAccount,
  bridgeKind: BridgeKind,
): ResolvedWechatOfficialAccount["deepseekBridge"] {
  return bridgeKind === "chatgpt" ? account.chatgptBridge : account.deepseekBridge;
}

function resolveBridgeSelectors(bridgeKind: BridgeKind): {
  inputSelector: string;
  sendButtonSelector: string;
} {
  if (bridgeKind === "chatgpt") {
    return {
      inputSelector: CHATGPT_INPUT_SELECTOR,
      sendButtonSelector: CHATGPT_SEND_BUTTON_SELECTOR,
    };
  }
  return {
    inputSelector: DEFAULT_INPUT_SELECTOR,
    sendButtonSelector: DEFAULT_SEND_BUTTON_SELECTOR,
  };
}

function pickChatgptTextboxRef(nodes: SnapshotAriaNode[]): string | undefined {
  const textboxes = nodes.filter((node) => trimText(node.role).toLowerCase() === "textbox");
  if (textboxes.length === 0) {
    return undefined;
  }
  const preferred = textboxes.find((node) => {
    const name = trimText(node.name ?? "").toLowerCase();
    return (
      !name ||
      name.includes("message") ||
      name.includes("chatgpt") ||
      name.includes("问") ||
      name.includes("输入")
    );
  });
  return preferred?.ref ?? textboxes[textboxes.length - 1]?.ref;
}

function pickChatgptSendButtonRef(nodes: SnapshotAriaNode[]): string | undefined {
  const candidates = nodes.filter((node) => trimText(node.role).toLowerCase() === "button");
  const matched = candidates.find((node) => {
    const name = trimText(node.name ?? "").toLowerCase();
    return (
      name.includes("send") ||
      name.includes("发送") ||
      name.includes("提交") ||
      name.includes("传送")
    );
  });
  return matched?.ref;
}

function pickChatgptTab(tabs: BrowserTab[]): BrowserTab | undefined {
  const candidates = tabs.filter((tab) => {
    const url = trimText(tab.url ?? "").toLowerCase();
    return url.startsWith("https://chatgpt.com");
  });
  if (candidates.length === 0) {
    return undefined;
  }
  const withConversation = candidates.find((tab) =>
    trimText(tab.url ?? "")
      .toLowerCase()
      .includes("/c/"),
  );
  return withConversation ?? candidates[0];
}

async function sendChatgptPromptViaAriaActions(params: {
  profile: string;
  targetId: string;
  prompt: string;
}): Promise<boolean> {
  const snapshot = await browserSnapshot(undefined, {
    format: "aria",
    targetId: params.targetId,
    limit: 400,
    profile: params.profile,
  });
  if (snapshot.format !== "aria") {
    return false;
  }
  const textboxRef = pickChatgptTextboxRef(snapshot.nodes);
  if (!textboxRef) {
    return false;
  }

  await browserAct(
    undefined,
    {
      kind: "click",
      targetId: params.targetId,
      ref: textboxRef,
      timeoutMs: 10_000,
    },
    { profile: params.profile },
  );

  await browserAct(
    undefined,
    {
      kind: "type",
      targetId: params.targetId,
      ref: textboxRef,
      text: params.prompt,
      timeoutMs: 20_000,
    },
    { profile: params.profile },
  );

  // Use a single Enter submit for deterministic one-shot sending.
  await browserAct(
    undefined,
    {
      kind: "press",
      targetId: params.targetId,
      key: "Enter",
      delayMs: 40,
    },
    { profile: params.profile },
  );

  // Give UI a short settle window before caller snapshots post-send state.
  await browserAct(
    undefined,
    {
      kind: "wait",
      targetId: params.targetId,
      timeMs: 300,
      timeoutMs: 2_000,
    },
    { profile: params.profile },
  );
  return true;
}

function resolveStatePath(runtime: PluginRuntime): string {
  return path.join(runtime.state.resolveStateDir(), ...STATE_REL_PATH);
}

function defaultState(): DeepseekBridgeState {
  return {
    version: 1,
    tasks: {},
    order: [],
    conversations: {},
  };
}

function trimText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

async function readState(statePath: string): Promise<DeepseekBridgeState> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DeepseekBridgeState>;
    if (!parsed || typeof parsed !== "object") {
      return defaultState();
    }
    const tasksRaw = parsed.tasks && typeof parsed.tasks === "object" ? parsed.tasks : {};
    const order = Array.isArray(parsed.order)
      ? parsed.order.filter((id) => typeof id === "string")
      : [];
    const conversations =
      parsed.conversations && typeof parsed.conversations === "object" ? parsed.conversations : {};

    const tasks: Record<string, DeepseekTaskRecord> = {};
    for (const [id, taskUnknown] of Object.entries(tasksRaw)) {
      if (!taskUnknown || typeof taskUnknown !== "object") {
        continue;
      }
      const task = taskUnknown as Partial<DeepseekTaskRecord>;
      const bridgeKind = task.bridgeKind === "chatgpt" ? "chatgpt" : "deepseek";
      tasks[id] = {
        ...task,
        id,
        bridgeKind,
        accountId: String(task.accountId ?? ""),
        senderId: String(task.senderId ?? ""),
        prompt: String(task.prompt ?? ""),
        status:
          task.status === "queued" ||
          task.status === "running" ||
          task.status === "done" ||
          task.status === "error"
            ? task.status
            : "error",
        createdAtMs: Number(task.createdAtMs ?? Date.now()),
        updatedAtMs: Number(task.updatedAtMs ?? Date.now()),
      };
    }

    return {
      version: 1,
      tasks,
      order,
      conversations: conversations as Record<string, DeepseekConversationState>,
    };
  } catch {
    return defaultState();
  }
}

async function writeState(statePath: string, state: DeepseekBridgeState): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function withStateLock<T>(params: {
  runtime: PluginRuntime;
  persist: boolean;
  mutate: (state: DeepseekBridgeState) => Promise<T> | T;
}): Promise<T> {
  const statePath = resolveStatePath(params.runtime);
  const run = stateLockChain.then(async () => {
    const state = await readState(statePath);
    const value = await params.mutate(state);
    if (params.persist) {
      await writeState(statePath, state);
    }
    return value;
  });

  stateLockChain = run.then(
    () => undefined,
    () => undefined,
  );

  return await run;
}

function parseDeepseekCommand(rawBody: string, commandPrefixRaw = "ds"): DeepseekCommand {
  const text = rawBody.trim();
  if (!text) {
    return { kind: "none" };
  }

  const commandPrefix = commandPrefixRaw.trim().toLowerCase() || "ds";
  const fetchCommand = `${commandPrefix}back`;
  const newConversationCommand = `${commandPrefix}new`;
  const lower = text.toLowerCase();
  if (lower.startsWith(fetchCommand)) {
    const taskId = text.slice(fetchCommand.length).trim();
    return { kind: "fetch", ...(taskId ? { taskId } : {}) };
  }
  if (lower.startsWith(newConversationCommand)) {
    const prompt = text.slice(newConversationCommand.length).trim();
    return { kind: "enqueue", prompt, forceNewConversation: true };
  }

  const prefixIndex = lower.indexOf(commandPrefix);
  if (prefixIndex < 0) {
    return { kind: "none" };
  }

  const prompt =
    prefixIndex === 0
      ? text.slice(commandPrefix.length).trim()
      : `${text.slice(0, prefixIndex)} ${text.slice(prefixIndex + commandPrefix.length)}`
          .trim()
          .replace(/\s+/g, " ");
  return { kind: "enqueue", prompt };
}

function formatTaskStatus(task: DeepseekTaskRecord): string {
  const seconds = task.startedAtMs
    ? Math.max(0, Math.floor((Date.now() - task.startedAtMs) / 1000))
    : 0;
  if (task.status === "queued") {
    return `任务 ${task.id} 排队中`;
  }
  if (task.status === "running") {
    const preview = task.preview ? `\n当前预览：${truncateText(task.preview, 180)}` : "";
    return `任务 ${task.id} 处理中（${seconds}s）${preview}`;
  }
  if (task.status === "done") {
    return `任务 ${task.id} 已完成`;
  }
  const err = task.error ? `：${task.error}` : "";
  return `任务 ${task.id} 失败${err}`;
}

function findTaskForSender(params: {
  state: DeepseekBridgeState;
  bridgeKind: BridgeKind;
  accountId: string;
  senderId: string;
  taskId?: string;
}): DeepseekTaskRecord | undefined {
  if (params.taskId) {
    const task = params.state.tasks[params.taskId];
    if (!task) {
      return undefined;
    }
    if (
      task.bridgeKind !== params.bridgeKind ||
      task.accountId !== params.accountId ||
      task.senderId !== params.senderId
    ) {
      return undefined;
    }
    return task;
  }

  // If the sender is in the middle of fetching a long result, keep returning
  // that same task so `gptback`/`dsback` doesn't jump to a newer task.
  for (let i = params.state.order.length - 1; i >= 0; i -= 1) {
    const id = params.state.order[i];
    const task = id ? params.state.tasks[id] : undefined;
    if (!task) {
      continue;
    }
    if (
      task.bridgeKind !== params.bridgeKind ||
      task.accountId !== params.accountId ||
      task.senderId !== params.senderId
    ) {
      continue;
    }
    if (task.status !== "done") {
      continue;
    }
    const answerText = task.answer ?? task.preview ?? "";
    const chunks = splitAnswerForFetch(answerText);
    if (chunks.length === 0) {
      continue;
    }
    const cursor =
      typeof task.fetchCursor === "number" && Number.isFinite(task.fetchCursor)
        ? Math.max(0, Math.floor(task.fetchCursor))
        : 0;
    if (cursor > 0 && cursor < chunks.length) {
      return task;
    }
  }

  for (let i = params.state.order.length - 1; i >= 0; i -= 1) {
    const id = params.state.order[i];
    const task = id ? params.state.tasks[id] : undefined;
    if (!task) {
      continue;
    }
    if (
      task.bridgeKind === params.bridgeKind &&
      task.accountId === params.accountId &&
      task.senderId === params.senderId
    ) {
      return task;
    }
  }
  return undefined;
}

function sanitizeUiLines(lines: string[]): string[] {
  return lines.filter((line) => {
    const text = line.trim();
    if (!text) {
      return false;
    }
    if (text === "深度思考" || text === "智能搜索") {
      return false;
    }
    if (text.startsWith("内容由 AI 生成")) {
      return false;
    }
    if (text.startsWith("AI助手回应")) {
      return false;
    }
    return true;
  });
}

function deriveAnswerFromLines(lines: string[], prompt: string): string {
  const cleaned = sanitizeUiLines(lines.map((line) => trimText(line)).filter(Boolean));
  if (cleaned.length === 0) {
    return "";
  }

  const promptTrimmed = trimText(prompt);
  const promptSnippet = promptTrimmed.slice(0, Math.min(promptTrimmed.length, 20));
  let idx = -1;
  for (let i = cleaned.length - 1; i >= 0; i -= 1) {
    const line = cleaned[i] ?? "";
    if (line === promptTrimmed) {
      idx = i;
      break;
    }
    if (promptSnippet.length >= 8 && line.includes(promptSnippet)) {
      idx = i;
      break;
    }
  }

  const tail = idx >= 0 ? cleaned.slice(idx + 1) : cleaned.slice(-28);
  const filtered = tail.filter((line) => line !== promptTrimmed);
  return trimText(filtered.join("\n"));
}

function splitAnswerForFetch(answer: string, maxChunkBytes = MAX_FETCH_CHUNK_BYTES): string[] {
  const text = String(answer ?? "");
  if (!text.trim()) {
    return [];
  }
  const hardLimit = Math.max(256, Math.floor(maxChunkBytes));
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const char of Array.from(text)) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (current && currentBytes + charBytes > hardLimit) {
      chunks.push(current);
      current = char;
      currentBytes = charBytes;
      continue;
    }
    current += char;
    currentBytes += charBytes;
  }

  if (current) {
    chunks.push(current);
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

type DoneTaskFetchReplyPlan = {
  text: string;
  cursorBefore: number;
  cursorAfter: number;
};

function normalizeFetchCursor(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 0;
  }
  return Math.max(0, Math.floor(raw));
}

function planDoneTaskFetchReply(params: {
  task: DeepseekTaskRecord;
  commandPrefix: string;
  fetchCommand: string;
}): DoneTaskFetchReplyPlan {
  const answer = params.task.answer ?? params.task.preview ?? "";
  const chunks = splitAnswerForFetch(answer);
  if (chunks.length === 0) {
    return {
      text: `任务 ${params.task.id} 已完成：\n(无文本结果)\n内容已发送完毕，可发送包含 ${params.commandPrefix} 的新问题。`,
      cursorBefore: 0,
      cursorAfter: 0,
    };
  }

  const cursorRaw = normalizeFetchCursor(params.task.fetchCursor);
  if (cursorRaw >= chunks.length) {
    return {
      text: `任务 ${params.task.id} 内容已发送完毕，可发送包含 ${params.commandPrefix} 的新问题。`,
      cursorBefore: cursorRaw,
      cursorAfter: cursorRaw,
    };
  }

  const currentIndex = cursorRaw;
  const cursorAfter = currentIndex + 1;
  const remainingFetches = chunks.length - cursorAfter;
  const lines = [`任务 ${params.task.id} 已完成（${currentIndex + 1}/${chunks.length}）：`];
  lines.push(chunks[currentIndex] || "(无文本结果)");
  if (remainingFetches > 0) {
    lines.push(`内容较长，还需发送 ${params.fetchCommand} ${remainingFetches} 次可取完。`);
  } else {
    lines.push(`内容已发送完毕，可发送包含 ${params.commandPrefix} 的新问题。`);
  }

  return {
    text: lines.join("\n"),
    cursorBefore: cursorRaw,
    cursorAfter,
  };
}

function buildDoneTaskFetchReply(params: {
  task: DeepseekTaskRecord;
  commandPrefix: string;
  fetchCommand: string;
}): string {
  const plan = planDoneTaskFetchReply(params);
  params.task.fetchCursor = plan.cursorAfter;
  return plan.text;
}

function buildSendEvalFn(params: {
  text: string;
  inputSelector: string;
  sendButtonSelector: string;
}): string {
  const payload = JSON.stringify(params);
  return `(() => {
    const cfg = ${payload};
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const isButtonEnabled = (node) =>
      node instanceof HTMLElement &&
      !node.hasAttribute("disabled") &&
      node.getAttribute("aria-disabled") !== "true";

    const clickButton = (node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      try {
        node.focus();
      } catch {
        // ignored
      }
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        try {
          node.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
              button: 0,
            }),
          );
        } catch {
          // ignored
        }
      }
      try {
        node.click();
      } catch {
        // ignored
      }
      return true;
    };

    const fireEnter = (target) => {
      if (!(target instanceof HTMLElement)) {
        return;
      }
      try {
        target.focus();
      } catch {
        // ignored
      }
      for (const type of ["keydown", "keypress", "keyup"]) {
        target.dispatchEvent(
          new KeyboardEvent(type, {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    };

    const setNativeValue = (input, value) => {
      let applied = false;
      try {
        if (input instanceof HTMLTextAreaElement) {
          const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
          if (desc && typeof desc.set === "function") {
            desc.set.call(input, value);
            applied = true;
          }
        } else if (input instanceof HTMLInputElement) {
          const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
          if (desc && typeof desc.set === "function") {
            desc.set.call(input, value);
            applied = true;
          }
        }
      } catch {
        // ignored
      }
      if (!applied) {
        try {
          input.value = value;
        } catch {
          // ignored
        }
      }
    };

    const setEditableValue = (input, value) => {
      try {
        input.focus();
      } catch {
        // ignored
      }
      try {
        const selection = window.getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(input);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } catch {
        // ignored
      }

      try {
        input.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: value,
          }),
        );
      } catch {
        input.dispatchEvent(new Event("beforeinput", { bubbles: true, cancelable: true }));
      }

      let inserted = false;
      try {
        if (document.queryCommandSupported && document.queryCommandSupported("insertText")) {
          inserted = document.execCommand("insertText", false, value);
        }
      } catch {
        // ignored
      }
      if (!inserted) {
        input.textContent = value;
      }

      try {
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: value,
          }),
        );
      } catch {
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };

    return (async () => {
    const input = document.querySelector(cfg.inputSelector);
    if (!input) {
      return { ok: false, error: "input-not-found" };
    }

    if (!(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement || (input instanceof HTMLElement && input.isContentEditable))) {
      return { ok: false, error: "input-not-editable" };
    }

    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      setNativeValue(input, cfg.text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      setEditableValue(input, cfg.text);
    }

    for (let i = 0; i < 8; i += 1) {
      const button = cfg.sendButtonSelector ? document.querySelector(cfg.sendButtonSelector) : null;
      if (isButtonEnabled(button) && clickButton(button)) {
        return { ok: true, via: "button" };
      }
      await wait(120);
    }

    const form = input.closest("form");
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return { ok: true, via: "form" };
    }

    fireEnter(input);
    const active = document.activeElement;
    if (active && active !== input) {
      fireEnter(active);
    }
    return { ok: true, via: "enter" };
    })();
  })()`;
}

function buildSnapshotEvalFn(bridgeKind: BridgeKind): string {
  if (bridgeKind === "chatgpt") {
    return `(() => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\\r/g, "")
          .split("\\n")
          .map((line) => String(line || "").replace(/\\s+/g, " ").trim())
          .filter(Boolean)
          .join("\\n")
          .trim();

      const assistantNodes = Array.from(
        document.querySelectorAll("[data-message-author-role='assistant']"),
      );
      const assistantTexts = assistantNodes
        .map((node) => normalize(node && node.innerText))
        .filter(Boolean);
      const assistant = assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1] : "";
      const userNodes = Array.from(
        document.querySelectorAll("[data-message-author-role='user']"),
      );
      const userTexts = userNodes
        .map((node) => normalize(node && node.innerText))
        .filter(Boolean);
      const user = userTexts.length > 0 ? userTexts[userTexts.length - 1] : "";
      const userCount = userTexts.length;
      const lines = assistant
        ? assistant
            .split("\\n")
            .map((line) => String(line || "").replace(/\\s+/g, " ").trim())
            .filter(Boolean)
            .slice(-80)
        : [];
      const title = document.title || "";
      const titleLower = title.toLowerCase();
      const textLower = String((document.body && document.body.textContent) || "")
        .slice(0, 3000)
        .toLowerCase();
      const hasCaptchaSelector = Boolean(
        document.querySelector(
          "iframe[src*='captcha' i], iframe[src*='challenge' i], [id*='captcha' i], [data-testid*='captcha' i], [id*='challenge' i], .cf-turnstile, [data-sitekey]",
        ),
      );
      const looksLikeHumanCheck =
        titleLower.includes("just a moment") ||
        textLower.includes("verify you are human") ||
        textLower.includes("unusual activity") ||
        textLower.includes("验证你是") ||
        textLower.includes("请先验证");
      const blockedReason = hasCaptchaSelector
        ? "captcha"
        : looksLikeHumanCheck
          ? "human-check"
          : "";
      const isGenerating = Boolean(
        document.querySelector(
          "button[data-testid='stop-button'], button[aria-label*='stop generating' i], button[aria-label*='停止生成' i], button[aria-label*='停止' i]",
        ),
      );

      return {
        ok: true,
        title,
        url: location.href,
        lines,
        assistant,
        user,
        userCount,
        blockedReason,
        isGenerating,
      };
    })()`;
  }
  return `(() => {
    const main = document.querySelector("main") || document.body;
    const raw = String((main && main.innerText) || "").replace(/\\r/g, "");
    const lines = raw
      .split("\\n")
      .map((line) => String(line || "").replace(/\\s+/g, " ").trim())
      .filter(Boolean)
      .slice(-240);

    return {
      ok: true,
      title: document.title || "",
      url: location.href,
      lines,
    };
  })()`;
}

function parseEvaluateResult(raw: unknown): {
  title: string;
  url: string;
  lines: string[];
  assistant?: string;
  user?: string;
  userCount?: number;
  blockedReason?: string;
  isGenerating?: boolean;
} {
  if (!raw || typeof raw !== "object") {
    throw new Error("Web evaluate returned empty result");
  }
  const src = raw as Record<string, unknown>;
  if (src.ok === false) {
    const message = typeof src.error === "string" ? src.error : "Web evaluate failed";
    throw new Error(message);
  }
  const title = typeof src.title === "string" ? src.title : "";
  const url = typeof src.url === "string" ? src.url : "";
  const lines = Array.isArray(src.lines)
    ? src.lines
        .map((line) => String(line))
        .map((line) => trimText(line))
        .filter(Boolean)
    : [];
  const assistant = typeof src.assistant === "string" ? trimText(src.assistant) : undefined;
  const user = typeof src.user === "string" ? trimText(src.user) : undefined;
  const userCount =
    typeof src.userCount === "number" && Number.isFinite(src.userCount) && src.userCount >= 0
      ? Math.floor(src.userCount)
      : undefined;
  const blockedReason =
    typeof src.blockedReason === "string" ? trimText(src.blockedReason) : undefined;
  const isGenerating = src.isGenerating === true;
  return {
    title,
    url,
    lines,
    ...(assistant ? { assistant } : {}),
    ...(user ? { user } : {}),
    ...(typeof userCount === "number" ? { userCount } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    ...(isGenerating ? { isGenerating } : {}),
  };
}

function looksIncompleteAnswer(answer: string): boolean {
  const lower = answer.toLowerCase();
  return (
    lower.includes("思考中") ||
    lower.includes("正在思考") ||
    lower.includes("typing") ||
    lower.includes("生成中")
  );
}

function isNewChatgptAnswer(answer: string, baselineAnswer: string): boolean {
  const current = trimText(answer);
  if (!current) {
    return false;
  }
  const baseline = trimText(baselineAnswer);
  if (!baseline) {
    return true;
  }
  return current !== baseline;
}

function isLikelySamePrompt(prompt: string, latestUserText: string): boolean {
  const promptNorm = trimText(prompt);
  const latestNorm = trimText(latestUserText);
  if (!promptNorm || !latestNorm) {
    return false;
  }
  if (latestNorm === promptNorm) {
    return true;
  }
  const snippetLength = Math.min(24, promptNorm.length);
  if (snippetLength < 8) {
    return false;
  }
  return latestNorm.includes(promptNorm.slice(0, snippetLength));
}

function resolvePollIntervalMs(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 7_000;
  }
  return Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS, Math.floor(raw)));
}

function shouldStartFreshConversation(params: {
  bridgeKind: BridgeKind;
  forceNewConversation?: boolean;
  targetId?: string;
  turnsInConversation: number;
}): boolean {
  return (
    params.forceNewConversation === true ||
    !params.targetId ||
    (params.bridgeKind !== "chatgpt" && params.turnsInConversation >= MAX_TURNS_PER_CONVERSATION)
  );
}

function normalizeBridgeTaskError(error: unknown, displayName: string): string {
  const raw = String((error as Error)?.message ?? error).trim();
  const lower = raw.toLowerCase();
  if (lower.includes("http 404") || lower.includes("profile unknown")) {
    return "浏览器控制未就绪（chrome profile 未连接）。请确认浏览器扩展中继已连接后重试。";
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "浏览器控制超时，请确认本机 Chrome 可控并重试。";
  }
  if (lower.includes("input-not-found")) {
    return `未找到 ${displayName} 输入框，请确认页面已登录并停留在聊天页。`;
  }
  return raw || "未知错误";
}

async function withHardTimeout<T>(
  task: Promise<T>,
  label: string,
  timeoutMs = BROWSER_OPERATION_HARD_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function runDeepseekTask(params: {
  bridgeKind: BridgeKind;
  bridge: ResolvedWechatOfficialAccount["deepseekBridge"];
  displayName: string;
  prompt: string;
  forceNewConversation?: boolean;
  conversation?: DeepseekConversationState;
  onProgress: (patch: { preview?: string; targetUrl?: string; targetId?: string }) => Promise<void>;
}): Promise<RunDeepseekTaskResult> {
  const cfg = params.bridge;
  const selectors = resolveBridgeSelectors(params.bridgeKind);
  const pollIntervalMs = resolvePollIntervalMs(cfg.pollIntervalMs);
  let baselineAssistant = "";
  let baselineUser = "";
  let baselineUserCount = 0;
  let turnsInConversation = params.conversation?.turnsInConversation ?? 0;
  let targetId = params.conversation?.targetId;
  let targetUrl = params.conversation?.targetUrl ?? cfg.openUrl;

  const shouldOpenNewConversation = shouldStartFreshConversation({
    bridgeKind: params.bridgeKind,
    forceNewConversation: params.forceNewConversation,
    targetId,
    turnsInConversation,
  });
  if (shouldOpenNewConversation) {
    turnsInConversation = 0;
    targetUrl = cfg.openUrl;

    // Prefer reusing the same ChatGPT tab and navigating to a fresh chat.
    // If navigation fails, fall back to opening a new tab.
    if (params.bridgeKind === "chatgpt" && params.forceNewConversation === true && targetId) {
      try {
        const navigated = await withHardTimeout(
          browserNavigate(undefined, {
            targetId,
            url: cfg.openUrl,
            profile: cfg.browserProfile,
          }),
          "browser navigate",
        );
        targetId = navigated.targetId;
        targetUrl = navigated.url || cfg.openUrl;
        await withHardTimeout(
          browserAct(
            undefined,
            {
              kind: "wait",
              targetId,
              selector: selectors.inputSelector,
              timeoutMs: 12_000,
            },
            { profile: cfg.browserProfile },
          ),
          "browser wait input after navigate",
        );
      } catch {
        targetId = undefined;
      }
    } else if (params.bridgeKind !== "chatgpt") {
      targetId = undefined;
    }
  } else if (targetId) {
    try {
      await withHardTimeout(
        browserAct(
          undefined,
          {
            kind: "wait",
            targetId,
            selector: selectors.inputSelector,
            timeoutMs: 8_000,
          },
          { profile: cfg.browserProfile },
        ),
        "browser wait input",
      );
    } catch {
      targetId = undefined;
    }
  }

  if (!targetId && params.bridgeKind === "chatgpt") {
    try {
      const tabs = await withHardTimeout(
        browserTabs(undefined, { profile: cfg.browserProfile }),
        "browser list tabs",
      );
      const existing = pickChatgptTab(tabs);
      if (existing) {
        targetId = existing.targetId;
        targetUrl = existing.url || targetUrl;
        if (shouldOpenNewConversation) {
          const navigated = await withHardTimeout(
            browserNavigate(undefined, {
              targetId,
              url: cfg.openUrl,
              profile: cfg.browserProfile,
            }),
            "browser navigate existing chatgpt tab",
          );
          targetId = navigated.targetId;
          targetUrl = navigated.url || cfg.openUrl;
        }
      }
    } catch {
      // Fall through to explicit not-found error below.
    }
  }

  if (!targetId && params.bridgeKind === "chatgpt") {
    return {
      status: "error",
      error:
        "未找到已打开的 ChatGPT 页面。请先在同一浏览器 profile 打开并登录 https://chatgpt.com/ 后重试。",
      targetUrl,
    };
  }

  if (!targetId) {
    const tab = await withHardTimeout(
      browserOpenTab(undefined, cfg.openUrl, {
        profile: cfg.browserProfile,
      }),
      "browser open tab",
    );
    targetId = tab.targetId;
    targetUrl = tab.url;
    turnsInConversation = 0;

    await withHardTimeout(
      browserAct(
        undefined,
        {
          kind: "wait",
          targetId,
          selector: selectors.inputSelector,
          timeoutMs: 20_000,
        },
        { profile: cfg.browserProfile },
      ),
      "browser wait input after open tab",
    );
  }

  if (params.bridgeKind === "chatgpt") {
    try {
      const baselineSnapshot = await withHardTimeout(
        browserAct(
          undefined,
          {
            kind: "evaluate",
            targetId,
            fn: buildSnapshotEvalFn("chatgpt"),
            timeoutMs: 20_000,
          },
          { profile: cfg.browserProfile },
        ),
        "browser baseline snapshot",
      );
      const baselineParsed = parseEvaluateResult(baselineSnapshot.result);
      baselineAssistant = baselineParsed.assistant?.trim() ?? "";
      baselineUser = baselineParsed.user?.trim() ?? "";
      baselineUserCount = baselineParsed.userCount ?? 0;
      targetUrl = baselineParsed.url || targetUrl;
    } catch {
      baselineAssistant = "";
      baselineUser = "";
      baselineUserCount = 0;
    }
  }

  let sendResult:
    | {
        ok: true;
      }
    | undefined;
  if (params.bridgeKind === "chatgpt") {
    try {
      const sent = await withHardTimeout(
        sendChatgptPromptViaAriaActions({
          profile: cfg.browserProfile,
          targetId,
          prompt: params.prompt,
        }),
        "browser aria send prompt",
      );
      if (sent) {
        sendResult = { ok: true };
      }
    } catch {
      try {
        const afterSendSnapshot = await withHardTimeout(
          browserAct(
            undefined,
            {
              kind: "evaluate",
              targetId,
              fn: buildSnapshotEvalFn("chatgpt"),
              timeoutMs: 20_000,
            },
            { profile: cfg.browserProfile },
          ),
          "browser post-send snapshot",
        );
        const afterSendParsed = parseEvaluateResult(afterSendSnapshot.result);
        const latestUser = afterSendParsed.user?.trim() ?? "";
        const userCount = afterSendParsed.userCount ?? 0;
        const userCountIncreased = userCount > baselineUserCount;
        const textLooksPosted =
          latestUser !== baselineUser && isLikelySamePrompt(params.prompt, latestUser);
        sendResult = userCountIncreased || textLooksPosted ? { ok: true } : undefined;
      } catch {
        sendResult = undefined;
      }
    }
  }

  if (!sendResult) {
    const legacySendResult = await withHardTimeout(
      browserAct(
        undefined,
        {
          kind: "evaluate",
          targetId,
          fn: buildSendEvalFn({
            text: params.prompt,
            inputSelector: selectors.inputSelector,
            sendButtonSelector: selectors.sendButtonSelector,
          }),
          timeoutMs: 20_000,
        },
        { profile: cfg.browserProfile },
      ),
      "browser legacy send prompt",
    );
    sendResult = legacySendResult.ok === true ? { ok: true } : undefined;
  }

  if (!sendResult || sendResult.ok !== true) {
    return {
      status: "error",
      error: `failed to send prompt to ${params.displayName}`,
      targetId,
      targetUrl,
    };
  }
  turnsInConversation =
    params.bridgeKind === "chatgpt"
      ? Math.max(0, turnsInConversation + 1)
      : Math.min(turnsInConversation + 1, MAX_TURNS_PER_CONVERSATION);

  const startedAt = Date.now();
  let latestAnswer = "";
  let latestPreview = "";
  let stableRounds = 0;
  let lastStableCandidate = "";
  let lastAnswerChangeAt = Date.now();

  while (Date.now() - startedAt < cfg.maxWaitMs) {
    await withHardTimeout(
      browserAct(
        undefined,
        {
          kind: "wait",
          targetId,
          timeMs: pollIntervalMs,
          timeoutMs: pollIntervalMs + 2_000,
        },
        { profile: cfg.browserProfile },
      ),
      "browser poll wait",
    );

    const snapshot = await withHardTimeout(
      browserAct(
        undefined,
        {
          kind: "evaluate",
          targetId,
          fn: buildSnapshotEvalFn(params.bridgeKind),
          timeoutMs: 20_000,
        },
        { profile: cfg.browserProfile },
      ),
      "browser poll snapshot",
    );

    const parsed = parseEvaluateResult(snapshot.result);
    targetUrl = parsed.url || targetUrl;
    if (params.bridgeKind === "chatgpt" && parsed.blockedReason) {
      return {
        status: "error",
        error: "检测到 ChatGPT 页面验证/风控，请先在浏览器手动通过验证后再重试 gpt。",
        targetId,
        targetUrl,
        turnsInConversation,
      };
    }

    const answer =
      params.bridgeKind === "chatgpt"
        ? (parsed.assistant?.trim() ?? "")
        : deriveAnswerFromLines(parsed.lines, params.prompt);
    if (!answer) {
      continue;
    }
    if (params.bridgeKind === "chatgpt" && !isNewChatgptAnswer(answer, baselineAssistant)) {
      continue;
    }

    latestAnswer = answer;
    latestPreview = truncateText(answer, MAX_PREVIEW_CHARS);
    await params.onProgress({
      preview: latestPreview,
      targetUrl,
      targetId,
    });

    if (answer === lastStableCandidate) {
      stableRounds += 1;
    } else {
      lastStableCandidate = answer;
      stableRounds = 0;
      lastAnswerChangeAt = Date.now();
    }

    if (params.bridgeKind === "chatgpt") {
      const stillGenerating = parsed.isGenerating === true;
      const quietForMs = Date.now() - lastAnswerChangeAt;
      if (!stillGenerating && stableRounds >= 1 && quietForMs >= pollIntervalMs) {
        return {
          status: "done",
          answer: truncateText(answer, MAX_INLINE_ANSWER_CHARS),
          preview: latestPreview,
          targetId,
          targetUrl,
          turnsInConversation,
        };
      }
      continue;
    }

    if (stableRounds >= 2 && !looksIncompleteAnswer(answer)) {
      return {
        status: "done",
        answer: truncateText(answer, MAX_INLINE_ANSWER_CHARS),
        preview: latestPreview,
        targetId,
        targetUrl,
        turnsInConversation,
      };
    }
  }

  if (latestAnswer) {
    return {
      status: "done",
      answer:
        `${truncateText(latestAnswer, MAX_INLINE_ANSWER_CHARS)}\n\n` +
        "[系统] 已达到等待上限，以上可能是部分结果。",
      preview: latestPreview,
      targetId,
      targetUrl,
      turnsInConversation,
    };
  }

  return {
    status: "error",
    error: `${params.displayName} response timeout`,
    preview: latestPreview,
    targetId,
    targetUrl,
    turnsInConversation,
  };
}

async function kickAccountRunner(params: {
  runtime: PluginRuntime;
  bridgeKind: BridgeKind;
  accountId: string;
  log?: { warn?: (message: string) => void; error?: (message: string) => void };
}): Promise<void> {
  const runnerKey = resolveRunnerKey(params.bridgeKind, params.accountId);
  if (runningAccountRunners.has(runnerKey)) {
    return;
  }
  runningAccountRunners.add(runnerKey);

  void (async () => {
    try {
      while (true) {
        const task = await withStateLock({
          runtime: params.runtime,
          persist: true,
          mutate: (state) => {
            for (const id of state.order) {
              const candidate = id ? state.tasks[id] : undefined;
              if (!candidate) {
                continue;
              }
              if (
                candidate.bridgeKind !== params.bridgeKind ||
                candidate.accountId !== params.accountId ||
                candidate.status !== "queued"
              ) {
                continue;
              }
              const now = Date.now();
              candidate.status = "running";
              candidate.startedAtMs = now;
              candidate.updatedAtMs = now;
              return { ...candidate };
            }
            return null;
          },
        });

        if (!task) {
          break;
        }

        try {
          const cfg = await params.runtime.config.loadConfig();
          const account = resolveWechatOfficialAccount({ cfg, accountId: params.accountId });
          const bridge = resolveBridgeConfig(account, params.bridgeKind);
          const displayName = resolveBridgeDisplayName(params.bridgeKind);
          const conversation = await withStateLock({
            runtime: params.runtime,
            persist: false,
            mutate: (state) => {
              const current =
                state.conversations[
                  resolveConversationStateKey(params.bridgeKind, params.accountId)
                ] ??
                (params.bridgeKind === "deepseek"
                  ? state.conversations[params.accountId]
                  : undefined);
              return current ? { ...current } : undefined;
            },
          });
          const result = await runDeepseekTask({
            bridgeKind: params.bridgeKind,
            bridge,
            displayName,
            prompt: task.prompt,
            forceNewConversation: task.forceNewConversation === true,
            conversation,
            onProgress: async (patch) => {
              await withStateLock({
                runtime: params.runtime,
                persist: true,
                mutate: (state) => {
                  const current = state.tasks[task.id];
                  if (!current || current.status !== "running") {
                    return;
                  }
                  current.updatedAtMs = Date.now();
                  if (patch.preview) {
                    current.preview = patch.preview;
                  }
                  if (patch.targetId) {
                    current.targetId = patch.targetId;
                  }
                  if (patch.targetUrl) {
                    current.targetUrl = patch.targetUrl;
                  }
                },
              });
            },
          });

          await withStateLock({
            runtime: params.runtime,
            persist: true,
            mutate: (state) => {
              const current = state.tasks[task.id];
              if (!current) {
                return;
              }
              const now = Date.now();
              current.updatedAtMs = now;
              current.finishedAtMs = now;
              current.targetId = result.targetId ?? current.targetId;
              current.targetUrl = result.targetUrl ?? current.targetUrl;
              current.preview = result.preview ?? current.preview;
              if (result.targetId) {
                state.conversations[
                  resolveConversationStateKey(params.bridgeKind, params.accountId)
                ] = {
                  targetId: result.targetId,
                  targetUrl: result.targetUrl ?? current.targetUrl,
                  turnsInConversation: result.turnsInConversation ?? 1,
                  updatedAtMs: now,
                };
              }

              if (result.status === "done") {
                current.status = "done";
                current.answer = result.answer;
                current.fetchCursor = 0;
                current.error = undefined;
              } else {
                current.status = "error";
                current.error = result.error;
              }
            },
          });
        } catch (error) {
          const message = normalizeBridgeTaskError(
            error,
            resolveBridgeDisplayName(params.bridgeKind),
          );
          await withStateLock({
            runtime: params.runtime,
            persist: true,
            mutate: (state) => {
              const current = state.tasks[task.id];
              if (!current) {
                return;
              }
              const now = Date.now();
              current.status = "error";
              current.error = message;
              current.updatedAtMs = now;
              current.finishedAtMs = now;
            },
          });
          params.log?.warn?.(
            `wechat-official ${params.bridgeKind} task failed (${task.id}): ${message}`,
          );
        }
      }
    } catch (error) {
      params.log?.error?.(`wechat-official ${params.bridgeKind} runner crashed: ${String(error)}`);
    } finally {
      runningAccountRunners.delete(runnerKey);
    }
  })();
}

async function maybeHandleWechatWebBridgeInbound(params: {
  message: WechatInboundMessage;
  rawBody: string;
  senderId: string;
  account: ResolvedWechatOfficialAccount;
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  bridgeKind: BridgeKind;
  deliverReply: (text: string) => Promise<void>;
  log?: { warn?: (message: string) => void; error?: (message: string) => void };
}): Promise<{ handled: boolean }> {
  const bridge = resolveBridgeConfig(params.account, params.bridgeKind);
  const commandPrefix = bridge.commandPrefix.trim().toLowerCase() || "ds";
  const fetchCommand = `${commandPrefix}back`;
  const newConversationCommand = `${commandPrefix}new`;
  if (!bridge.enabled) {
    return { handled: false };
  }
  if (params.message.msgType !== "text") {
    return { handled: false };
  }

  const command = parseDeepseekCommand(params.rawBody, commandPrefix);
  if (command.kind === "none") {
    return { handled: false };
  }

  const accountId = params.account.accountId;
  const senderId = params.senderId;

  if (command.kind === "fetch") {
    const replyPlan = await withStateLock({
      runtime: params.runtime,
      persist: false,
      mutate: (state) => {
        const noTaskText = `未找到任务。先发包含 ${commandPrefix} 的消息创建任务，再发 ${fetchCommand} 取回结果。`;
        const task = findTaskForSender({
          state,
          bridgeKind: params.bridgeKind,
          accountId,
          senderId,
          taskId: command.taskId,
        });
        if (!task) {
          return { text: noTaskText };
        }

        if (task.status === "done") {
          const plan = planDoneTaskFetchReply({
            task,
            commandPrefix,
            fetchCommand,
          });
          const shouldCommitCursor = plan.cursorAfter > plan.cursorBefore;
          if (!shouldCommitCursor) {
            return { text: plan.text };
          }
          return {
            text: plan.text,
            commitCursor: {
              taskId: task.id,
              expectedCursor: plan.cursorBefore,
              nextCursor: plan.cursorAfter,
            },
          };
        }

        if (task.status === "error") {
          const lines = [`任务 ${task.id} 失败：${task.error ?? "未知错误"}`];
          if (task.preview) {
            lines.push(`当前预览：${task.preview}`);
          }
          return { text: lines.join("\n") };
        }

        return { text: formatTaskStatus(task) };
      },
    });

    await params.deliverReply(replyPlan.text);
    if (replyPlan.commitCursor) {
      await withStateLock({
        runtime: params.runtime,
        persist: true,
        mutate: (state) => {
          const current = state.tasks[replyPlan.commitCursor.taskId];
          if (!current || current.status !== "done") {
            return;
          }
          const currentCursor = normalizeFetchCursor(current.fetchCursor);
          if (currentCursor !== replyPlan.commitCursor.expectedCursor) {
            return;
          }
          current.fetchCursor = replyPlan.commitCursor.nextCursor;
          current.updatedAtMs = Date.now();
        },
      });
    }
    return { handled: true };
  }

  if (command.kind === "enqueue") {
    if (!command.prompt.trim()) {
      await params.deliverReply(
        `请在消息里带上 ${commandPrefix} 和问题内容。需要新开会话可发送 ${newConversationCommand} + 问题。取回结果请发 ${fetchCommand}。`,
      );
      return { handled: true };
    }

    const taskId = await withStateLock({
      runtime: params.runtime,
      persist: true,
      mutate: (state) => {
        const now = Date.now();
        const task: DeepseekTaskRecord = {
          id: `${commandPrefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
          bridgeKind: params.bridgeKind,
          accountId,
          senderId,
          prompt: command.prompt,
          forceNewConversation: command.forceNewConversation === true,
          status: "queued",
          createdAtMs: now,
          updatedAtMs: now,
          fetchCursor: 0,
        };

        state.tasks[task.id] = task;
        state.order.push(task.id);
        if (state.order.length > MAX_RECENT_TASKS) {
          const removed = state.order.splice(0, state.order.length - MAX_RECENT_TASKS);
          for (const id of removed) {
            delete state.tasks[id];
          }
        }
        return task.id;
      },
    });

    await kickAccountRunner({
      runtime: params.runtime,
      bridgeKind: params.bridgeKind,
      accountId,
      log: params.log,
    });

    await params.deliverReply(
      `${bridge.thinkingReply}\n任务ID：${taskId}\n发送 ${fetchCommand} 可取回最新结果。`,
    );
    return { handled: true };
  }

  return { handled: false };
}

export async function maybeHandleWechatDeepseekBridgeInbound(params: {
  message: WechatInboundMessage;
  rawBody: string;
  senderId: string;
  account: ResolvedWechatOfficialAccount;
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  deliverReply: (text: string) => Promise<void>;
  log?: { warn?: (message: string) => void; error?: (message: string) => void };
}): Promise<{ handled: boolean }> {
  return await maybeHandleWechatWebBridgeInbound({
    ...params,
    bridgeKind: "deepseek",
  });
}

export async function maybeHandleWechatChatgptBridgeInbound(params: {
  message: WechatInboundMessage;
  rawBody: string;
  senderId: string;
  account: ResolvedWechatOfficialAccount;
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  deliverReply: (text: string) => Promise<void>;
  log?: { warn?: (message: string) => void; error?: (message: string) => void };
}): Promise<{ handled: boolean }> {
  return await maybeHandleWechatWebBridgeInbound({
    ...params,
    bridgeKind: "chatgpt",
  });
}

export const __testing = {
  parseDeepseekCommand,
  deriveAnswerFromLines,
  splitAnswerForFetch,
  buildDoneTaskFetchReply,
  sanitizeUiLines,
  isNewChatgptAnswer,
  isLikelySamePrompt,
  shouldStartFreshConversation,
  pickChatgptTextboxRef,
  pickChatgptSendButtonRef,
  pickChatgptTab,
};
