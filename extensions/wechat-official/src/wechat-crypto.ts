import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

function sha1(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex");
}

function normalizeSignatureParts(parts: string[]): string[] {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .toSorted((a, b) => a.localeCompare(b));
}

export function computeWechatSignature(parts: string[]): string {
  return sha1(normalizeSignatureParts(parts).join(""));
}

export function verifyWechatSignature(params: {
  token: string;
  timestamp: string;
  nonce: string;
  signature: string;
}): boolean {
  const expected = computeWechatSignature([params.token, params.timestamp, params.nonce]);
  const actual = params.signature.trim().toLowerCase();
  if (!actual || expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export function verifyWechatAesSignature(params: {
  token: string;
  timestamp: string;
  nonce: string;
  encryptedMessage: string;
  signature: string;
}): boolean {
  const expected = computeWechatSignature([
    params.token,
    params.timestamp,
    params.nonce,
    params.encryptedMessage,
  ]);
  const actual = params.signature.trim().toLowerCase();
  if (!actual || expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function decodeEncodingAesKey(encodingAesKey: string): Buffer {
  const trimmed = encodingAesKey.trim();
  if (trimmed.length !== 43) {
    throw new Error("encodingAesKey must be 43 characters");
  }
  const key = Buffer.from(`${trimmed}=`, "base64");
  if (key.length !== 32) {
    throw new Error("encodingAesKey decoded length is invalid");
  }
  return key;
}

function pkcs7Unpad(input: Buffer): Buffer {
  if (input.length === 0) {
    throw new Error("Invalid encrypted payload");
  }
  const pad = input[input.length - 1] ?? 0;
  if (pad < 1 || pad > 32) {
    throw new Error("Invalid PKCS7 padding");
  }
  const contentLength = input.length - pad;
  if (contentLength < 0) {
    throw new Error("Invalid PKCS7 padding length");
  }
  return input.subarray(0, contentLength);
}

export function decryptWechatMessage(params: {
  encodingAesKey: string;
  encryptedMessage: string;
  expectedAppId: string;
}): string {
  const key = decodeEncodingAesKey(params.encodingAesKey);
  const encrypted = Buffer.from(params.encryptedMessage, "base64");
  const iv = key.subarray(0, 16);

  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const content = pkcs7Unpad(decrypted);

  if (content.length < 20) {
    throw new Error("Decrypted payload is too short");
  }

  const payload = content.subarray(16);
  const xmlLength = payload.readUInt32BE(0);
  const xmlStart = 4;
  const xmlEnd = xmlStart + xmlLength;
  if (xmlEnd > payload.length) {
    throw new Error("Invalid decrypted XML length");
  }

  const xml = payload.subarray(xmlStart, xmlEnd).toString("utf8");
  const appId = payload.subarray(xmlEnd).toString("utf8");

  if (params.expectedAppId && appId !== params.expectedAppId) {
    throw new Error("AppId mismatch while decrypting WeChat message");
  }

  return xml;
}
