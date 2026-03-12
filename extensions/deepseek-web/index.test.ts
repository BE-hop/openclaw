import { describe, expect, it } from "vitest";
import { __testing } from "./index.js";

describe("deepseek-web helpers", () => {
  it("detects overlap-based new messages", () => {
    const prev: Parameters<typeof __testing.detectNewMessages>[0] = [
      { role: "user", text: "A", fingerprint: "1", observedAtMs: 1, sourceUrl: "" },
      { role: "assistant", text: "B", fingerprint: "2", observedAtMs: 1, sourceUrl: "" },
    ];
    const next: Parameters<typeof __testing.detectNewMessages>[1] = [
      { role: "assistant", text: "B", fingerprint: "2", observedAtMs: 1, sourceUrl: "" },
      { role: "assistant", text: "C", fingerprint: "3", observedAtMs: 1, sourceUrl: "" },
    ];

    const result = __testing.detectNewMessages(prev, next);
    expect(result).toHaveLength(1);
    expect(result[0]?.fingerprint).toBe("3");
  });

  it("normalizes command action and rest", () => {
    const parsed = __testing.parseActionAndRest("ask   hello world");
    expect(parsed.action).toBe("ask");
    expect(parsed.rest).toBe("hello world");
  });

  it("maps role aliases", () => {
    expect(__testing.normalizeRole("BOT")).toBe("assistant");
    expect(__testing.normalizeRole("human")).toBe("user");
    expect(__testing.normalizeRole("other")).toBe("unknown");
  });
});
