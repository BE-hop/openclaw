/**
 * Plugin Command Registry
 *
 * Manages commands registered by plugins that bypass the LLM agent.
 * These commands are processed before built-in commands and before agent invocation.
 */

import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "./types.js";

type TextAliasMatchMode = "prefix" | "contains";

type RegisteredPluginCommand = OpenClawPluginCommandDefinition & {
  pluginId: string;
  textAliases: string[];
  textAliasMatch: TextAliasMatchMode;
};

// Registry of plugin commands
const pluginCommands: Map<string, RegisteredPluginCommand> = new Map();

// Lock to prevent modifications during command execution
let registryLocked = false;

// Maximum allowed length for command arguments (defense in depth)
const MAX_ARGS_LENGTH = 4096;

/**
 * Reserved command names that plugins cannot override.
 * These are built-in commands from commands-registry.data.ts.
 */
const RESERVED_COMMANDS = new Set([
  // Core commands
  "help",
  "commands",
  "status",
  "whoami",
  "context",
  // Session management
  "stop",
  "restart",
  "reset",
  "new",
  "compact",
  // Configuration
  "config",
  "debug",
  "allowlist",
  "activation",
  // Agent control
  "skill",
  "subagents",
  "kill",
  "steer",
  "tell",
  "model",
  "models",
  "queue",
  // Messaging
  "send",
  // Execution
  "bash",
  "exec",
  // Mode toggles
  "think",
  "verbose",
  "reasoning",
  "elevated",
  // Billing
  "usage",
]);

/**
 * Validate a command name.
 * Returns an error message if invalid, or null if valid.
 */
export function validateCommandName(name: string): string | null {
  const trimmed = name.trim().toLowerCase();

  if (!trimmed) {
    return "Command name cannot be empty";
  }

  // Must start with a letter, contain only letters, numbers, hyphens, underscores
  // Note: trimmed is already lowercased, so no need for /i flag
  if (!/^[a-z][a-z0-9_-]*$/.test(trimmed)) {
    return "Command name must start with a letter and contain only letters, numbers, hyphens, and underscores";
  }

  // Check reserved commands
  if (RESERVED_COMMANDS.has(trimmed)) {
    return `Command name "${trimmed}" is reserved by a built-in command`;
  }

  return null;
}

function normalizeTextAlias(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1).trim() : trimmed;
  if (!withoutSlash) {
    return null;
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(withoutSlash)) {
    return null;
  }
  return withoutSlash;
}

export type CommandRegistrationResult = {
  ok: boolean;
  error?: string;
};

/**
 * Register a plugin command.
 * Returns an error if the command name is invalid or reserved.
 */
export function registerPluginCommand(
  pluginId: string,
  command: OpenClawPluginCommandDefinition,
): CommandRegistrationResult {
  // Prevent registration while commands are being processed
  if (registryLocked) {
    return { ok: false, error: "Cannot register commands while processing is in progress" };
  }

  // Validate handler is a function
  if (typeof command.handler !== "function") {
    return { ok: false, error: "Command handler must be a function" };
  }

  if (typeof command.name !== "string") {
    return { ok: false, error: "Command name must be a string" };
  }
  if (typeof command.description !== "string") {
    return { ok: false, error: "Command description must be a string" };
  }

  const name = command.name.trim();
  const description = command.description.trim();
  if (!description) {
    return { ok: false, error: "Command description cannot be empty" };
  }

  const validationError = validateCommandName(name);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  const textAliasMatchModeRaw = command.textAliasMatch?.trim().toLowerCase();
  const textAliasMatch: TextAliasMatchMode =
    textAliasMatchModeRaw === "contains" ? "contains" : "prefix";
  if (
    textAliasMatchModeRaw &&
    textAliasMatchModeRaw !== "prefix" &&
    textAliasMatchModeRaw !== "contains"
  ) {
    return {
      ok: false,
      error: `textAliasMatch must be "prefix" or "contains" (received "${command.textAliasMatch}")`,
    };
  }

  const textAliases: string[] = [];
  for (const rawAlias of command.textAliases ?? []) {
    if (typeof rawAlias !== "string") {
      return { ok: false, error: "textAliases entries must be strings" };
    }
    const normalizedAlias = normalizeTextAlias(rawAlias);
    if (!normalizedAlias) {
      return {
        ok: false,
        error: `Invalid text alias "${rawAlias}". Use letters/numbers/_/- and start with a letter.`,
      };
    }
    const aliasValidationError = validateCommandName(normalizedAlias);
    if (aliasValidationError) {
      return { ok: false, error: `Invalid text alias "${rawAlias}": ${aliasValidationError}` };
    }
    if (!textAliases.includes(normalizedAlias)) {
      textAliases.push(normalizedAlias);
    }
  }

  const key = `/${name.toLowerCase()}`;

  // Check for duplicate registration
  if (pluginCommands.has(key)) {
    const existing = pluginCommands.get(key)!;
    return {
      ok: false,
      error: `Command "${name}" already registered by plugin "${existing.pluginId}"`,
    };
  }

  for (const alias of textAliases) {
    const existingAliasOwner = Array.from(pluginCommands.values()).find((entry) =>
      entry.textAliases.includes(alias),
    );
    if (existingAliasOwner) {
      return {
        ok: false,
        error: `Text alias "${alias}" already registered by plugin "${existingAliasOwner.pluginId}" (/${existingAliasOwner.name})`,
      };
    }
  }

  const normalizedCommand: RegisteredPluginCommand = {
    ...command,
    name,
    description,
    pluginId,
    textAliases,
    textAliasMatch,
  };

  pluginCommands.set(key, normalizedCommand);
  logVerbose(`Registered plugin command: ${key} (plugin: ${pluginId})`);
  return { ok: true };
}

