import type { IncomingMessage, ServerResponse } from "node:http";
import {
  applyBasicWebhookRequestGuards,
  createDedupeCache,
  createFixedWindowRateLimiter,
  createScopedPairingAccess,
  issuePairingChallenge,
  readWebhookBodyOrReject,
  resolveDmGroupAccessWithLists,
  resolveInboundRouteEnvelopeBuilderWithRuntime,
  type OpenClawConfig,
  type PluginRuntime,
} from "openclaw/plugin-sdk/compat";
import { resolveWechatOfficialAccount } from "./accounts.js";
import {
  maybeHandleWechatChatgptBridgeInbound,
  maybeHandleWechatDeepseekBridgeInbound,
} from "./deepseek-bridge.js";
import {
  WECHAT_OFFICIAL_CHANNEL_ID,
  type ResolvedWechatOfficialAccount,
  type WechatInboundMessage,
} from "./types.js";
import { sendWechatCustomText } from "./wechat-api.js";
import {
  decryptWechatMessage,
  verifyWechatAesSignature,
  verifyWechatSignature,
} from "./wechat-crypto.js";
import { parseWechatEncryptedEnvelope, parseWechatInboundMessage } from "./wechat-xml.js";

const webhookRateLimiter = createFixedWindowRateLimiter({
  windowMs: 60_000,
  maxRequests: 120,
  maxTrackedKeys: 4096,
});

const inboundDedupe = createDedupeCache({
  ttlMs: 10 * 60_000,
  maxSize: 20_000,
});

function respondText(res: ServerResponse, statusCode: number, text: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

function readQuery(req: IncomingMessage): URLSearchParams {
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    return url.searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function normalizeAllowFromEntry(value: string): string {
  return value.trim().replace(/^(wechat-official|wechat|wx):/i, "");
}

function isSenderAllowed(senderId: string, allowFrom: readonly string[]): boolean {
  const normalized = allowFrom.map((entry) => normalizeAllowFromEntry(entry));
  return normalized.includes("*") || normalized.includes(senderId);
}

function buildDedupeKey(message: WechatInboundMessage): string {
  if (message.msgId?.trim()) {
    return `msg:${message.msgId.trim()}`;
  }
  return `evt:${message.fromUserName}:${String(message.createTime ?? 0)}:${message.msgType}:${message.event ?? ""}:${message.eventKey ?? ""}`;
}

function buildInboundBody(message: WechatInboundMessage): string {
  switch (message.msgType) {
    case "text":
      return message.content?.trim() ?? "";
    case "image":
      return message.mediaId ? `[image] media_id=${message.mediaId}` : "[image]";
    case "voice":
      return message.mediaId ? `[voice] media_id=${message.mediaId}` : "[voice]";
    case "video":
      return message.mediaId ? `[video] media_id=${message.mediaId}` : "[video]";
    case "event": {
      const event = message.event?.toLowerCase();
      if (event === "unsubscribe") {
        return "";
      }
      if (event === "subscribe") {
        return "/start";
      }
      const suffix = message.eventKey ? ` ${message.eventKey}` : "";
      return `[event:${event ?? "unknown"}]${suffix}`;
    }
    default:
      return `[${message.msgType || "unknown"}]`;
  }
}

function shouldAcceptInbound(message: WechatInboundMessage): boolean {
  if (!message.fromUserName || !message.toUserName || !message.msgType) {
    return false;
  }
  return true;
}

async function deliverWechatReply(params: {
  payload: { text?: string; body?: string };
  runtime: PluginRuntime;
  cfg: OpenClawConfig;
  account: ResolvedWechatOfficialAccount;
  toUser: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, runtime, cfg, account, toUser, statusSink } = params;
  const text = (payload.text ?? payload.body ?? "").trim();
  if (!text) {
    return;
  }

  const tableMode = runtime.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: WECHAT_OFFICIAL_CHANNEL_ID,
    accountId: account.accountId,
  });
  const convertedText = runtime.channel.text.convertMarkdownTables(text, tableMode);
  const chunkMode = runtime.channel.text.resolveChunkMode(
    cfg,
    WECHAT_OFFICIAL_CHANNEL_ID,
    account.accountId,
  );
  const textLimit = runtime.channel.text.resolveTextChunkLimit(
    cfg,
    WECHAT_OFFICIAL_CHANNEL_ID,
    account.accountId,
    {
      fallbackLimit: account.textChunkLimit,
    },
  );

  const chunks = runtime.channel.text.chunkTextWithMode(convertedText, textLimit, chunkMode);
  for (const chunk of chunks) {
    await sendWechatCustomText({
      account,
      toUser,
      text: chunk,
    });
    statusSink?.({ lastOutboundAt: Date.now() });
  }
}

