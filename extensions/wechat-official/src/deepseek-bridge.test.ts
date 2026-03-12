import { describe, expect, it } from "vitest";
import { __testing } from "./deepseek-bridge.js";

describe("deepseek-bridge command parser", () => {
  it("ignores messages without ds trigger", () => {
    expect(__testing.parseDeepseekCommand("你好")).toEqual({ kind: "none" });
  });

  it("parses fetch command dsback", () => {
    expect(__testing.parseDeepseekCommand("dsback")).toEqual({ kind: "fetch" });
    expect(__testing.parseDeepseekCommand("dsback ds-xyz")).toEqual({
      kind: "fetch",
      taskId: "ds-xyz",
    });
  });

  it("parses any message containing ds as enqueue", () => {
    expect(__testing.parseDeepseekCommand("ds 解释 MCP")).toEqual({
      kind: "enqueue",
      prompt: "解释 MCP",
    });
    expect(__testing.parseDeepseekCommand("请用ds帮我总结这段话")).toEqual({
      kind: "enqueue",
      prompt: "请用帮我总结这段话",
    });
    expect(__testing.parseDeepseekCommand("DS 给我一个提纲")).toEqual({
      kind: "enqueue",
      prompt: "给我一个提纲",
    });
  });
});

describe("deepseek-bridge answer extraction", () => {
  it("extracts answer after prompt and removes ui noise", () => {
    const lines = [
      "深度思考",
      "今天上海天气如何？",
      "会有小雨，气温 15-21 度，出门带伞。",
      "内容由 AI 生成，请仔细甄别",
    ];
    const answer = __testing.deriveAnswerFromLines(lines, "今天上海天气如何？");
    expect(answer).toContain("会有小雨");
    expect(answer).not.toContain("内容由 AI 生成");
  });

  it("falls back to tail lines when prompt cannot be found", () => {
    const lines = ["系统提示", "第一段回答", "第二段回答"];
    const answer = __testing.deriveAnswerFromLines(lines, "未出现的问题");
    expect(answer).toContain("第一段回答");
    expect(answer).toContain("第二段回答");
  });
});
