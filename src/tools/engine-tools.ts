/**
 * Execution Engine Tools
 *
 * CLI tools for inspecting and benchmarking the RPC execution engine.
 * Display-only — never modifies trading logic.
 */

import chalk from 'chalk';
import { z } from 'zod';
import { ToolDefinition, ToolResult } from '../types/index.js';
import { theme } from '../cli/theme.js';
import { getRpcManagerInstance } from '../network/rpc-manager.js';

// ─── engine status ──────────────────────────────────────────────────────────

export const engineStatusTool: ToolDefinition = {
  name: 'engine_status',
  description: 'Show execution engine configuration',
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const lines = [
      '',
      `  ${theme.accentBold('EXECUTION ENGINE')}`,
      `  ${theme.separator(40)}`,
      '',
      `  ${theme.pair('Mode', theme.value('RPC'))}`,
    ];

    const rpcMgr = getRpcManagerInstance();
    if (rpcMgr) {
      lines.push(`  ${theme.pair('Endpoint', theme.dim(rpcMgr.activeEndpoint.label))}`);
    }

    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

// ─── engine benchmark ───────────────────────────────────────────────────────

export const engineBenchmarkTool: ToolDefinition = {
  name: 'engine_benchmark',
  description: 'Benchmark execution engine latency',
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const rpcMgr = getRpcManagerInstance();

    const lines = ['', `  ${theme.accentBold('ENGINE BENCHMARK')}`, `  ${theme.separator(40)}`, ''];

    if (rpcMgr) {
      try {
        const rpcLatency = await rpcMgr.measureLatency();
        lines.push(`  ${theme.pair('RPC latency', theme.value(`${rpcLatency}ms`))}`);
      } catch {
        lines.push(`  ${theme.pair('RPC latency', chalk.red('error'))}`);
      }
    } else {
      lines.push(`  ${theme.pair('RPC latency', chalk.dim('N/A (simulation mode)'))}`);
    }

    lines.push('');
    return { success: true, message: lines.join('\n') };
  },
};

export const allEngineTools: ToolDefinition[] = [engineStatusTool, engineBenchmarkTool];
