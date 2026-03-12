import {
  buildAccountScopedDmSecurityPolicy,
  buildChannelSendResult,
  listDirectoryUserEntriesFromAllowFrom,
  normalizeAccountId,
  registerPluginHttpRoute,
  waitUntilAbort,
  type ChannelAccountSnapshot,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/compat";
import {
  listWechatOfficialAccountIds,
  resolveDefaultWechatOfficialAccountId,
  resolveWechatOfficialAccount,
} from "./accounts.js";
import { WechatOfficialChannelConfigSchema } from "./config-schema.js";
import { getWechatOfficialRuntime } from "./runtime.js";
import { WECHAT_OFFICIAL_CHANNEL_ID, type ResolvedWechatOfficialAccount } from "./types.js";
import { createWechatOfficialWebhookHandler } from "./webhook.js";
import { sendWechatCustomText } from "./wechat-api.js";

const activeRouteUnregisters = new Map<string, () => void>();

function normalizeWechatTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^(wechat-official|wechat|wx):/i, "");
}

function looksLikeWechatOpenId(value: string): boolean {
  const normalized = normalizeWechatTarget(value);
  if (!normalized) {
    return false;
  }
  return /^[A-Za-z0-9_-]{20,128}$/.test(normalized);
}

async function sendWechatText(params: {
  to: string;
  text: string;
  cfg: Parameters<typeof resolveWechatOfficialAccount>[0]["cfg"];
  accountId?: string | null;
}) {
  const toUser = normalizeWechatTarget(params.to);
  if (!toUser) {
    throw new Error("Invalid WeChat target");
  }
  const account = resolveWechatOfficialAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!account.appId || !account.appSecret || !account.token) {
    throw new Error("WeChat Official channel is not configured");
  }

  await sendWechatCustomText({
    account,
    toUser,
    text: params.text,
  });

  return {
    messageId: `wechat-${Date.now().toString(36)}`,
    chatId: toUser,
  };
}

