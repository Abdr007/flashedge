# Flash Terminal Plugin API

This document describes how to build, install, and use plugins for Flash Terminal.

## Overview

Flash Terminal supports a plugin system that lets you add custom CLI commands at runtime. Plugins are TypeScript/JavaScript modules that implement the `FlashPlugin` interface and are auto-discovered from the `src/plugins/` directory (or `dist/plugins/` in production).

---

## Plugin Lifecycle

A plugin goes through five stages:

### 1. Discovery

At startup (unless `--no-plugins` is passed), the plugin loader scans the plugins directory for eligible files. A file is eligible if:

- It ends with `.js` or `.ts`
- It does NOT start with `_` (underscore prefix means "skip")
- It is NOT `plugin-loader.ts` / `plugin-loader.js`
- It is NOT a type declaration (`.d.ts`) or source map (`.js.map`)

### 2. Loading

Each eligible file is dynamically imported. The loader looks for a `FlashPlugin` object as either:

- A **default export** (`export default { ... }`)
- A **named export** called `plugin` (`export const plugin = { ... }`)

If neither is found, or the export has no `name` field, the file is silently skipped.

Duplicate plugin names are rejected with a warning.

### 3. Initialization (`onInit`)

After a plugin's tools are registered, the loader calls `onInit(context)` if defined. This is where you perform one-time setup: log a startup message, initialize state, start background tasks, etc.

The `ToolContext` passed to `onInit` contains the current runtime state (client, wallet, mode).

### 4. Runtime

Plugin tools are available as CLI commands for the duration of the session. They are dispatched through the same `ToolRegistry` as built-in tools.

### 5. Shutdown (`onShutdown`)

When the terminal exits, `shutdownPlugins()` is called. Each plugin's `onShutdown()` hook runs (if defined). Use this to clean up timers, close connections, or flush data.

---

## Interfaces

### FlashPlugin

```typescript
interface FlashPlugin {
  /** Unique plugin name (used for logging and dedup). Required. */
  name: string;

  /** Semver version string (e.g. "1.0.0"). Optional. */
  version?: string;

  /** Human-readable description. Optional. */
  description?: string;

  /**
   * Return an array of ToolDefinition objects to register as CLI commands.
   * Called once during plugin loading.
   */
  tools?: () => ToolDefinition[];

  /**
   * Called once after the plugin is loaded and its tools are registered.
   * Receives the current ToolContext for access to clients and state.
   */
  onInit?: (context: ToolContext) => Promise<void> | void;

  /**
   * Called when the terminal shuts down.
   * Use for cleanup (timers, connections, file handles).
   */
  onShutdown?: () => Promise<void> | void;
}
```

### ToolDefinition

Each tool your plugin provides must conform to this interface:

```typescript
interface ToolDefinition<TParams = Record<string, unknown>> {
  /** Unique tool name (used for dispatch). Must not collide with core tools. */
  name: string;

  /** Short description shown in help text. */
  description: string;

  /** Optional Zod schema for parameter validation. */
  parameters?: ZodType<TParams>;

  /** The function that executes the tool. Receives validated params and context. */
  execute: (params: TParams, context: ToolContext) => Promise<ToolResult>;
}
```

### ToolContext

The context object passed to every tool execution and to `onInit`:

```typescript
interface ToolContext {
  /** The active Flash Trade client (live or simulated). */
  flashClient: IFlashClient;

  /** Data client for market stats, leaderboards, fees, etc. */
  dataClient: IDataClient;

  /** True if running in simulation (paper trading) mode. */
  simulationMode: boolean;

  /** True if degen mode is active (higher leverage limits). */
  degenMode: boolean;

  /** Public key of the connected wallet. */
  walletAddress: string;

  /** Human-readable name of the active wallet. */
  walletName: string;

  /** WalletManager instance for wallet operations. */
  walletManager: WalletManager;

  /** In-memory log of trades executed during this session. */
  sessionTrades?: SessionTrade[];
}
```

### ToolResult

Every tool must return a `ToolResult`:

```typescript
interface ToolResult {
  /** Whether the operation succeeded. */
  success: boolean;

  /** Human-readable message displayed to the user. */
  message: string;

  /** Optional structured data for programmatic consumers. */
  data?: ToolExecutionData;

  /** Transaction signature (for on-chain operations). */
  txSignature?: string;

  /** If true, the CLI will prompt the user for confirmation before proceeding. */
  requiresConfirmation?: boolean;

  /** Custom confirmation prompt text. */
  confirmationPrompt?: string;
}
```

---

## Plugin Registration

### Default Export (recommended)

```typescript
import type { FlashPlugin } from './plugin-loader.js';

const myPlugin: FlashPlugin = {
  name: 'my-plugin',
  version: '1.0.0',
  tools: () => [/* ... */],
};

export default myPlugin;
```

### Named Export

```typescript
export const plugin: FlashPlugin = {
  name: 'my-plugin',
  version: '1.0.0',
  tools: () => [/* ... */],
};
```

The loader checks `mod.default` first, then falls back to `mod.plugin`.

---

## Core Tool Protection

When the `ToolEngine` starts up, it registers all built-in tools (trading, wallet, analytics, etc.) and then calls `registry.lockCore()`. This marks every currently registered tool name as "core."

After `lockCore()`, any attempt to register a tool with a core name is **silently blocked** with a warning log:

```
[REGISTRY] Blocked attempt to override core tool: flash_open_position
```

This means plugins cannot replace or shadow built-in commands. Choose unique tool names for your plugin (e.g. prefix with your plugin name: `myplugin_command`).

---

## File Naming Rules

| Pattern | Behavior |
|---|---|
| `my-plugin.ts` | Auto-loaded at startup |
| `_my-plugin.ts` | Skipped (underscore prefix) |
| `plugin-loader.ts` | Skipped (the loader itself) |
| `my-plugin.d.ts` | Skipped (type declaration) |
| `my-plugin.js.map` | Skipped (source map) |

Use the `_` prefix convention for example files, templates, or plugins you want to keep in the directory without auto-loading.

---

## Installation

### Adding a Plugin

1. Create a `.ts` file in `src/plugins/` (or `.js` in `dist/plugins/` for production).
2. Export a `FlashPlugin` object as the default export.
3. Restart Flash Terminal. The plugin is auto-discovered and loaded.

### Disabling Plugins

Pass `--no-plugins` when starting the terminal to skip all plugin loading:

```bash
flash --no-plugins
```

This sets `config.noPlugins = true` and bypasses the entire plugin discovery/loading phase.

---

## Best Practices

- **Unique names**: Prefix tool names with your plugin name to avoid collisions (e.g. `alerts_set`, `alerts_list`).
- **Validate inputs**: Use Zod schemas in `parameters` for type-safe parameter validation.
- **Check simulation mode**: Always check `context.simulationMode` before performing actions that differ between live and paper trading.
- **Handle errors gracefully**: Return `{ success: false, message: '...' }` instead of throwing.
- **Clean up in onShutdown**: Stop intervals, close connections, release resources.
- **Keep tools focused**: Each tool should do one thing well, matching the style of built-in commands.

---

## Example

See `src/plugins/_example-plugin.ts` for a complete, annotated example plugin that demonstrates all the concepts above.
