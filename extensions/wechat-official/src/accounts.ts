import {
  DEFAULT_ACCOUNT_ID,
  createAccountListHelpers,
  normalizeAccountId,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/compat";
import {
  WECHAT_DEFAULT_TEXT_CHUNK_LIMIT,
  WECHAT_DEFAULT_WEBHOOK_PATH,
  WECHAT_OFFICIAL_CHANNEL_ID,
  type ResolvedWechatOfficialAccount,
  type WechatDmPolicy,
  type WechatOfficialAccountConfig,
  type WechatOfficialConfig,
} from "./types.js";

const {
  listAccountIds: listWechatOfficialAccountIds,
  resolveDefaultAccountId: resolveDefaultWechatOfficialAccountId,
} = createAccountListHelpers(WECHAT_OFFICIAL_CHANNEL_ID);

const ENV_APP_ID = "WECHAT_OFFICIAL_APP_ID";
const ENV_APP_SECRET = "WECHAT_OFFICIAL_APP_SECRET";
const ENV_TOKEN = "WECHAT_OFFICIAL_TOKEN";
const ENV_ENCODING_AES_KEY = "WECHAT_OFFICIAL_ENCODING_AES_KEY";
const ENV_WEBHOOK_PATH = "WECHAT_OFFICIAL_WEBHOOK_PATH";
const ENV_DM_POLICY = "WECHAT_OFFICIAL_DM_POLICY";
const ENV_ALLOW_FROM = "WECHAT_OFFICIAL_ALLOW_FROM";
const ENV_TEXT_CHUNK_LIMIT = "WECHAT_OFFICIAL_TEXT_CHUNK_LIMIT";

const DEFAULT_DEEPSEEK_COMMAND_PREFIX = "ds";
const DEFAULT_DEEPSEEK_PROFILE = "chrome";
const DEFAULT_DEEPSEEK_OPEN_URL = "https://chat.deepseek.com/";
const DEFAULT_DEEPSEEK_POLL_INTERVAL_MS = 7_000;
const DEFAULT_DEEPSEEK_MAX_WAIT_MS = 300_000;
const DEFAULT_DEEPSEEK_THINKING_REPLY = "已收到，DeepSeek 正在思考中。请稍后发送“dsback”获取结果。";

const DEFAULT_CHATGPT_COMMAND_PREFIX = "gpt";
const DEFAULT_CHATGPT_PROFILE = "chrome";
const DEFAULT_CHATGPT_OPEN_URL = "https://chatgpt.com/";
const DEFAULT_CHATGPT_POLL_INTERVAL_MS = 7_000;
const DEFAULT_CHATGPT_MAX_WAIT_MS = 300_000;
const DEFAULT_CHATGPT_THINKING_REPLY = "已收到，ChatGPT 正在思考中。请稍后发送“gptback”获取结果。";

function readChannelConfig(cfg: OpenClawConfig): WechatOfficialConfig {
  return (cfg.channels?.[WECHAT_OFFICIAL_CHANNEL_ID] ?? {}) as WechatOfficialConfig;
}

function resolveAccountOverride(
  channelConfig: WechatOfficialConfig,
  accountId: string,
): WechatOfficialAccountConfig {
  return channelConfig.accounts?.[accountId] ?? {};
}

function parseDmPolicy(raw: string | undefined): WechatDmPolicy | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "pairing" ||
    normalized === "allowlist" ||
    normalized === "open" ||
    normalized === "disabled"
  ) {
    return normalized;
  }
  return undefined;
}

