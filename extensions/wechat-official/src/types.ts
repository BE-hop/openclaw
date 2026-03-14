export const WECHAT_OFFICIAL_CHANNEL_ID = "wechat-official";
export const WECHAT_DEFAULT_WEBHOOK_PATH = "/wechat/webhook";
export const WECHAT_DEFAULT_TEXT_CHUNK_LIMIT = 1200;

export type WechatDmPolicy = "pairing" | "allowlist" | "open" | "disabled";

export type WechatDeepseekBridgeConfig = {
  enabled?: boolean;
  commandPrefix?: string;
  browserProfile?: string;
  openUrl?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  thinkingReply?: string;
};

export type WechatChatgptBridgeConfig = {
  enabled?: boolean;
  commandPrefix?: string;
  browserProfile?: string;
  openUrl?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  thinkingReply?: string;
};

export type WechatOfficialAccountConfig = {
  name?: string;
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  token?: string;
  encodingAesKey?: string;
  webhookPath?: string;
  dmPolicy?: WechatDmPolicy;
  allowFrom?: string[];
  textChunkLimit?: number;
  deepseekBridge?: WechatDeepseekBridgeConfig;
  chatgptBridge?: WechatChatgptBridgeConfig;
};

export type WechatOfficialConfig = WechatOfficialAccountConfig & {
  accounts?: Record<string, WechatOfficialAccountConfig>;
  defaultAccount?: string;
};

export type ResolvedWechatOfficialAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  appId: string;
  appSecret: string;
  token: string;
  encodingAesKey?: string;
  webhookPath: string;
  dmPolicy: WechatDmPolicy;
  allowFrom: string[];
  textChunkLimit: number;
  deepseekBridge: {
    enabled: boolean;
    commandPrefix: string;
    browserProfile: string;
    openUrl: string;
    pollIntervalMs: number;
    maxWaitMs: number;
    thinkingReply: string;
  };
  chatgptBridge: {
    enabled: boolean;
    commandPrefix: string;
    browserProfile: string;
    openUrl: string;
    pollIntervalMs: number;
    maxWaitMs: number;
    thinkingReply: string;
  };
};

export type WechatInboundMessage = {
  toUserName: string;
  fromUserName: string;
  createTime?: number;
  msgType: string;
  msgId?: string;
  content?: string;
  event?: string;
  eventKey?: string;
  mediaId?: string;
  picUrl?: string;
};