/**
 * Clear all registered plugin commands.
 * Called during plugin reload.
 */
export function clearPluginCommands(): void {
  pluginCommands.clear();
}

/**
 * Clear plugin commands for a specific plugin.
 */
export function clearPluginCommandsForPlugin(pluginId: string): void {
  for (const [key, cmd] of pluginCommands.entries()) {
    if (cmd.pluginId === pluginId) {
      pluginCommands.delete(key);
    }
  }
}

/**
 * Check if a command body matches a registered plugin command.
 * Returns the command definition and parsed args if matched.
 *
 * Note: If a command has `acceptsArgs: false` and the user provides arguments,
 * the command will not match. This allows the message to fall through to
 * built-in handlers or the agent. Document this behavior to plugin authors.
 */
function isTextAliasTokenChar(char: string | undefined): boolean {
  if (!char) {
    return false;
  }
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95
  ); // _
}

function findTokenAliasIndex(textLower: string, alias: string): number {
  let start = 0;
  while (start <= textLower.length - alias.length) {
    const idx = textLower.indexOf(alias, start);
    if (idx < 0) {
      return -1;
    }
    const before = idx > 0 ? textLower[idx - 1] : undefined;
    const after = idx + alias.length < textLower.length ? textLower[idx + alias.length] : undefined;
    if (!isTextAliasTokenChar(before) && !isTextAliasTokenChar(after)) {
      return idx;
    }
    start = idx + alias.length;
  }
  return -1;
}

function matchSlashPluginCommand(
  trimmed: string,
): { command: RegisteredPluginCommand; args?: string } | null {
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const spaceIndex = trimmed.indexOf(" ");
  const commandName = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const args = spaceIndex === -1 ? undefined : trimmed.slice(spaceIndex + 1).trim();

  const key = commandName.toLowerCase();
  const command = pluginCommands.get(key);
  if (!command) {
    return null;
  }
  if (args && !command.acceptsArgs) {
    return null;
  }
  return { command, args: args || undefined };
}

function matchTextAliasPluginCommand(
  trimmed: string,
): { command: RegisteredPluginCommand; args?: string } | null {
  const text = trimmed.trim();
  if (!text || text.startsWith("/")) {
    return null;
  }

  const textLower = text.toLowerCase();
  type Candidate = { command: RegisteredPluginCommand; args?: string; score: number };
  let best: Candidate | null = null;

  for (const command of pluginCommands.values()) {
    if (command.textAliases.length === 0) {
      continue;
    }
    for (const alias of command.textAliases) {
      if (command.textAliasMatch === "contains") {
        const idx = findTokenAliasIndex(textLower, alias);
        if (idx < 0) {
          continue;
        }
        const before = text.slice(0, idx).trim();
        const after = text.slice(idx + alias.length).trim();
        const combined = [before, after].filter(Boolean).join(" ").trim();
        const args = combined || undefined;
        if (args && !command.acceptsArgs) {
          continue;
        }
        const candidate: Candidate = {
          command,
          args,
          score: 100 + alias.length,
        };
        if (!best || candidate.score > best.score) {
          best = candidate;
        }
        continue;
      }

      if (textLower === alias) {
        const candidate: Candidate = {
          command,
          score: 400 + alias.length,
        };
        if (!best || candidate.score > best.score) {
          best = candidate;
        }
        continue;
      }
      if (!textLower.startsWith(alias)) {
        continue;
      }
      const nextChar = text.charAt(alias.length);
      if (nextChar && !/\s/.test(nextChar)) {
        continue;
      }
      const args = text.slice(alias.length).trim() || undefined;
      if (args && !command.acceptsArgs) {
        continue;
      }
      const candidate: Candidate = {
        command,
        args,
        score: 300 + alias.length,
      };
      if (!best || candidate.score > best.score) {
        best = candidate;
      }
    }
  }

  return best ? { command: best.command, args: best.args } : null;
}

