import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("wechat-official plugin register", () => {
  it("registers channel plus ds/dsback/gpt/gptnew/gptback plugin commands", () => {
    const registerChannel = vi.fn();
    const registerCommand = vi.fn();

    const api = {
      runtime: {},
      registerChannel,
      registerCommand,
    } as unknown as Parameters<NonNullable<typeof plugin.register>>[0];

    plugin.register?.(api);

    expect(registerChannel).toHaveBeenCalledTimes(1);
    expect(registerCommand).toHaveBeenCalledTimes(5);

    const commands = registerCommand.mock.calls.map((call) => call[0]) as Array<{
      name: string;
      textAliases?: string[];
      textAliasMatch?: "prefix" | "contains";
      requireAuth?: boolean;
    }>;
    const names = commands.map((entry) => entry.name);
    expect(names).toEqual(["ds", "dsback", "gpt", "gptnew", "gptback"]);

    const ds = commands.find((entry) => entry.name === "ds");
    expect(ds?.textAliases).toEqual(["ds", "deepseek"]);
    expect(ds?.textAliasMatch).toBe("contains");
    expect(ds?.requireAuth).toBe(false);

    const dsback = commands.find((entry) => entry.name === "dsback");
    expect(dsback?.textAliases).toEqual(["dsback"]);
    expect(dsback?.requireAuth).toBe(false);

    const gpt = commands.find((entry) => entry.name === "gpt");
    expect(gpt?.textAliases).toEqual(["gpt", "chatgpt"]);
    expect(gpt?.textAliasMatch).toBe("contains");
    expect(gpt?.requireAuth).toBe(false);

    const gptnew = commands.find((entry) => entry.name === "gptnew");
    expect(gptnew?.textAliases).toEqual(["gptnew"]);
    expect(gptnew?.textAliasMatch).toBe("contains");
    expect(gptnew?.requireAuth).toBe(false);

    const gptback = commands.find((entry) => entry.name === "gptback");
    expect(gptback?.textAliases).toEqual(["gptback"]);
    expect(gptback?.requireAuth).toBe(false);
  });
});
