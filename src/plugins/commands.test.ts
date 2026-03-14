import { afterEach, describe, expect, it } from "vitest";
import {
  clearPluginCommands,
  getPluginCommandSpecs,
  listPluginCommands,
  matchPluginCommand,
  registerPluginCommand,
} from "./commands.js";

afterEach(() => {
  clearPluginCommands();
});

describe("registerPluginCommand", () => {
  it("rejects malformed runtime command shapes", () => {
    const invalidName = registerPluginCommand(
      "demo-plugin",
      // Runtime plugin payloads are untyped; guard at boundary.
      {
        name: undefined as unknown as string,
        description: "Demo",
        handler: async () => ({ text: "ok" }),
      },
    );
    expect(invalidName).toEqual({
      ok: false,
      error: "Command name must be a string",
    });

    const invalidDescription = registerPluginCommand("demo-plugin", {
      name: "demo",
      description: undefined as unknown as string,
      handler: async () => ({ text: "ok" }),
    });
    expect(invalidDescription).toEqual({
      ok: false,
      error: "Command description must be a string",
    });
  });

  it("normalizes command metadata for downstream consumers", () => {
    const result = registerPluginCommand("demo-plugin", {
      name: "  demo_cmd  ",
      description: "  Demo command  ",
      handler: async () => ({ text: "ok" }),
    });
    expect(result).toEqual({ ok: true });
    expect(listPluginCommands()).toEqual([
      {
        name: "demo_cmd",
        description: "Demo command",
        pluginId: "demo-plugin",
      },
    ]);
    expect(getPluginCommandSpecs()).toEqual([
      {
        name: "demo_cmd",
        description: "Demo command",
        acceptsArgs: false,
      },
    ]);
  });

  it("supports provider-specific native command aliases", () => {
    const result = registerPluginCommand("demo-plugin", {
      name: "voice",
      nativeNames: {
        default: "talkvoice",
        discord: "discordvoice",
      },
      description: "Demo command",
      handler: async () => ({ text: "ok" }),
    });

    expect(result).toEqual({ ok: true });
    expect(getPluginCommandSpecs()).toEqual([
      {
        name: "talkvoice",
        description: "Demo command",
        acceptsArgs: false,
      },
    ]);
    expect(getPluginCommandSpecs("discord")).toEqual([
      {
        name: "discordvoice",
        description: "Demo command",
        acceptsArgs: false,
      },
    ]);
    expect(getPluginCommandSpecs("telegram")).toEqual([
      {
        name: "talkvoice",
        description: "Demo command",
        acceptsArgs: false,
      },
    ]);
  });

  it("matches plain-text aliases with prefix mode", () => {
    const result = registerPluginCommand("demo-plugin", {
      name: "dsback",
      description: "Fetch DeepSeek result",
      acceptsArgs: true,
      textAliases: ["dsback"],
      handler: async () => ({ text: "ok" }),
    });
    expect(result).toEqual({ ok: true });

    const matched = matchPluginCommand("dsback task-123");
    expect(matched?.command.name).toBe("dsback");
    expect(matched?.args).toBe("task-123");
  });

  it("matches plain-text aliases with contains mode and strips alias token", () => {
    const result = registerPluginCommand("demo-plugin", {
      name: "ds",
      description: "Queue DeepSeek ask",
      acceptsArgs: true,
      textAliases: ["ds"],
      textAliasMatch: "contains",
      handler: async () => ({ text: "ok" }),
    });
    expect(result).toEqual({ ok: true });

    const matched = matchPluginCommand("请你 ds 帮我总结这篇文章");
    expect(matched?.command.name).toBe("ds");
    expect(matched?.args).toBe("请你 帮我总结这篇文章");
    expect(matchPluginCommand("ads campaign")).toBeNull();
  });

  it("rejects duplicate text aliases across plugin commands", () => {
    const first = registerPluginCommand("plugin-a", {
      name: "ds",
      description: "DeepSeek",
      textAliases: ["ds"],
      handler: async () => ({ text: "ok" }),
    });
    expect(first).toEqual({ ok: true });

    const second = registerPluginCommand("plugin-b", {
      name: "other",
      description: "Other",
      textAliases: ["ds"],
      handler: async () => ({ text: "ok" }),
    });
    expect(second.ok).toBe(false);
    expect(second.error).toContain('Text alias "ds" already registered');
  });
});