export function matchPluginCommand(
  commandBody: string,
): { command: RegisteredPluginCommand; args?: string } | null {
  const trimmed = commandBody.trim();
  if (!trimmed) {
    return null;
  }
  return matchSlashPluginCommand(trimmed) ?? matchTextAliasPluginCommand(trimmed);
}

/**
 * Sanitize command arguments to prevent injection attacks.
 * Removes control characters and enforces length limits.
 */
function sanitizeArgs(args: string | undefined): string | undefined {
  if (!args) {
    return undefined;
  }

  // Enforce length limit
  if (args.length > MAX_ARGS_LENGTH) {
    return args.slice(0, MAX_ARGS_LENGTH);
  }

  // Remove control characters (except newlines and tabs which may be intentional)
  let sanitized = "";
  for (const char of args) {
    const code = char.charCodeAt(0);
    const isControl = (code <= 0x1f && code !== 0x09 && code !== 0x0a) || code === 0x7f;
    if (!isControl) {
      sanitized += char;
    }
  }
  return sanitized;
}

/**
 * Execute a plugin command handler.
 *
 * Note: Plugin authors should still validate and sanitize ctx.args for their
 * specific use case. This function provides basic defense-in-depth sanitization.
 */
export async function executePluginCommand(params: {
  command: RegisteredPluginCommand;
  args?: string;
  senderId?: string;
  channel: string;
  channelId?: PluginCommandContext["channelId"];
  isAuthorizedSender: boolean;
  commandBody: string;
  config: OpenClawConfig;
  from?: PluginCommandContext["from"];
  to?: PluginCommandContext["to"];
  accountId?: PluginCommandContext["accountId"];
  messageThreadId?: PluginCommandContext["messageThreadId"];
}): Promise<PluginCommandResult> {
  const { command, args, senderId, channel, isAuthorizedSender, commandBody, config } = params;

  // Check authorization
  const requireAuth = command.requireAuth !== false; // Default to true
  if (requireAuth && !isAuthorizedSender) {
    logVerbose(
      `Plugin command /${command.name} blocked: unauthorized sender ${senderId || "<unknown>"}`,
    );
    return { text: "⚠️ This command requires authorization." };
  }

  // Sanitize args before passing to handler
  const sanitizedArgs = sanitizeArgs(args);

  const ctx: PluginCommandContext = {
    senderId,
    channel,
    channelId: params.channelId,
    isAuthorizedSender,
    args: sanitizedArgs,
    commandBody,
    config,
    from: params.from,
    to: params.to,
    accountId: params.accountId,
    messageThreadId: params.messageThreadId,
  };

  // Lock registry during execution to prevent concurrent modifications
  registryLocked = true;
  try {
    const result = await command.handler(ctx);
    logVerbose(
      `Plugin command /${command.name} executed successfully for ${senderId || "unknown"}`,
    );
    return result;
  } catch (err) {
    const error = err as Error;
    logVerbose(`Plugin command /${command.name} error: ${error.message}`);
    // Don't leak internal error details - return a safe generic message
    return { text: "⚠️ Command failed. Please try again later." };
  } finally {
    registryLocked = false;
  }
}

/**
 * List all registered plugin commands.
 * Used for /help and /commands output.
 */
export function listPluginCommands(): Array<{
  name: string;
  description: string;
  pluginId: string;
}> {
  return Array.from(pluginCommands.values()).map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    pluginId: cmd.pluginId,
  }));
}

function resolvePluginNativeName(
  command: OpenClawPluginCommandDefinition,
  provider?: string,
): string {
  const providerName = provider?.trim().toLowerCase();
  const providerOverride = providerName ? command.nativeNames?.[providerName] : undefined;
  if (typeof providerOverride === "string" && providerOverride.trim()) {
    return providerOverride.trim();
  }
  const defaultOverride = command.nativeNames?.default;
  if (typeof defaultOverride === "string" && defaultOverride.trim()) {
    return defaultOverride.trim();
  }
  return command.name;
}

/**
 * Get plugin command specs for native command registration (e.g., Telegram).
 */
export function getPluginCommandSpecs(provider?: string): Array<{
  name: string;
  description: string;
  acceptsArgs: boolean;
}> {
  return Array.from(pluginCommands.values()).map((cmd) => ({
    name: resolvePluginNativeName(cmd, provider),
    description: cmd.description,
    acceptsArgs: cmd.acceptsArgs ?? false,
  }));
}