function parseAllowFrom(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function parseTextChunkLimit(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === "string") {
    const value = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function clampTextChunkLimit(raw: number | undefined): number {
  const fallback = WECHAT_DEFAULT_TEXT_CHUNK_LIMIT;
  if (!raw || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(100, Math.min(2000, Math.floor(raw)));
}

function clampRange(raw: number | undefined, fallback: number, min: number, max: number): number {
  if (!raw || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function parseWebBridgeConfig(raw: unknown): {
  enabled?: boolean;
  commandPrefix?: string;
  browserProfile?: string;
  openUrl?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  thinkingReply?: string;
} {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const src = raw as Record<string, unknown>;
  const commandPrefix =
    typeof src.commandPrefix === "string" && src.commandPrefix.trim()
      ? src.commandPrefix.trim()
      : undefined;
  const browserProfile =
    typeof src.browserProfile === "string" && src.browserProfile.trim()
      ? src.browserProfile.trim()
      : undefined;
  const openUrl =
    typeof src.openUrl === "string" && src.openUrl.trim() ? src.openUrl.trim() : undefined;
  const thinkingReply =
    typeof src.thinkingReply === "string" && src.thinkingReply.trim()
      ? src.thinkingReply.trim()
      : undefined;
  const pollIntervalMs = parseTextChunkLimit(src.pollIntervalMs);
  const maxWaitMs = parseTextChunkLimit(src.maxWaitMs);
  const enabled = typeof src.enabled === "boolean" ? src.enabled : undefined;

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(commandPrefix ? { commandPrefix } : {}),
    ...(browserProfile ? { browserProfile } : {}),
    ...(openUrl ? { openUrl } : {}),
    ...(pollIntervalMs ? { pollIntervalMs } : {}),
    ...(maxWaitMs ? { maxWaitMs } : {}),
    ...(thinkingReply ? { thinkingReply } : {}),
  };
}

export function resolveWechatOfficialAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWechatOfficialAccount {
  const accountId = normalizeAccountId(params.accountId);
  const channel = readChannelConfig(params.cfg);
  const accountOverride = resolveAccountOverride(channel, accountId);
  const channelDeepseekBridge = parseWebBridgeConfig(channel.deepseekBridge);
  const accountDeepseekBridge = parseWebBridgeConfig(accountOverride.deepseekBridge);
  const mergedDeepseekBridge = { ...channelDeepseekBridge, ...accountDeepseekBridge };
  const channelChatgptBridge = parseWebBridgeConfig(channel.chatgptBridge);
  const accountChatgptBridge = parseWebBridgeConfig(accountOverride.chatgptBridge);
  const mergedChatgptBridge = { ...channelChatgptBridge, ...accountChatgptBridge };

  const merged = {
    ...channel,
    ...accountOverride,
  } as WechatOfficialAccountConfig;

  const useEnv = accountId === DEFAULT_ACCOUNT_ID;

  const appId = merged.appId?.trim() || (useEnv ? process.env[ENV_APP_ID]?.trim() : "") || "";
  const appSecret =
    merged.appSecret?.trim() || (useEnv ? process.env[ENV_APP_SECRET]?.trim() : "") || "";
  const token = merged.token?.trim() || (useEnv ? process.env[ENV_TOKEN]?.trim() : "") || "";
  const encodingAesKey =
    merged.encodingAesKey?.trim() ||
    (useEnv ? process.env[ENV_ENCODING_AES_KEY]?.trim() : "") ||
    undefined;
  const webhookPath =
    merged.webhookPath?.trim() ||
    (useEnv ? process.env[ENV_WEBHOOK_PATH]?.trim() : "") ||
    WECHAT_DEFAULT_WEBHOOK_PATH;

  const dmPolicy =
    merged.dmPolicy ||
    (useEnv ? parseDmPolicy(process.env[ENV_DM_POLICY]) : undefined) ||
    "pairing";

  const explicitAllowFrom = parseAllowFrom(merged.allowFrom);
  const envAllowFrom = useEnv ? parseAllowFrom(process.env[ENV_ALLOW_FROM]) : [];
  const allowFrom = explicitAllowFrom.length > 0 ? explicitAllowFrom : envAllowFrom;

  const textChunkLimit = clampTextChunkLimit(
    parseTextChunkLimit(merged.textChunkLimit) ||
      (useEnv ? parseTextChunkLimit(process.env[ENV_TEXT_CHUNK_LIMIT]) : undefined),
  );

  const enabled = merged.enabled !== false;

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    appId,
    appSecret,
    token,
    encodingAesKey,
    webhookPath,
    dmPolicy,
    allowFrom,
    textChunkLimit,
    deepseekBridge: {
      enabled: mergedDeepseekBridge.enabled === true,
      commandPrefix: mergedDeepseekBridge.commandPrefix ?? DEFAULT_DEEPSEEK_COMMAND_PREFIX,
      browserProfile: mergedDeepseekBridge.browserProfile ?? DEFAULT_DEEPSEEK_PROFILE,
      openUrl: mergedDeepseekBridge.openUrl ?? DEFAULT_DEEPSEEK_OPEN_URL,
      pollIntervalMs: clampRange(
        mergedDeepseekBridge.pollIntervalMs,
        DEFAULT_DEEPSEEK_POLL_INTERVAL_MS,
        5_000,
        10_000,
      ),
      maxWaitMs: clampRange(
        mergedDeepseekBridge.maxWaitMs,
        DEFAULT_DEEPSEEK_MAX_WAIT_MS,
        10_000,
        900_000,
      ),
      thinkingReply: mergedDeepseekBridge.thinkingReply ?? DEFAULT_DEEPSEEK_THINKING_REPLY,
    },
    chatgptBridge: {
      enabled: mergedChatgptBridge.enabled === true,
      commandPrefix: mergedChatgptBridge.commandPrefix ?? DEFAULT_CHATGPT_COMMAND_PREFIX,
      browserProfile: mergedChatgptBridge.browserProfile ?? DEFAULT_CHATGPT_PROFILE,
      openUrl: mergedChatgptBridge.openUrl ?? DEFAULT_CHATGPT_OPEN_URL,
      pollIntervalMs: clampRange(
        mergedChatgptBridge.pollIntervalMs,
        DEFAULT_CHATGPT_POLL_INTERVAL_MS,
        5_000,
        10_000,
      ),
      maxWaitMs: clampRange(
        mergedChatgptBridge.maxWaitMs,
        DEFAULT_CHATGPT_MAX_WAIT_MS,
        10_000,
        900_000,
      ),
      thinkingReply: mergedChatgptBridge.thinkingReply ?? DEFAULT_CHATGPT_THINKING_REPLY,
    },
  };
}

export { listWechatOfficialAccountIds, resolveDefaultWechatOfficialAccountId };
