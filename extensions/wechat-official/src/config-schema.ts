import { buildChannelConfigSchema } from "openclaw/plugin-sdk/compat";
import { z } from "zod";

const DmPolicySchema = z.enum(["pairing", "allowlist", "open", "disabled"]);
const WechatDeepseekBridgeSchema = z
  .object({
    enabled: z.boolean().optional(),
    commandPrefix: z.string().optional(),
    browserProfile: z.string().optional(),
    openUrl: z.string().optional(),
    pollIntervalMs: z.number().int().min(5000).max(10000).optional(),
    maxWaitMs: z.number().int().min(10_000).max(900_000).optional(),
    thinkingReply: z.string().optional(),
  })
  .passthrough();

const WechatOfficialAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    appId: z.string().optional(),
    appSecret: z.string().optional(),
    token: z.string().optional(),
    encodingAesKey: z.string().optional(),
    webhookPath: z.string().optional(),
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: z.array(z.string()).optional(),
    textChunkLimit: z.number().int().min(100).max(2000).optional(),
    deepseekBridge: WechatDeepseekBridgeSchema.optional(),
  })
  .passthrough();

export const WechatOfficialConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    appId: z.string().optional(),
    appSecret: z.string().optional(),
    token: z.string().optional(),
    encodingAesKey: z.string().optional(),
    webhookPath: z.string().optional(),
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: z.array(z.string()).optional(),
    textChunkLimit: z.number().int().min(100).max(2000).optional(),
    deepseekBridge: WechatDeepseekBridgeSchema.optional(),
    defaultAccount: z.string().optional(),
    accounts: z.record(z.string(), WechatOfficialAccountSchema).optional(),
  })
  .passthrough();

export const WechatOfficialChannelConfigSchema = buildChannelConfigSchema(
  WechatOfficialConfigSchema,
);