export const wechatOfficialPlugin: ChannelPlugin<ResolvedWechatOfficialAccount> = {
  id: WECHAT_OFFICIAL_CHANNEL_ID,
  meta: {
    id: WECHAT_OFFICIAL_CHANNEL_ID,
    label: "WeChat Official",
    selectionLabel: "WeChat Official (公众号)",
    detailLabel: "WeChat Official",
    docsPath: "/plugins/community",
    docsLabel: "community plugins",
    blurb: "WeChat Official Account webhook + custom service messages.",
    aliases: ["wechat-oa", "wcoa"],
    order: 82,
    quickstartAllowFrom: true,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    threads: false,
    reactions: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.wechat-official"] },
  configSchema: WechatOfficialChannelConfigSchema,
  config: {
    listAccountIds: (cfg) => listWechatOfficialAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveWechatOfficialAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultWechatOfficialAccountId(cfg),
    isConfigured: (account) => Boolean(account.appId && account.appSecret && account.token),
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.appId && account.appSecret && account.token),
      webhookPath: account.webhookPath,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveWechatOfficialAccount({ cfg, accountId }).allowFrom,
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) =>
          String(entry)
            .trim()
            .replace(/^(wechat-official|wechat|wx):/i, ""),
        )
        .filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) =>
      buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: WECHAT_OFFICIAL_CHANNEL_ID,
        accountId,
        fallbackAccountId: account.accountId,
        policy: account.dmPolicy,
        allowFrom: account.allowFrom,
        policyPathSuffix: "dmPolicy",
        normalizeEntry: (entry) => entry.replace(/^(wechat-official|wechat|wx):/i, ""),
      }),
  },
  pairing: {
    idLabel: "wechatOpenId",
    normalizeAllowEntry: (entry) => entry.replace(/^(wechat-official|wechat|wx):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveWechatOfficialAccount({ cfg });
      if (!account.appId || !account.appSecret || !account.token) {
        throw new Error("WeChat Official channel is not configured");
      }
      await sendWechatCustomText({
        account,
        toUser: id,
        text: "OpenClaw: your pairing request has been approved.",
      });
    },
  },
  messaging: {
    normalizeTarget: normalizeWechatTarget,
    targetResolver: {
      looksLikeId: looksLikeWechatOpenId,
      hint: "<openid>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveWechatOfficialAccount({ cfg, accountId });
      return listDirectoryUserEntriesFromAllowFrom({
        allowFrom: account.allowFrom,
        query,
        limit,
        normalizeId: (entry) => entry.replace(/^(wechat-official|wechat|wx):/i, ""),
      });
    },
    listGroups: async () => [],
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 1200,
    sendText: async ({ to, text, cfg, accountId }) => {
      const result = await sendWechatText({ to, text, cfg, accountId });
      return buildChannelSendResult(WECHAT_OFFICIAL_CHANNEL_ID, result);
    },
    sendMedia: async ({ to, text, cfg, accountId }) => {
      const result = await sendWechatText({ to, text, cfg, accountId });
      return buildChannelSendResult(WECHAT_OFFICIAL_CHANNEL_ID, result);
    },
  },
  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      connected: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.appId && account.appSecret && account.token),
      running: runtime?.running,
      connected: runtime?.running,
      webhookPath: account.webhookPath,
      dmPolicy: account.dmPolicy,
      allowFrom: account.allowFrom,
    }),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const resolvedAccountId = normalizeAccountId(accountId);
      const channel =
        (cfg.channels?.[WECHAT_OFFICIAL_CHANNEL_ID] as Record<string, unknown> | undefined) ?? {};

      const patch: Record<string, unknown> = {};
      if (input.name) {
        patch.name = input.name;
      }
      if (input.token) {
        patch.token = input.token;
      }
      if (input.webhookPath) {
        patch.webhookPath = input.webhookPath;
      }

      const nextChannel = { ...channel };
      const accounts =
        (nextChannel.accounts as Record<string, Record<string, unknown>> | undefined) ?? {};
      accounts[resolvedAccountId] = {
        ...(accounts[resolvedAccountId] ?? {}),
        ...patch,
      };
      nextChannel.accounts = accounts;

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [WECHAT_OFFICIAL_CHANNEL_ID]: nextChannel,
        },
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const runtime = getWechatOfficialRuntime();
      const account = ctx.account;

      if (!account.enabled) {
        ctx.log?.info?.(`[${account.accountId}] WeChat Official account disabled`);
        return waitUntilAbort(ctx.abortSignal);
      }

      if (!account.appId || !account.appSecret || !account.token) {
        ctx.log?.warn?.(
          `[${account.accountId}] WeChat Official missing appId/appSecret/token; route not started`,
        );
        return waitUntilAbort(ctx.abortSignal);
      }

      const routeKey = `${account.accountId}:${account.webhookPath}`;
      const previous = activeRouteUnregisters.get(routeKey);
      if (previous) {
        previous();
        activeRouteUnregisters.delete(routeKey);
      }

      const handler = createWechatOfficialWebhookHandler({
        runtime,
        account,
        statusSink: (patch) => {
          ctx.setStatus({
            accountId: account.accountId,
            ...patch,
          });
        },
        log: {
          info: (message) => ctx.log?.info?.(message),
          warn: (message) => ctx.log?.warn?.(message),
          error: (message) => ctx.log?.error?.(message),
        },
      });

      const unregister = registerPluginHttpRoute({
        path: account.webhookPath,
        auth: "plugin",
        replaceExisting: true,
        pluginId: WECHAT_OFFICIAL_CHANNEL_ID,
        accountId: account.accountId,
        log: (message: string) => ctx.log?.info?.(message),
        handler,
      });
      activeRouteUnregisters.set(routeKey, unregister);

      ctx.log?.info?.(
        `[${account.accountId}] WeChat Official webhook registered at ${account.webhookPath}`,
      );

      return waitUntilAbort(ctx.abortSignal, () => {
        ctx.log?.info?.(`[${account.accountId}] stopping WeChat Official webhook`);
        unregister();
        activeRouteUnregisters.delete(routeKey);
      });
    },
  },
};
