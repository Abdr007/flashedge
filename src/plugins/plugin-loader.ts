import { ToolDefinition, ToolContext } from '../types/index.js';
import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/retry.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const ALLOWED_PLUGINS_FILE = join(homedir(), '.flash', 'allowed-plugins.json');
const PLUGIN_INIT_TIMEOUT_MS = 5_000;

/** Load the plugin allowlist from ~/.flash/allowed-plugins.json */
function loadAllowedPlugins(): Set<string> | null {
  try {
    if (!existsSync(ALLOWED_PLUGINS_FILE)) return null; // No allowlist = allow all (backwards compat)
    const raw = readFileSync(ALLOWED_PLUGINS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return new Set(data.map(String));
    return null;
  } catch {
    return null;
  }
}

// ─── Plugin Interface ───────────────────────────────────────────────────────

/**
 * FlashPlugin — the extension point for custom functionality.
 *
 * Plugins can register:
 *   - tools:    Custom CLI commands (same interface as built-in tools)
 *   - hooks:    Lifecycle callbacks (onInit, onTrade, onShutdown)
 *
 * Plugins are loaded from src/plugins/ at startup.
 * Each plugin file should export a default `FlashPlugin` object.
 */
export interface FlashPlugin {
  /** Unique plugin name (used for logging and dedup) */
  name: string;

  /** Optional plugin version string */
  version?: string;

  /** Optional description */
  description?: string;

  /**
   * Return tool definitions to register with the tool engine.
   * These become available as CLI commands.
   */
  tools?: () => ToolDefinition[];

  /**
   * Called once after plugin is loaded and tools are registered.
   */
  onInit?: (context: ToolContext) => Promise<void> | void;

  /**
   * Called when the terminal shuts down.
   */
  onShutdown?: () => Promise<void> | void;
}

// ─── Plugin Registry ────────────────────────────────────────────────────────

const loadedPlugins: FlashPlugin[] = [];

/**
 * Load all plugins from the plugins directory.
 * Plugins are .ts/.js files in src/plugins/ that export a FlashPlugin.
 * The loader file itself and any files starting with _ are skipped.
 */
export async function loadPlugins(context: ToolContext): Promise<ToolDefinition[]> {
  const logger = getLogger();
  const allTools: ToolDefinition[] = [];

  try {
    // Dynamic import of the plugins directory
    // In production, plugins would be compiled .js files in dist/plugins/
    const { readdirSync } = await import('fs');
    const { join } = await import('path');
    const { fileURLToPath } = await import('url');

    // Resolve plugins dir relative to this file
    const thisFile = fileURLToPath(import.meta.url);
    const pluginsDir = join(thisFile, '..');

    let files: string[];
    try {
      files = readdirSync(pluginsDir);
    } catch {
      logger.debug('PLUGINS', 'No plugins directory found');
      return allTools;
    }

    const pluginFiles = files.filter(
      (f) =>
        (f.endsWith('.js') || f.endsWith('.ts')) &&
        !f.endsWith('.d.ts') &&
        !f.endsWith('.js.map') &&
        !f.startsWith('_') &&
        !f.includes('/') &&
        !f.includes('\\') &&
        f !== 'plugin-loader.ts' &&
        f !== 'plugin-loader.js',
    );

    // Load allowlist — if file exists, only allowed plugins are loaded
    const allowlist = loadAllowedPlugins();
    if (allowlist) {
      logger.info('PLUGINS', `Plugin allowlist active: ${allowlist.size} allowed plugin(s)`);
    }

    for (const file of pluginFiles) {
      try {
        // Allowlist check: if allowlist exists, skip plugins not in it
        if (allowlist && !allowlist.has(file)) {
          logger.warn('PLUGINS', `Skipping ${file}: not in allowed-plugins.json allowlist`);
          continue;
        }

        const modulePath = join(pluginsDir, file);
        // Use pathToFileURL for correct cross-platform URL encoding
        const { pathToFileURL } = await import('url');
        const moduleUrl = pathToFileURL(modulePath).href;
        const mod = await import(moduleUrl);
        const plugin: FlashPlugin | undefined = mod.default ?? mod.plugin;

        if (!plugin || !plugin.name) {
          logger.debug('PLUGINS', `Skipping ${file}: no valid FlashPlugin export`);
          continue;
        }

        // Check for duplicate names
        if (loadedPlugins.some((p) => p.name === plugin.name)) {
          logger.warn('PLUGINS', `Duplicate plugin name: ${plugin.name} (skipping ${file})`);
          continue;
        }

        // Register tools (with try/catch to prevent bad plugin from crashing system)
        if (plugin.tools) {
          try {
            const tools = plugin.tools();
            for (const tool of tools) {
              allTools.push(tool);
            }
            logger.info('PLUGINS', `Loaded ${plugin.name}: ${tools.length} tool(s)`);
          } catch (toolError: unknown) {
            logger.warn('PLUGINS', `Plugin ${plugin.name} tools() threw: ${getErrorMessage(toolError)}`);
          }
        } else {
          logger.info('PLUGINS', `Loaded ${plugin.name} (no tools)`);
        }

        // Call onInit with timeout (5s)
        if (plugin.onInit) {
          try {
            await Promise.race([
              Promise.resolve(plugin.onInit(context)),
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error('onInit timed out')), PLUGIN_INIT_TIMEOUT_MS),
              ),
            ]);
          } catch (initError: unknown) {
            logger.warn('PLUGINS', `Plugin ${plugin.name} onInit failed: ${getErrorMessage(initError)}`);
          }
        }

        loadedPlugins.push(plugin);
      } catch (error: unknown) {
        logger.warn('PLUGINS', `Failed to load plugin ${file}: ${getErrorMessage(error)}`);
      }
    }
  } catch (error: unknown) {
    logger.debug('PLUGINS', `Plugin loading failed: ${getErrorMessage(error)}`);
  }

  if (loadedPlugins.length > 0) {
    logger.info('PLUGINS', `${loadedPlugins.length} plugin(s) loaded, ${allTools.length} tool(s) registered`);
  }

  return allTools;
}

/**
 * Call onShutdown on all loaded plugins.
 */
export async function shutdownPlugins(): Promise<void> {
  const logger = getLogger();
  for (const plugin of loadedPlugins) {
    if (plugin.onShutdown) {
      try {
        await plugin.onShutdown();
      } catch (error: unknown) {
        logger.debug('PLUGINS', `Shutdown error in ${plugin.name}: ${getErrorMessage(error)}`);
      }
    }
  }
}

/**
 * Get all currently loaded plugins.
 */
export function getLoadedPlugins(): readonly FlashPlugin[] {
  return loadedPlugins;
}
