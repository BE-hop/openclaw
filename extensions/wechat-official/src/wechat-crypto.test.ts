import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeWechatSignature,
  decryptWechatMessage,
  verifyWechatAesSignature,
  verifyWechatSignature,
} from "./wechat-crypto.js";

function toEncodingAesKey(rawKey: Buffer): string {
  return rawKey.toString("base64").replace(/=/g, "");
}

function pkcs7Pad(input: Buffer, blockSize = 32): Buffer {
  const remainder = input.length % blockSize;
  const pad = remainder === 0 ? blockSize : blockSize - remainder;
  return Buffer.concat([input, Buffer.alloc(pad, pad)]);
}

function encryptWechatMessage(params: {
  encodingAesKey: string;
  appId: string;
  xml: string;
}): string {
  const aesKey = Buffer.from(`${params.encodingAesKey}=`, "base64");
  const iv = aesKey.subarray(0, 16);
  const randomPrefix = randomBytes(16);
  const xmlBuffer = Buffer.from(params.xml, "utf8");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(xmlBuffer.length, 0);
  const appIdBuffer = Buffer.from(params.appId, "utf8");

  const payload = pkcs7Pad(Buffer.concat([randomPrefix, lengthBuffer, xmlBuffer, appIdBuffer]));
  const cipher = createCipheriv("aes-256-cbc", aesKey, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return encrypted.toString("base64");
}

describe("wechat-crypto", () => {
  it("verifies plain signatures", () => {
    const token = "abc123";
    const timestamp = "1700000000";
    const nonce = "nonce123";
    const signature = computeWechatSignature([token, timestamp, nonce]);

    expect(
      verifyWechatSignature({
        token,
        timestamp,
        nonce,
        signature,
      }),
    ).toBe(true);

    expect(
      verifyWechatSignature({
        token,
        timestamp,
        nonce,
        signature: "invalid",
      }),
    ).toBe(false);
  });

  it("verifies aes signatures", () => {
    const token = "abc123";
    const timestamp = "1700000000";
    const nonce = "nonce123";
    const encryptedMessage = "ENCRYPTED";
    const signature = computeWechatSignature([token, timestamp, nonce, encryptedMessage]);

    expect(
      verifyWechatAesSignature({
        token,
        timestamp,
        nonce,
        encryptedMessage,
        signature,
      }),
    ).toBe(true);
  });

  it("decrypts aes payload and validates appid", () => {
    const rawKey = Buffer.from("12345678901234567890123456789012", "utf8");
    const encodingAesKey = toEncodingAesKey(rawKey);
    const appId = "wx1234567890";
    const xml =
      "<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello]]></Content></xml>";
    const encryptedMessage = encryptWechatMessage({
      encodingAesKey,
      appId,
      xml,
    });

    expect(
      decryptWechatMessage({
        encodingAesKey,
        encryptedMessage,
        expectedAppId: appId,
      }),
    ).toBe(xml);

    expect(() =>
      decryptWechatMessage({
        encodingAesKey,
        encryptedMessage,
        expectedAppId: "wx-other",
      }),
    ).toThrow(/AppId mismatch/);
  });
});
