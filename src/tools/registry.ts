import { ToolDefinition, ToolContext, ToolResult } from '../types/index.js';
import { getErrorMessage } from '../utils/retry.js';
import { getLogger } from '../utils/logger.js';
import { isProfilingEnabled, profileStart, profileEnd } from '../observability/profiler.js';

/**
 * Tool Registry — tools are registered by name and dispatched by the engine.
 * Tools are registered by name and dispatched by the engine.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private coreTools = new Set<string>();

  register(tool: ToolDefinition): void {
    // Prevent plugins from overriding core tools
    if (this.coreTools.has(tool.name)) {
      getLogger().warn('REGISTRY', `Blocked attempt to override core tool: ${tool.name}`);
      return;
    }
    this.tools.set(tool.name, tool);
  }

  /** Mark all currently registered tools as core (call after initial registration). */
  lockCore(): void {
    for (const name of this.tools.keys()) {
      this.coreTools.add(name);
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  async execute(toolName: string, params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        success: false,
        message: `Unknown tool: ${toolName}`,
      };
    }

    let validated: Record<string, unknown>;
    if (tool.parameters) {
      try {
        validated = tool.parameters.parse(params) as Record<string, unknown>;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid parameters';
        return { success: false, message: `  Parameter validation failed: ${msg}` };
      }
    } else {
      validated = params;
    }

    const t0 = isProfilingEnabled() ? profileStart('command', toolName) : 0;
    try {
      const result = await tool.execute(validated, context);
      if (t0 !== 0) profileEnd('command', t0, toolName);
      return result;
    } catch (error: unknown) {
      if (t0 !== 0) profileEnd('command', t0, toolName);
      return {
        success: false,
        message: `Tool ${toolName} failed: ${getErrorMessage(error)}`,
      };
    }
  }
}
