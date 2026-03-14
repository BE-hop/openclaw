import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __testing, maybeHandleWechatChatgptBridgeInbound } from "./deepseek-bridge.js";

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
    expect(__testing.parseDeepseekCommand("gptback gpt-xyz", "gpt")).toEqual({
      kind: "fetch",
      taskId: "gpt-xyz",
    });
  });

  it("parses gptnew command and marks forceNewConversation", () => {
    expect(__testing.parseDeepseekCommand("gptnew 新会话提问", "gpt")).toEqual({
      kind: "enqueue",
      prompt: "新会话提问",
      forceNewConversation: true,
    });
    expect(__testing.parseDeepseekCommand("gptnew新会话提问", "gpt")).toEqual({
      kind: "enqueue",
      prompt: "新会话提问",
      forceNewConversation: true,
    });
  });

  it("parses any message containing ds as enqueue", () => {
    expect(__testing.parseDeepseekCommand("ds 解释 MCP")).toEqual({
      kind: "enqueue",
      prompt: "解释 MCP",
    });
    expect(__testing.parseDeepseekCommand("请用ds帮我总结这段话")).toEqual({
      kind: "enqueue",
      prompt: "请用 帮我总结这段话",
    });
    expect(__testing.parseDeepseekCommand("DS 给我一个提纲")).toEqual({
      kind: "enqueue",
      prompt: "给我一个提纲",
    });
  });

  it("returns empty prompt when only prefix is provided", () => {
    expect(__testing.parseDeepseekCommand("ds")).toEqual({
      kind: "enqueue",
      prompt: "",
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

describe("deepseek-bridge fetch chunking", () => {
  it("splits long text by utf8 bytes and preserves content", () => {
    const text = "你".repeat(1200);
    const chunks = __testing.splitAnswerForFetch(text, 600);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 600)).toBe(true);
  });

  it("preserves whitespace and newlines across chunk boundaries", () => {
    const line = "第一行\n第二行  末尾空格 \n\n第三行\n";
    const text = line.repeat(80);
    const chunks = __testing.splitAnswerForFetch(text, 256);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("returns answer chunks progressively with remaining dsback hint", () => {
    const task = {
      id: "ds-test",
      bridgeKind: "deepseek" as const,
      accountId: "default",
      senderId: "u1",
      prompt: "q",
      status: "done" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
      answer: "a".repeat(4_000),
      fetchCursor: 0,
    };

    const first = __testing.buildDoneTaskFetchReply({
      task,
      commandPrefix: "ds",
      fetchCommand: "dsback",
    });
    expect(first).toContain("任务 ds-test 已完成（1/3）：");
    expect(first).toContain("还需发送 dsback 2 次可取完");

    const second = __testing.buildDoneTaskFetchReply({
      task,
      commandPrefix: "ds",
      fetchCommand: "dsback",
    });
    expect(second).toContain("任务 ds-test 已完成（2/3）：");
    expect(second).toContain("还需发送 dsback 1 次可取完");

    const third = __testing.buildDoneTaskFetchReply({
      task,
      commandPrefix: "ds",
      fetchCommand: "dsback",
    });
    expect(third).toContain("任务 ds-test 已完成（3/3）：");
    expect(third).toContain("内容已发送完毕，可发送包含 ds 的新问题");

    const completed = __testing.buildDoneTaskFetchReply({
      task,
      commandPrefix: "ds",
      fetchCommand: "dsback",
    });
    expect(completed).toContain("任务 ds-test 内容已发送完毕");
  });
});

describe("deepseek-bridge chatgpt answer freshness", () => {
  it("accepts non-empty answer when baseline is empty", () => {
    expect(__testing.isNewChatgptAnswer("新的回答", "")).toBe(true);
  });

  it("rejects unchanged baseline answer", () => {
    expect(__testing.isNewChatgptAnswer("我是一个智能助手", "我是一个智能助手")).toBe(false);
  });

  it("accepts changed answer when baseline exists", () => {
    expect(__testing.isNewChatgptAnswer("我是一个智能助手，测试成功", "我是一个智能助手")).toBe(
      true,
    );
  });

  it("detects likely same prompt text to avoid duplicate fallback sends", () => {
    expect(__testing.isLikelySamePrompt("只回复 FOLLOW", "只回复 FOLLOW")).toBe(true);
    expect(__testing.isLikelySamePrompt("请只回复 FOLLOW", "请只回复 FOLLOW，谢谢")).toBe(true);
    expect(__testing.isLikelySamePrompt("只回复 FOLLOW", "只回复 TEST")).toBe(false);
  });
});

describe("deepseek-bridge conversation routing", () => {
  it("keeps ChatGPT on same target unless forceNewConversation is set", () => {
    expect(
      __testing.shouldStartFreshConversation({
        bridgeKind: "chatgpt",
        targetId: "t1",
        turnsInConversation: 999,
      }),
    ).toBe(false);
    expect(
      __testing.shouldStartFreshConversation({
        bridgeKind: "chatgpt",
        targetId: "t1",
        turnsInConversation: 1,
        forceNewConversation: true,
      }),
    ).toBe(true);
  });

  it("opens fresh conversation for DeepSeek when turn cap reached", () => {
    expect(
      __testing.shouldStartFreshConversation({
        bridgeKind: "deepseek",
        targetId: "t2",
        turnsInConversation: 9,
      }),
    ).toBe(false);
    expect(
      __testing.shouldStartFreshConversation({
        bridgeKind: "deepseek",
        targetId: "t2",
        turnsInConversation: 10,
      }),
    ).toBe(true);
  });
});

describe("deepseek-bridge chatgpt aria ref picking", () => {
  it("picks textbox ref from aria nodes", () => {
    expect(
      __testing.pickChatgptTextboxRef([
        { ref: "ax1", role: "button", name: "打开边栏", depth: 1 },
        { ref: "ax9", role: "textbox", name: "", depth: 2 },
      ]),
    ).toBe("ax9");
  });

  it("picks send-like button ref from aria nodes", () => {
    expect(
      __testing.pickChatgptSendButtonRef([
        { ref: "ax3", role: "button", name: "更多操作", depth: 1 },
        { ref: "ax7", role: "button", name: "发送", depth: 1 },
      ]),
    ).toBe("ax7");
  });

  it("prefers chatgpt conversation tab when selecting an existing tab", () => {
    expect(
      __testing.pickChatgptTab([
        { targetId: "t1", title: "Search", url: "https://www.google.com" },
        { targetId: "t2", title: "ChatGPT", url: "https://chatgpt.com/" },
        {
          targetId: "t3",
          title: "ChatGPT - convo",
          url: "https://chatgpt.com/c/abc123",
        },
      ]),
    ).toEqual({ targetId: "t3", title: "ChatGPT - convo", url: "https://chatgpt.com/c/abc123" });
  });
});

describe("deepseek-bridge fetch cursor consistency", () => {
  it("only advances fetch cursor after reply delivery succeeds", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-bridge-cursor-"));
    const statePath = path.join(stateDir, "plugins", "wechat-official", "deepseek-bridge.json");
    const taskId = "gpt-test-task";
    const senderId = "wx-user-1";

    try {
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(
        statePath,
        `${JSON.stringify(
          {
            version: 1,
            tasks: {
              [taskId]: {
                id: taskId,
                bridgeKind: "chatgpt",
                accountId: "default",
                senderId,
                prompt: "test prompt",
                status: "done",
                createdAtMs: Date.now(),
                updatedAtMs: Date.now(),
                answer: "A".repeat(4_000),
                fetchCursor: 0,
              },
            },
            order: [taskId],
            conversations: {},
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const runtime = {
        state: {
          resolveStateDir: () => stateDir,
        },
      } as Parameters<typeof maybeHandleWechatChatgptBridgeInbound>[0]["runtime"];

      const account = {
        accountId: "default",
        enabled: true,
        appId: "app-id",
        appSecret: "app-secret",
        token: "token",
        webhookPath: "/wechat/webhook",
        dmPolicy: "open",
        allowFrom: [],
        textChunkLimit: 1200,
        deepseekBridge: {
          enabled: false,
          commandPrefix: "ds",
          browserProfile: "chrome",
          openUrl: "https://chat.deepseek.com/",
          pollIntervalMs: 7000,
          maxWaitMs: 300_000,
          thinkingReply: "deepseek thinking",
        },
        chatgptBridge: {
          enabled: true,
          commandPrefix: "gpt",
          browserProfile: "chrome",
          openUrl: "https://chatgpt.com/",
          pollIntervalMs: 7000,
          maxWaitMs: 300_000,
          thinkingReply: "chatgpt thinking",
        },
      } as Parameters<typeof maybeHandleWechatChatgptBridgeInbound>[0]["account"];

      const baseParams = {
        message: {
          fromUserName: senderId,
          toUserName: "gh",
          msgType: "text",
          content: "gptback",
        },
        rawBody: "gptback",
        senderId,
        account,
        cfg: {},
        runtime,
      } as const;

      await expect(
        maybeHandleWechatChatgptBridgeInbound({
          ...baseParams,
          deliverReply: async () => {
            throw new Error("send failed");
          },
        }),
      ).rejects.toThrow("send failed");

      const afterFailed = JSON.parse(await fs.readFile(statePath, "utf8")) as {
        tasks: Record<string, { fetchCursor?: number }>;
      };
      expect(afterFailed.tasks[taskId]?.fetchCursor).toBe(0);

      let deliveredText = "";
      const handled = await maybeHandleWechatChatgptBridgeInbound({
        ...baseParams,
        deliverReply: async (text) => {
          deliveredText = text;
        },
      });
      expect(handled).toEqual({ handled: true });
      expect(deliveredText).toContain(`任务 ${taskId} 已完成（1/3）：`);

      const afterSuccess = JSON.parse(await fs.readFile(statePath, "utf8")) as {
        tasks: Record<string, { fetchCursor?: number }>;
      };
      expect(afterSuccess.tasks[taskId]?.fetchCursor).toBe(1);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