async function processInboundMessage(params: {
  message: WechatInboundMessage;
  runtime: PluginRuntime;
  accountId: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): Promise<void> {
  const { message, runtime, accountId, statusSink, log } = params;
  const rawBody = buildInboundBody(message);
  if (!rawBody) {
    return;
  }

  const cfg = await runtime.config.loadConfig();
  const account = resolveWechatOfficialAccount({ cfg, accountId });
  if (!account.enabled) {
    return;
  }

  const senderId = message.fromUserName;
  const pairing = createScopedPairingAccess({
    core: runtime,
    channel: WECHAT_OFFICIAL_CHANNEL_ID,
    accountId: account.accountId,
  });

  const shouldComputeAuth = runtime.channel.commands.shouldComputeCommandAuthorized(rawBody, cfg);
  const storeAllowFrom =
    account.dmPolicy !== "allowlist" && (account.dmPolicy !== "open" || shouldComputeAuth)
      ? await pairing.readAllowFromStore().catch(() => [])
      : [];

  const access = resolveDmGroupAccessWithLists({
    isGroup: false,
    dmPolicy: account.dmPolicy,
    groupPolicy: "allowlist",
    allowFrom: account.allowFrom,
    groupAllowFrom: [],
    storeAllowFrom,
    groupAllowFromFallbackToAllowFrom: false,
    isSenderAllowed: (allowFrom) => isSenderAllowed(senderId, allowFrom),
  });

  if (access.decision !== "allow") {
    if (access.decision === "pairing") {
      await issuePairingChallenge({
        channel: WECHAT_OFFICIAL_CHANNEL_ID,
        senderId,
        senderIdLine: `Your WeChat OpenID: ${senderId}`,
        upsertPairingRequest: pairing.upsertPairingRequest,
        sendPairingReply: async (text) => {
          await sendWechatCustomText({
            account,
            toUser: senderId,
            text,
          });
          statusSink?.({ lastOutboundAt: Date.now() });
        },
        onReplyError: (error) => {
          log?.warn?.(`wechat-official pairing reply failed: ${String(error)}`);
        },
      });
    }
    return;
  }

  const senderAllowedForCommands = isSenderAllowed(senderId, access.effectiveAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: cfg.commands?.useAccessGroups !== false,
        authorizers: [
          {
            configured: access.effectiveAllowFrom.length > 0,
            allowed: senderAllowedForCommands,
          },
        ],
      })
    : undefined;

  if (
    runtime.channel.commands.isControlCommandMessage(rawBody, cfg) &&
    commandAuthorized !== true
  ) {
    return;
  }

  const chatgptHandled = await maybeHandleWechatChatgptBridgeInbound({
    message,
    rawBody,
    senderId,
    account,
    cfg,
    runtime,
    deliverReply: async (text) => {
      await deliverWechatReply({
        payload: { text },
        runtime,
        cfg,
        account,
        toUser: senderId,
        statusSink,
      });
    },
    log,
  });

  if (chatgptHandled.handled) {
    return;
  }

  const deepseekHandled = await maybeHandleWechatDeepseekBridgeInbound({
    message,
    rawBody,
    senderId,
    account,
    cfg,
    runtime,
    deliverReply: async (text) => {
      await deliverWechatReply({
        payload: { text },
        runtime,
        cfg,
        account,
        toUser: senderId,
        statusSink,
      });
    },
    log,
  });

  if (deepseekHandled.handled) {
    return;
  }

  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg,
    channel: WECHAT_OFFICIAL_CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: senderId,
    },
    runtime: runtime.channel,
    sessionStore: cfg.session?.store,
  });

  const createdAt = message.createTime ? message.createTime * 1000 : undefined;
  const { storePath, body } = buildEnvelope({
    channel: "WeChat Official",
    from: senderId,
    timestamp: createdAt,
    body: rawBody,
  });

  const messageSid = message.msgId ?? `${senderId}:${String(message.createTime ?? Date.now())}`;
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `${WECHAT_OFFICIAL_CHANNEL_ID}:${senderId}`,
    To: `${WECHAT_OFFICIAL_CHANNEL_ID}:${message.toUserName}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: senderId,
    SenderId: senderId,
    Provider: WECHAT_OFFICIAL_CHANNEL_ID,
    Surface: WECHAT_OFFICIAL_CHANNEL_ID,
    MessageSid: messageSid,
    MessageSidFull: messageSid,
    Timestamp: createdAt,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: WECHAT_OFFICIAL_CHANNEL_ID,
    OriginatingTo: `${WECHAT_OFFICIAL_CHANNEL_ID}:${senderId}`,
  });

  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (error) => {
      log?.warn?.(`wechat-official failed to record inbound session: ${String(error)}`);
    },
  });

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverWechatReply({
          payload,
          runtime,
          cfg,
          account,
          toUser: senderId,
          statusSink,
        });
      },
      onError: (error, info) => {
        log?.error?.(`wechat-official ${info.kind} reply failed: ${String(error)}`);
      },
    },
  });
}

function verifyGetRequest(params: {
  account: ResolvedWechatOfficialAccount;
  query: URLSearchParams;
}): { ok: true; echostr: string } | { ok: false } {
  const signature = params.query.get("signature")?.trim() ?? "";
  const timestamp = params.query.get("timestamp")?.trim() ?? "";
  const nonce = params.query.get("nonce")?.trim() ?? "";
  const echostr = params.query.get("echostr") ?? "";

  if (!signature || !timestamp || !nonce || !echostr) {
    return { ok: false };
  }

  const ok = verifyWechatSignature({
    token: params.account.token,
    timestamp,
    nonce,
    signature,
  });

  if (!ok) {
    return { ok: false };
  }

  return { ok: true, echostr };
}

function decodePostMessage(params: {
  account: ResolvedWechatOfficialAccount;
  query: URLSearchParams;
  rawBody: string;
}): WechatInboundMessage {
  const encryptType = params.query.get("encrypt_type")?.trim().toLowerCase();
  const timestamp = params.query.get("timestamp")?.trim() ?? "";
  const nonce = params.query.get("nonce")?.trim() ?? "";

  if (encryptType === "aes") {
    const encryptedEnvelope = parseWechatEncryptedEnvelope(params.rawBody);
    const encrypted = encryptedEnvelope.encrypt?.trim();
    const msgSignature = params.query.get("msg_signature")?.trim() ?? "";

    if (!encrypted || !msgSignature || !timestamp || !nonce) {
      throw new Error("Missing required AES webhook parameters");
    }

    const signatureOk = verifyWechatAesSignature({
      token: params.account.token,
      timestamp,
      nonce,
      encryptedMessage: encrypted,
      signature: msgSignature,
    });
    if (!signatureOk) {
      throw new Error("Invalid AES signature");
    }

    if (!params.account.encodingAesKey) {
      throw new Error("encodingAesKey is required for AES mode");
    }

    const plaintextXml = decryptWechatMessage({
      encodingAesKey: params.account.encodingAesKey,
      encryptedMessage: encrypted,
      expectedAppId: params.account.appId,
    });

    return parseWechatInboundMessage(plaintextXml);
  }

  const signature = params.query.get("signature")?.trim() ?? "";
  if (!signature || !timestamp || !nonce) {
    throw new Error("Missing required signature parameters");
  }

  const ok = verifyWechatSignature({
    token: params.account.token,
    timestamp,
    nonce,
    signature,
  });

  if (!ok) {
    throw new Error("Invalid signature");
  }

  return parseWechatInboundMessage(params.rawBody);
}

export function createWechatOfficialWebhookHandler(params: {
  runtime: PluginRuntime;
  account: ResolvedWechatOfficialAccount;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}) {
  const { runtime, account: bootAccount, statusSink, log } = params;

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET") {
      const query = readQuery(req);
      const verification = verifyGetRequest({
        account: bootAccount,
        query,
      });
      if (!verification.ok) {
        respondText(res, 401, "invalid signature");
        return;
      }
      respondText(res, 200, verification.echostr);
      return;
    }

    if (
      !applyBasicWebhookRequestGuards({
        req,
        res,
        allowMethods: ["POST"],
        rateLimiter: webhookRateLimiter,
        rateLimitKey: `${bootAccount.accountId}:${req.socket.remoteAddress ?? "unknown"}`,
      })
    ) {
      return;
    }

    const body = await readWebhookBodyOrReject({
      req,
      res,
      profile: "post-auth",
      maxBytes: 1024 * 1024,
      timeoutMs: 30_000,
      invalidBodyMessage: "Bad Request",
    });
    if (!body.ok) {
      return;
    }

    const query = readQuery(req);

    let inbound: WechatInboundMessage;
    try {
      inbound = decodePostMessage({
        account: bootAccount,
        query,
        rawBody: body.value,
      });
    } catch (error) {
      log?.warn?.(`wechat-official rejected webhook: ${String(error)}`);
      respondText(res, 401, "invalid request");
      return;
    }

    if (!shouldAcceptInbound(inbound)) {
      respondText(res, 400, "bad message");
      return;
    }

    const dedupeKey = buildDedupeKey(inbound);
    if (inboundDedupe.check(dedupeKey)) {
      respondText(res, 200, "success");
      return;
    }

    statusSink?.({ lastInboundAt: Date.now() });
    respondText(res, 200, "success");

    void processInboundMessage({
      message: inbound,
      runtime,
      accountId: bootAccount.accountId,
      statusSink,
      log,
    }).catch((error) => {
      log?.error?.(`wechat-official inbound processing failed: ${String(error)}`);
    });
  };
}
