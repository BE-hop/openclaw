import { describe, expect, it } from "vitest";
import { parseWechatEncryptedEnvelope, parseWechatInboundMessage } from "./wechat-xml.js";

describe("wechat-xml", () => {
  it("parses plaintext inbound text message", () => {
    const xml = `<xml>
  <ToUserName><![CDATA[gh_123]]></ToUserName>
  <FromUserName><![CDATA[oOPENID123]]></FromUserName>
  <CreateTime>1700000000</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[你好]]></Content>
  <MsgId>1234567890123456</MsgId>
</xml>`;

    const parsed = parseWechatInboundMessage(xml);
    expect(parsed.toUserName).toBe("gh_123");
    expect(parsed.fromUserName).toBe("oOPENID123");
    expect(parsed.msgType).toBe("text");
    expect(parsed.content).toBe("你好");
    expect(parsed.msgId).toBe("1234567890123456");
    expect(parsed.createTime).toBe(1700000000);
  });

  it("parses encrypted envelope", () => {
    const xml = `<xml>
  <ToUserName><![CDATA[gh_123]]></ToUserName>
  <Encrypt><![CDATA[ENCRYPTED_PAYLOAD]]></Encrypt>
</xml>`;

    const parsed = parseWechatEncryptedEnvelope(xml);
    expect(parsed.toUserName).toBe("gh_123");
    expect(parsed.encrypt).toBe("ENCRYPTED_PAYLOAD");
  });
});
