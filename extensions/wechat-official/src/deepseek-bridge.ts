import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/compat";
import { browserAct } from "../../../src/browser/client-actions.js";
import { browserOpenTab } from "../../../src/browser/client.js";
import { resolveWechatOfficialAccount } from "./accounts.js";
import type { ResolvedWechatOfficialAccount, WechatInboundMessage } from "./types.js";

type DeepseekTaskStatus = "queued" | "running" | "done" | "error";

type DeepseekTaskRecord = {
  id: string;
  accountId: string;
  senderId: string;
  prompt: string;
  status: DeepseekTaskStatus;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  targetId?: string;
  targetUrl?: string;
  preview?: string;
  answer?: string;
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
  | { kind: "enqueue"; prompt: string }
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

const MAX_PREVIEW_CHARS = 300;
const MAX_INLINE_ANSWER_CHARS = 6_000;
const MAX_RECENT_TASKS = 120;
const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 10_000;
const MAX_TURNS_PER_CONVERSATION = 10;

let stateLockChain: Promise<void> = Promise.resolve();
const runningAccountRunners = new Set<string>();

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
    const tasks = parsed.tasks && typeof parsed.tasks === "object" ? parsed.tasks : {};
    const order = Array.isArray(parsed.order)
      ? parsed.order.filter((id) => typeof id === "string")
      : [];
    const conversations =
      parsed.conversations && typeof parsed.conversations === "object" ? parsed.conversations : {};

    return {
      version: 1,
      tasks: tasks as Record<string, DeepseekTaskRecord>,
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

function parseDeepseekCommand(rawBody: string): DeepseekCommand {
  const text = rawBody.trim();
  if (!text) {
    return { kind: "none" };
  }

  const lower = text.toLowerCase();
  if (lower.startsWith("dsback")) {
    const taskId = text.slice("dsback".length).trim();
    return { kind: "fetch", ...(taskId ? { taskId } : {}) };
  }

  const dsIndex = lower.indexOf("ds");
  if (dsIndex < 0) {
    return { kind: "none" };
  }

  let prompt = text;
  if (dsIndex === 0) {
    prompt = text.slice(2).trim();
  } else {
    prompt = text.slice(0, dsIndex) + text.slice(dsIndex + 2);
    prompt = prompt.trim();
  }

  return { kind: "enqueue", prompt: prompt || text };
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
  accountId: string;
  senderId: string;
  taskId?: string;
}): DeepseekTaskRecord | undefined {
  if (params.taskId) {
    const task = params.state.tasks[params.taskId];
    if (!task) {
      return undefined;
    }
    if (task.accountId !== params.accountId || task.senderId !== params.senderId) {
      return undefined;
    }
    return task;
  }

  for (let i = params.state.order.length - 1; i >= 0; i -= 1) {
    const id = params.state.order[i];
    const task = id ? params.state.tasks[id] : undefined;
    if (!task) {
      continue;
    }
    if (task.accountId === params.accountId && task.senderId === params.senderId) {
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

function buildSendEvalFn(params: {
  text: string;
  inputSelector: string;
  sendButtonSelector: string;
}): string {
  const payload = JSON.stringify(params);
  return `(() => {
    const cfg = ${payload};
    const input = document.querySelector(cfg.inputSelector);
    if (!input) {
      return { ok: false, error: "input-not-found" };
    }

    if (!(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement || (input instanceof HTMLElement && input.isContentEditable))) {
      return { ok: false, error: "input-not-editable" };
    }

    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")?.set;
      if (typeof setter === "function") setter.call(input, cfg.text);
      else input.value = cfg.text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      input.focus();
      input.textContent = cfg.text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const btn = cfg.sendButtonSelector ? document.querySelector(cfg.sendButtonSelector) : null;
    if (btn instanceof HTMLElement && !btn.hasAttribute("disabled") && btn.getAttribute("aria-disabled") !== "true") {
      btn.click();
      return { ok: true, via: "button" };
    }

    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
    }));
    input.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
    }));

    return { ok: true, via: "enter" };
  })()`;
}

function buildSnapshotEvalFn(): string {
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

function parseEvaluateResult(raw: unknown): { title: string; url: string; lines: string[] } {
  if (!raw || typeof raw !== "object") {
    throw new Error("DeepSeek evaluate returned empty result");
  }
  const src = raw as Record<string, unknown>;
  if (src.ok === false) {
    const message = typeof src.error === "string" ? src.error : "DeepSeek evaluate failed";
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
  return { title, url, lines };
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

function resolvePollIntervalMs(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 7_000;
  }
  return Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS, Math.floor(raw)));
}

function normalizeDeepseekTaskError(error: unknown): string {
  const raw = String((error as Error)?.message ?? error).trim();
  const lower = raw.toLowerCase();
  if (lower.includes("http 404") || lower.includes("profile unknown")) {
    return "浏览器控制未就绪（chrome profile 未连接）。请确认浏览器扩展中继已连接后重试。";
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "浏览器控制超时，请确认本机 Chrome 可控并重试。";
  }
  if (lower.includes("input-not-found")) {
    return "未找到 DeepSeek 输入框，请确认页面已登录并停留在聊天页。";
  }
  return raw || "未知错误";
}

async function runDeepseekTask(params: {
  account: ResolvedWechatOfficialAccount;
  prompt: string;
  conversation?: DeepseekConversationState;
  onProgress: (patch: { preview?: string; targetUrl?: string; targetId?: string }) => Promise<void>;
}): Promise<RunDeepseekTaskResult> {
  const cfg = params.account.deepseekBridge;
  const pollIntervalMs = resolvePollIntervalMs(cfg.pollIntervalMs);
  let turnsInConversation = params.conversation?.turnsInConversation ?? 0;
  let targetId = params.conversation?.targetId;
  let targetUrl = params.conversation?.targetUrl ?? cfg.openUrl;

  const shouldOpenNewConversation = !targetId || turnsInConversation >= MAX_TURNS_PER_CONVERSATION;
  if (!shouldOpenNewConversation && targetId) {
    try {
      await browserAct(
        undefined,
        {
          kind: "wait",
          targetId,
          selector: DEFAULT_INPUT_SELECTOR,
          timeoutMs: 8_000,
        },
        { profile: cfg.browserProfile },
      );
    } catch {
      targetId = undefined;
    }
  }

  if (!targetId) {
    const tab = await browserOpenTab(undefined, cfg.openUrl, {
      profile: cfg.browserProfile,
    });
    targetId = tab.targetId;
    targetUrl = tab.url;
    turnsInConversation = 0;

    await browserAct(
      undefined,
      {
        kind: "wait",
        targetId,
        selector: DEFAULT_INPUT_SELECTOR,
        timeoutMs: 20_000,
      },
      { profile: cfg.browserProfile },
    );
  }

  const sendResult = await browserAct(
    undefined,
    {
      kind: "evaluate",
      targetId,
      fn: buildSendEvalFn({
        text: params.prompt,
        inputSelector: DEFAULT_INPUT_SELECTOR,
        sendButtonSelector: DEFAULT_SEND_BUTTON_SELECTOR,
      }),
      timeoutMs: 20_000,
    },
    { profile: cfg.browserProfile },
  );

  if (!sendResult || sendResult.ok !== true) {
    return { status: "error", error: "failed to send prompt to DeepSeek", targetId, targetUrl };
  }
  turnsInConversation = Math.min(turnsInConversation + 1, MAX_TURNS_PER_CONVERSATION);

  const startedAt = Date.now();
  let latestAnswer = "";
  let latestPreview = "";
  let stableRounds = 0;
  let lastStableCandidate = "";

  while (Date.now() - startedAt < cfg.maxWaitMs) {
    await browserAct(
      undefined,
      {
        kind: "wait",
        targetId,
        timeMs: pollIntervalMs,
        timeoutMs: pollIntervalMs + 2_000,
      },
      { profile: cfg.browserProfile },
    );

    const snapshot = await browserAct(
      undefined,
      {
        kind: "evaluate",
        targetId,
        fn: buildSnapshotEvalFn(),
        timeoutMs: 20_000,
      },
      { profile: cfg.browserProfile },
    );

    const parsed = parseEvaluateResult(snapshot.result);
    targetUrl = parsed.url || targetUrl;

    const answer = deriveAnswerFromLines(parsed.lines, params.prompt);
    if (!answer) {
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
    error: "DeepSeek response timeout",
    preview: latestPreview,
    targetId,
    targetUrl,
    turnsInConversation,
  };
}

async function kickAccountRunner(params: {
  runtime: PluginRuntime;
  cfg: OpenClawConfig;
  accountId: string;
  log?: { warn?: (message: string) => void; error?: (message: string) => void };
}): Promise<void> {
  if (runningAccountRunners.has(params.accountId)) {
    return;
  }
  runningAccountRunners.add(params.accountId);

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
              if (candidate.accountId !== params.accountId || candidate.status !== "queued") {
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
          const conversation = await withStateLock({
            runtime: params.runtime,
            persist: false,
            mutate: (state) => {
              const current = state.conversations[params.accountId];
              return current ? { ...current } : undefined;
            },
          });
          const result = await runDeepseekTask({
            account,
            prompt: task.prompt,
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
                state.conversations[params.accountId] = {
                  targetId: result.targetId,
                  targetUrl: result.targetUrl ?? current.targetUrl,
                  turnsInConversation: result.turnsInConversation ?? 1,
                  updatedAtMs: now,
                };
              }

              if (result.status === "done") {
                current.status = "done";
                current.answer = result.answer;
                current.error = undefined;
              } else {
                current.status = "error";
                current.error = result.error;
              }
            },
          });
        } catch (error) {
          const message = normalizeDeepseekTaskError(error);
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
          params.log?.warn?.(`wechat-official deepseek task failed (${task.id}): ${message}`);
        }
      }
    } catch (error) {
      params.log?.error?.(`wechat-official deepseek runner crashed: ${String(error)}`);
    } finally {
      runningAccountRunners.delete(params.accountId);
    }
  })();
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
  const bridge = params.account.deepseekBridge;
  if (!bridge.enabled) {
    return { handled: false };
  }
  if (params.message.msgType !== "text") {
    return { handled: false };
  }

  const command = parseDeepseekCommand(params.rawBody);
  if (command.kind === "none") {
    return { handled: false };
  }

  const accountId = params.account.accountId;
  const senderId = params.senderId;

  if (command.kind === "fetch") {
    const text = await withStateLock({
      runtime: params.runtime,
      persist: false,
      mutate: (state) => {
        const task = findTaskForSender({
          state,
          accountId,
          senderId,
          taskId: command.taskId,
        });
        if (!task) {
          return "未找到任务。先发包含 ds 的消息创建任务，再发 dsback 取回结果。";
        }

        if (task.status === "done") {
          const answer = task.answer?.trim() || task.preview?.trim() || "(无文本结果)";
          return [`任务 ${task.id} 已完成：`, answer].join("\n");
        }

        if (task.status === "error") {
          const lines = [`任务 ${task.id} 失败：${task.error ?? "未知错误"}`];
          if (task.preview) {
            lines.push(`当前预览：${task.preview}`);
          }
          return lines.join("\n");
        }

        return formatTaskStatus(task);
      },
    });

    await params.deliverReply(text);
    return { handled: true };
  }

  if (command.kind === "enqueue") {
    if (!command.prompt.trim()) {
      await params.deliverReply("请在消息里带上 ds 和问题内容。取回结果请发 dsback。");
      return { handled: true };
    }

    const taskId = `ds-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    await withStateLock({
      runtime: params.runtime,
      persist: true,
      mutate: (state) => {
        const now = Date.now();
        const task: DeepseekTaskRecord = {
          id: taskId,
          accountId,
          senderId,
          prompt: command.prompt,
          status: "queued",
          createdAtMs: now,
          updatedAtMs: now,
        };

        state.tasks[taskId] = task;
        state.order.push(taskId);
        if (state.order.length > MAX_RECENT_TASKS) {
          const removed = state.order.splice(0, state.order.length - MAX_RECENT_TASKS);
          for (const id of removed) {
            delete state.tasks[id];
          }
        }
      },
    });

    await kickAccountRunner({
      runtime: params.runtime,
      cfg: params.cfg,
      accountId,
      log: params.log,
    });

    await params.deliverReply(
      `${bridge.thinkingReply}\n任务ID：${taskId}\n发送 dsback 可取回最新结果。`,
    );
    return { handled: true };
  }

  return { handled: false };
}

export const __testing = {
  parseDeepseekCommand,
  deriveAnswerFromLines,
  sanitizeUiLines,
};
