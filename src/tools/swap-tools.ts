import { z } from 'zod';
import { ToolDefinition, ToolResult } from '../types/index.js';
import { getErrorMessage } from '../utils/retry.js';
import chalk from 'chalk';
import { theme } from '../cli/theme.js';

// ─── swap ─────────────────────────────────────────────────────────────────────

export const swapTool: ToolDefinition = {
  name: 'flash_swap',
  description: 'Swap tokens via Flash Trade pools',
  parameters: z.object({
    inputToken: z.string().max(20),
    outputToken: z.string().max(20),
    amount: z.number().positive(),
  }),
  execute: async (params, context): Promise<ToolResult> => {
    const { inputToken, outputToken, amount } = params as {
      inputToken: string;
      outputToken: string;
      amount: number;
    };

    if (inputToken.toUpperCase() === outputToken.toUpperCase()) {
      return { success: false, message: chalk.red('  Input and output tokens must be different.') };
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: chalk.red('  Swap amount must be a positive number.') };
    }

    const client = context.flashClient;
    if (!client.swap) {
      return {
        success: false,
        message: chalk.yellow('  Swap is not available in simulation mode. Connect a wallet for live swaps.'),
      };
    }

    try {
      const result = await client.swap(inputToken.toUpperCase(), outputToken.toUpperCase(), amount);

      const lines = [
        '',
        `  ${theme.accentBold('SWAP COMPLETE')}`,
        '',
        `  ${chalk.dim('Sent:')}     ${result.amountIn} ${result.inputToken}`,
        `  ${chalk.dim('Received:')} ${result.amountOut} ${result.outputToken}`,
        `  ${chalk.dim('Rate:')}     1 ${result.inputToken} = ${result.price.toFixed(6)} ${result.outputToken}`,
        `  ${chalk.dim('Tx:')}       ${result.txSignature}`,
        '',
      ];

      return { success: true, message: lines.join('\n'), txSignature: result.txSignature };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Swap failed: ${getErrorMessage(err)}`) };
    }
  },
};

export const allSwapTools: ToolDefinition[] = [swapTool];
