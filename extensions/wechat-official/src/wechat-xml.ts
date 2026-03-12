import { XMLParser } from "fast-xml-parser";
import type { WechatInboundMessage } from "./types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  cdataPropName: "__cdata",
});

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toStringValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized = toStringValue(entry);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }
  const record = asRecord(value);
  return (
    toStringValue(record["#text"]) ||
    toStringValue(record.__cdata) ||
    toStringValue(record.value) ||
    undefined
  );
}

function toNumberValue(value: unknown): number | undefined {
  const normalized = toStringValue(value);
  if (!normalized) {
    return undefined;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

export function parseWechatEnvelopeXml(rawXml: string): Record<string, unknown> {
  const parsed = parser.parse(rawXml);
  const root = asRecord(parsed).xml;
  return asRecord(root);
}

export function parseWechatEncryptedEnvelope(rawXml: string): {
  encrypt?: string;
  toUserName?: string;
} {
  const root = parseWechatEnvelopeXml(rawXml);
  return {
    encrypt: toStringValue(root.Encrypt),
    toUserName: toStringValue(root.ToUserName),
  };
}

export function parseWechatInboundMessage(rawXml: string): WechatInboundMessage {
  const root = parseWechatEnvelopeXml(rawXml);

  return {
    toUserName: toStringValue(root.ToUserName) ?? "",
    fromUserName: toStringValue(root.FromUserName) ?? "",
    createTime: toNumberValue(root.CreateTime),
    msgType: (toStringValue(root.MsgType) ?? "").toLowerCase(),
    msgId: toStringValue(root.MsgId),
    content: toStringValue(root.Content),
    event: toStringValue(root.Event)?.toLowerCase(),
    eventKey: toStringValue(root.EventKey),
    mediaId: toStringValue(root.MediaId),
    picUrl: toStringValue(root.PicUrl),
  };
}
