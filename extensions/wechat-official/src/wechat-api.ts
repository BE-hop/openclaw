import type { ResolvedWechatOfficialAccount } from "./types.js";

const WECHAT_API_ORIGIN = "https://api.weixin.qq.com";
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60_000;

type AccessTokenCacheValue = {
  accessToken: string;
  expiresAt: number;
};

const accessTokenCache = new Map<string, AccessTokenCacheValue>();

type WechatApiError = {
  errcode?: number;
  errmsg?: string;
};

function getTokenCacheKey(account: ResolvedWechatOfficialAccount): string {
  return account.appId;
}

function isTokenStillValid(value: AccessTokenCacheValue | undefined): boolean {
  if (!value) {
    return false;
  }
  return Date.now() + ACCESS_TOKEN_REFRESH_BUFFER_MS < value.expiresAt;
}

function assertWechatApiSuccess(payload: unknown, context: string): void {
  const data = payload as WechatApiError;
  const errcode = typeof data?.errcode === "number" ? data.errcode : 0;
  if (errcode === 0) {
    return;
  }
  const errmsg = typeof data?.errmsg === "string" ? data.errmsg : "unknown error";
  throw new Error(`WeChat API ${context} failed: errcode=${String(errcode)} errmsg=${errmsg}`);
}

function shouldRefreshToken(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    err.message.includes("errcode=40001") ||
    err.message.includes("errcode=40014") ||
    err.message.includes("errcode=42001")
  );
}

async function fetchWechatJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const serialized = typeof payload === "object" ? JSON.stringify(payload) : String(payload);
    throw new Error(`WeChat HTTP ${String(response.status)}: ${serialized}`);
  }
  return payload;
}

export async function getWechatAccessToken(
  account: ResolvedWechatOfficialAccount,
  opts?: { forceRefresh?: boolean },
): Promise<string> {
  const cacheKey = getTokenCacheKey(account);
  if (!opts?.forceRefresh) {
    const cached = accessTokenCache.get(cacheKey);
    if (isTokenStillValid(cached)) {
      return cached.accessToken;
    }
  }

  const tokenUrl = `${WECHAT_API_ORIGIN}/cgi-bin/stable_token`;
  const payload = await fetchWechatJson(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "client_credential",
      appid: account.appId,
      secret: account.appSecret,
      force_refresh: Boolean(opts?.forceRefresh),
    }),
  });

  assertWechatApiSuccess(payload, "stable_token");

  const record = payload as { access_token?: string; expires_in?: number };
  const accessToken = record.access_token?.trim();
  if (!accessToken) {
    throw new Error("WeChat API stable_token returned empty access_token");
  }
  const expiresIn =
    typeof record.expires_in === "number" && Number.isFinite(record.expires_in)
      ? Math.max(60, Math.floor(record.expires_in))
      : 7200;

  accessTokenCache.set(cacheKey, {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
  });

  return accessToken;
}

async function sendWechatCustomTextWithToken(params: {
  accessToken: string;
  toUser: string;
  text: string;
}): Promise<void> {
  const url = `${WECHAT_API_ORIGIN}/cgi-bin/message/custom/send?access_token=${encodeURIComponent(
    params.accessToken,
  )}`;

  const payload = await fetchWechatJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      touser: params.toUser,
      msgtype: "text",
      text: {
        content: params.text,
      },
    }),
  });

  assertWechatApiSuccess(payload, "message/custom/send");
}

export async function sendWechatCustomText(params: {
  account: ResolvedWechatOfficialAccount;
  toUser: string;
  text: string;
}): Promise<void> {
  if (!params.text.trim()) {
    return;
  }

  const trySend = async (forceRefresh: boolean) => {
    const token = await getWechatAccessToken(params.account, { forceRefresh });
    await sendWechatCustomTextWithToken({
      accessToken: token,
      toUser: params.toUser,
      text: params.text,
    });
  };

  try {
    await trySend(false);
  } catch (error) {
    if (!shouldRefreshToken(error)) {
      throw error;
    }
    await trySend(true);
  }
}

export function clearWechatAccessTokenCacheForTest(): void {
  accessTokenCache.clear();
}
