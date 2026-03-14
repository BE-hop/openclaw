import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/compat";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/compat";
import { resolveWechatOfficialAccount } from "./src/accounts.js";
import { wechatOfficialPlugin } from "./src/channel.js";
import {
  maybeHandleWechatChatgptBridgeInbound,
  maybeHandleWechatDeepseekBridgeInbound,
} from "./src/deepseek-bridge.js";
import { setWechatOfficialRuntime } from "./src/runtime.js";
import type { WechatInboundMessage } from "./src/types.js";

function resolveCommandSenderId(ctx: PluginCommandContext): string {
  const sender = ctx.senderId?.trim();
  if (sender) {
    return sender;
  }
  const from = ctx.from?.trim();
  if (from) {
    return from;
  }
  const to = ctx.to?.trim();
  if (to) {
    return to;
  }
  const channel = (ctx.channelId ?? ctx.channel ?? "unknown").trim() || "unknown";
  return `${channel}:unknown`;
}

async function runWebBridgeCommand(params: {
  api: OpenClawPluginApi;
  ctx: PluginCommandContext;
  rawBody: string;
  bridgeKind: "deepseek" | "chatgpt";
}): Promise<string> {
  const account = resolveWechatOfficialAccount({
    cfg: params.ctx.config,
    accountId: params.ctx.accountId,
  });
  const senderId = resolveCommandSenderId(params.ctx);
  const message: WechatInboundMessage = {
    msgType: "text",
    fromUserName: senderId,
    toUserName: "openclaw",
  };
  let replyText = "";

  const handled =
    params.bridgeKind === "chatgpt"
      ? await maybeHandleWechatChatgptBridgeInbound({
          message,
          rawBody: params.rawBody,
          senderId,
          account,
          cfg: params.ctx.config,
          runtime: params.api.runtime,
          deliverReply: async (text) => {
            replyText = text;
          },
          log: params.api.logger,
        })
      : await maybeHandleWechatDeepseekBridgeInbound({
          message,
          rawBody: params.rawBody,
          senderId,
          account,
          cfg: params.ctx.config,
          runtime: params.api.runtime,
          deliverReply: async (text) => {
            replyText = text;
          },
          log: params.api.logger,
        });

  if (!handled.handled) {
    if (params.bridgeKind === "chatgpt") {
      return "ChatGPT bridge 未启用。请先设置 channels.wechat-official.chatgptBridge.enabled=true。";
    }
    return "DeepSeek bridge 未启用。请先设置 channels.wechat-official.deepseekBridge.enabled=true。";
  }
  return (
    replyText ||
    (params.bridgeKind === "chatgpt" ? "ChatGPT 任务已接收。" : "DeepSeek 任务已接收。")
  );
}

const plugin = {
  id: "wechat-official",
  name: "WeChat Official",
  description: "WeChat Official Account (公众号) channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setWechatOfficialRuntime(api.runtime);
    api.registerChannel({ plugin: wechatOfficialPlugin });
    api.registerCommand({
      name: "ds",
      description: "Queue a DeepSeek web task (send ds + question, then dsback).",
      acceptsArgs: true,
      requireAuth: false,
      textAliases: ["ds", "deepseek"],
      textAliasMatch: "contains",
      handler: async (ctx) => {
        const prompt = ctx.args?.trim() ?? "";
        const rawBody = prompt ? `ds ${prompt}` : "ds";
        return {
          text: await runWebBridgeCommand({
            api,
            ctx,
            rawBody,
            bridgeKind: "deepseek",
          }),
        };
      },
    });
    api.registerCommand({
      name: "dsback",
      description: "Fetch latest DeepSeek bridge result.",
      acceptsArgs: true,
      requireAuth: false,
      textAliases: ["dsback"],
      handler: async (ctx) => {
        const taskId = ctx.args?.trim();
        const rawBody = taskId ? `dsback ${taskId}` : "dsback";
        return {
          text: await runWebBridgeCommand({
            api,
            ctx,
            rawBody,
            bridgeKind: "deepseek",
          }),
        };
      },
    });
    api.registerCommand({
      name: "gpt",
      description: "Queue a ChatGPT web task (send gpt + question, then gptback).",
      acceptsArgs: true,
      requireAuth: false,
      textAliases: ["gpt", "chatgpt"],
      textAliasMatch: "contains",
      handler: async (ctx) => {
        const prompt = ctx.args?.trim() ?? "";
        const rawBody = prompt ? `gpt ${prompt}` : "gpt";
        return {
          text: await runWebBridgeCommand({
            api,
            ctx,
            rawBody,
            bridgeKind: "chatgpt",
          }),
        };
      },
    });
    api.registerCommand({
      name: "gptnew",
      description: "Queue a ChatGPT web task in a new conversation (gptnew + question).",
      acceptsArgs: true,
      requireAuth: false,
      textAliases: ["gptnew"],
      textAliasMatch: "contains",
      handler: async (ctx) => {
        const prompt = ctx.args?.trim() ?? "";
        const rawBody = prompt ? `gptnew ${prompt}` : "gptnew";
        return {
          text: await runWebBridgeCommand({
            api,
            ctx,
            rawBody,
            bridgeKind: "chatgpt",
          }),
        };
      },
    });
    api.registerCommand({
      name: "gptback",
      description: "Fetch latest ChatGPT bridge result.",
      acceptsArgs: true,
      requireAuth: false,
      textAliases: ["gptback"],
      handler: async (ctx) => {
        const taskId = ctx.args?.trim();
        const rawBody = taskId ? `gptback ${taskId}` : "gptback";
        return {
          text: await runWebBridgeCommand({
            api,
            ctx,
            rawBody,
            bridgeKind: "chatgpt",
          }),
        };
      },
    });
  },
};

export default plugin;
