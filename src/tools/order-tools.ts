import { z } from 'zod';
import { ToolDefinition, ToolContext, ToolResult, TradeSide } from '../types/index.js';
import { colorPnl, colorSide } from '../utils/format.js';
import { getErrorMessage } from '../utils/retry.js';
import chalk from 'chalk';
import { theme } from '../cli/theme.js';

// ─── close_all ────────────────────────────────────────────────────────────────

export const flashCloseAll: ToolDefinition = {
  name: 'flash_close_all',
  description: 'Close all open positions sequentially',
  parameters: z.object({}),
  execute: async (_params, context): Promise<ToolResult> => {
    try {
      const positions = await context.flashClient.getPositions();
      if (positions.length === 0) {
        return { success: true, message: chalk.yellow('  No open positions to close.') };
      }

      const lines: string[] = [
        '',
        `  ${theme.accentBold('CLOSE ALL POSITIONS')}  ${theme.dim(`(${positions.length} position${positions.length > 1 ? 's' : ''})`)}`,
        '',
      ];

      let closed = 0;
      let totalPnl = 0;
      const errors: string[] = [];

      for (const pos of positions) {
        try {
          const result = await context.flashClient.closePosition(pos.market, pos.side as TradeSide);
          closed++;
          const pnl = result.pnl ?? 0;
          totalPnl += pnl;
          lines.push(`  ${chalk.green('✓')} ${pos.market} ${colorSide(pos.side)} — PnL: ${colorPnl(pnl)}`);
        } catch (err: unknown) {
          errors.push(`${pos.market} ${pos.side}: ${getErrorMessage(err)}`);
          lines.push(`  ${chalk.red('✗')} ${pos.market} ${colorSide(pos.side)} — ${chalk.red(getErrorMessage(err))}`);
        }
      }

      lines.push('');
      lines.push(`  ${theme.dim('─'.repeat(40))}`);
      lines.push(`  Closed: ${chalk.bold(String(closed))}/${positions.length}  |  Total PnL: ${colorPnl(totalPnl)}`);
      if (errors.length > 0) {
        lines.push(`  ${chalk.red(`${errors.length} failed`)}`);
      }
      lines.push('');

      return { success: errors.length === 0, message: lines.join('\n') };
    } catch (err: unknown) {
      return { success: false, message: chalk.red(`  Failed to close all: ${getErrorMessage(err)}`) };
    }
  },
};

// ─── TP/SL Tools (On-Chain via Flash SDK) ─────────────────────────────────────

export const setTpSlTool: ToolDefinition = {
  name: 'set_tp_sl',
  description: 'Set take-profit or stop-loss for a position (on-chain)',
  parameters: z.object({
    market: z.string(),
    side: z.nativeEnum(TradeSide),
    type: z.enum(['tp', 'sl']),
    price: z.number().positive(),
  }),
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { market, side, type, price } = params as {
      market: string;
      side: TradeSide;
      type: 'tp' | 'sl';
      price: number;
    };

    if (context.simulationMode) {
      return {
        success: false,
        message:
          '  On-chain TP/SL requires live mode. TP/SL orders are placed on the Flash Trade protocol and require a real wallet.',
      };
    }

    const client = context.flashClient;
    if (!client.placeTriggerOrder) {
      return { success: false, message: '  TP/SL orders are not supported by the current client.' };
    }

    try {
      const isStopLoss = type === 'sl';
      const result = await client.placeTriggerOrder(market, side, price, isStopLoss);
      const label = isStopLoss ? 'Stop-Loss' : 'Take-Profit';
      const txLink = `https://solscan.io/tx/${result.txSignature}`;
      return {
        success: true,
        message: [
          '',
          chalk.green(`  ${label} Set (On-Chain)`),
          chalk.dim('  ─────────────────'),
          `  Market:    ${result.market} ${result.side.toUpperCase()}`,
          `  Price:     $${price.toFixed(2)}`,
          chalk.dim(`  TX: ${txLink}`),
          '',
        ].join('\n'),
      };
    } catch (err: unknown) {
      return { success: false, message: `  Failed to set ${type.toUpperCase()}: ${getErrorMessage(err)}` };
    }
  },
};

export const removeTpSlTool: ToolDefinition = {
  name: 'remove_tp_sl',
  description: 'Remove take-profit or stop-loss from a position (on-chain)',
  parameters: z.object({
    market: z.string(),
    side: z.nativeEnum(TradeSide),
    type: z.enum(['tp', 'sl']),
  }),
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { market, side, type } = params as {
      market: string;
      side: TradeSide;
      type: 'tp' | 'sl';
    };

    if (context.simulationMode) {
      return {
        success: false,
        message: '  On-chain TP/SL requires live mode.',
      };
    }

    const client = context.flashClient;
    if (!client.getUserOrders || !client.cancelTriggerOrder) {
      return { success: false, message: '  Cancel trigger orders not supported by the current client.' };
    }

    try {
      const isStopLoss = type === 'sl';
      // Find the order to cancel
      const orders = await client.getUserOrders();
      const targetType = isStopLoss ? 'stop_loss' : 'take_profit';
      const order = orders.find((o) => o.market === market.toUpperCase() && o.side === side && o.type === targetType);
      if (!order) {
        return { success: false, message: `  No ${type.toUpperCase()} order found for ${market} ${side}.` };
      }

      const result = await client.cancelTriggerOrder(market, side, order.orderId, isStopLoss);
      const label = isStopLoss ? 'Stop-Loss' : 'Take-Profit';
      const txLink = `https://solscan.io/tx/${result.txSignature}`;
      return {
        success: true,
        message: ['', chalk.green(`  ${label} Removed (On-Chain)`), chalk.dim(`  TX: ${txLink}`), ''].join('\n'),
      };
    } catch (err: unknown) {
      return { success: false, message: `  Failed to remove ${type.toUpperCase()}: ${getErrorMessage(err)}` };
    }
  },
};

export const tpSlStatusTool: ToolDefinition = {
  name: 'tp_sl_status',
  description: 'Show all active TP/SL targets (on-chain)',
  parameters: z.object({}),
  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (context.simulationMode) {
      return {
        success: true,
        message: [
          '',
          chalk.dim('  On-chain TP/SL requires live mode.'),
          chalk.dim('  In simulation, TP/SL orders are not available.'),
          '',
        ].join('\n'),
      };
    }

    const client = context.flashClient;
    if (!client.getUserOrders) {
      return { success: false, message: '  Order fetching not supported by the current client.' };
    }

    try {
      const orders = await client.getUserOrders();
      const triggerOrders = orders.filter((o) => o.type === 'take_profit' || o.type === 'stop_loss');

      if (triggerOrders.length === 0) {
        return {
          success: true,
          message: [
            '',
            chalk.dim('  No active TP/SL targets on-chain.'),
            chalk.dim('  Use "set tp <market> <side> $<price>" to add one.'),
            '',
          ].join('\n'),
        };
      }

      const lines = [theme.titleBlock('ON-CHAIN TP/SL TARGETS'), ''];

      // Group by market-side
      const grouped = new Map<string, typeof triggerOrders>();
      for (const o of triggerOrders) {
        const key = `${o.market}-${o.side}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(o);
      }

      for (const [key, ords] of grouped) {
        const [market, side] = key.split('-');
        const tp = ords.find((o) => o.type === 'take_profit');
        const sl = ords.find((o) => o.type === 'stop_loss');
        const tpStr = tp ? `TP: $${tp.price.toFixed(2)}` : chalk.dim('TP: —');
        const slStr = sl ? `SL: $${sl.price.toFixed(2)}` : chalk.dim('SL: —');
        lines.push(`  ${chalk.bold(`${market} ${side!.toUpperCase()}`)}`);
        lines.push(`    ${tpStr}  |  ${slStr}`);
        lines.push('');
      }

      return { success: true, message: lines.join('\n') };
    } catch (err: unknown) {
      return { success: false, message: `  Failed to fetch TP/SL targets: ${getErrorMessage(err)}` };
    }
  },
};

// ─── Limit Order Tools (On-Chain via Flash SDK) ─────────────────────────────

export const limitOrderPlaceTool: ToolDefinition = {
  name: 'limit_order_place',
  description: 'Place a limit order (on-chain)',
  parameters: z.object({
    market: z.string(),
    side: z.nativeEnum(TradeSide),
    leverage: z.number().min(1).max(100),
    collateral: z.number().positive(),
    limitPrice: z.number().positive(),
  }),
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { market, side, leverage, collateral, limitPrice } = params as {
      market: string;
      side: TradeSide;
      leverage: number;
      collateral: number;
      limitPrice: number;
    };

    if (context.simulationMode) {
      return {
        success: false,
        message:
          '  Limit orders are simulated locally in simulation mode.\n' +
          '  On-chain limit orders require live mode with a connected wallet.\n' +
          chalk.dim('  Switch to live mode with "wallet connect <path>" to place on-chain limit orders.'),
      };
    }

    const client = context.flashClient;
    if (!client.placeLimitOrder) {
      return { success: false, message: '  Limit orders are not supported by the current client.' };
    }

    try {
      const result = await client.placeLimitOrder(market, side, collateral, leverage, limitPrice);
      const txLink = `https://solscan.io/tx/${result.txSignature}`;
      return {
        success: true,
        message: [
          '',
          chalk.green('  Limit Order Placed (On-Chain)'),
          chalk.dim('  ─────────────────────────────'),
          `  Market:       ${result.market} ${result.side.toUpperCase()}`,
          `  Leverage:     ${leverage}x`,
          `  Collateral:   $${collateral.toFixed(2)}`,
          `  Size:         $${result.sizeUsd.toFixed(2)}`,
          `  Limit Price:  $${limitPrice.toFixed(2)}`,
          chalk.dim(`  TX: ${txLink}`),
          '',
          chalk.dim('  This order is on-chain and visible on flash.trade'),
          '',
        ].join('\n'),
      };
    } catch (err: unknown) {
      const errMsg = getErrorMessage(err);
      // Custom:2003 = ConstraintRaw on oracle account — oracle price update may have failed
      if (errMsg.includes('2003') || errMsg.includes('ConstraintRaw') || errMsg.includes('InvalidArgument')) {
        return {
          success: false,
          message: [
            '',
            chalk.red('  Limit order failed: oracle price update rejected.'),
            '',
            chalk.dim('  The on-chain oracle data could not be refreshed.'),
            chalk.dim('  This may be a temporary issue — try again in a few seconds.'),
            '',
            chalk.dim('  If the issue persists, use "open" for market orders.'),
            '',
          ].join('\n'),
        };
      }
      return { success: false, message: `  Failed to place limit order: ${errMsg}` };
    }
  },
};

export const limitOrderCancelTool: ToolDefinition = {
  name: 'limit_order_cancel',
  description: 'Cancel a limit order (on-chain)',
  parameters: z.object({
    orderId: z.string(),
    market: z.string().optional(),
    side: z.nativeEnum(TradeSide).optional(),
  }),
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { orderId, market, side } = params as {
      orderId: string;
      market?: string;
      side?: TradeSide;
    };

    if (context.simulationMode) {
      return { success: false, message: '  On-chain limit orders require live mode.' };
    }

    const client = context.flashClient;
    if (!client.cancelLimitOrder || !client.getUserOrders) {
      return { success: false, message: '  Cancel limit orders not supported by the current client.' };
    }

    try {
      // Parse orderId — accept "order-1", "1", "#1", etc.
      const idNum = parseInt(orderId.replace(/[^0-9]/g, ''), 10);
      if (!Number.isFinite(idNum) || idNum < 0) {
        return { success: false, message: `  Invalid order ID: ${orderId}` };
      }

      // If market/side not provided, find from orders
      let cancelMarket = market;
      let cancelSide = side;
      if (!cancelMarket || !cancelSide) {
        const orders = await client.getUserOrders();
        const limitOrders = orders.filter((o) => o.type === 'limit');
        // Find by orderId across all markets
        const target = limitOrders.find((o) => o.orderId === idNum);
        if (!target) {
          return { success: false, message: `  Limit order #${idNum} not found. Use "orders" to see active orders.` };
        }
        cancelMarket = target.market;
        cancelSide = target.side;
      }

      const result = await client.cancelLimitOrder(cancelMarket, cancelSide, idNum);
      const txLink = `https://solscan.io/tx/${result.txSignature}`;
      return {
        success: true,
        message: ['', chalk.green(`  Limit Order #${idNum} Cancelled`), chalk.dim(`  TX: ${txLink}`), ''].join('\n'),
      };
    } catch (err: unknown) {
      return { success: false, message: `  Failed to cancel limit order: ${getErrorMessage(err)}` };
    }
  },
};

export const limitOrderEditTool: ToolDefinition = {
  name: 'limit_order_edit',
  description: 'Edit a limit order price (on-chain)',
  parameters: z.object({
    orderId: z.number().int().min(0),
    market: z.string(),
    side: z.nativeEnum(TradeSide),
    limitPrice: z.number().positive().optional(),
  }),
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { orderId, market, side, limitPrice } = params as {
      orderId: number;
      market: string;
      side: TradeSide;
      limitPrice?: number;
    };

    if (context.simulationMode) {
      return { success: false, message: '  On-chain limit orders require live mode.' };
    }

    if (!limitPrice) {
      return { success: false, message: '  New limit price is required.' };
    }

    const client = context.flashClient;
    if (!client.editLimitOrder) {
      return { success: false, message: '  Edit limit order not supported by the current client.' };
    }

    try {
      const result = await client.editLimitOrder(market, side, orderId, limitPrice);
      const txLink = `https://solscan.io/tx/${result.txSignature}`;
      return {
        success: true,
        message: [
          '',
          chalk.green(`  Limit Order #${orderId} Updated`),
          `  New Price: $${limitPrice.toFixed(2)}`,
          chalk.dim(`  TX: ${txLink}`),
          '',
        ].join('\n'),
      };
    } catch (err: unknown) {
      return { success: false, message: `  Failed to edit limit order: ${getErrorMessage(err)}` };
    }
  },
};

export const limitOrderListTool: ToolDefinition = {
  name: 'limit_order_list',
  description: 'List all active orders (on-chain)',
  parameters: z.object({}),
  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (context.simulationMode) {
      return {
        success: true,
        message: [
          '',
          chalk.dim('  On-chain orders require live mode.'),
          chalk.dim('  Orders are placed on the Flash Trade protocol.'),
          '',
        ].join('\n'),
      };
    }

    const client = context.flashClient;
    if (!client.getUserOrders) {
      return { success: false, message: '  Order fetching not supported by the current client.' };
    }

    try {
      const orders = await client.getUserOrders();

      if (orders.length === 0) {
        return {
          success: true,
          message: [
            '',
            chalk.dim('  No active orders on-chain.'),
            chalk.dim('  Use "limit <long|short> <market> <lev>x $<collateral> @ $<price>" to place one.'),
            '',
          ].join('\n'),
        };
      }

      const lines = [theme.titleBlock('ON-CHAIN ORDERS'), ''];

      // Separate by type
      const limitOrders = orders.filter((o) => o.type === 'limit');
      const tpOrders = orders.filter((o) => o.type === 'take_profit');
      const slOrders = orders.filter((o) => o.type === 'stop_loss');

      if (limitOrders.length > 0) {
        lines.push(`  ${chalk.bold('Limit Orders')}`);
        for (const o of limitOrders) {
          lines.push(`    #${o.orderId}  ${o.market} ${o.side.toUpperCase()}  @ $${o.price.toFixed(2)}`);
        }
        lines.push('');
      }

      if (tpOrders.length > 0 || slOrders.length > 0) {
        lines.push(`  ${chalk.bold('Trigger Orders (TP/SL)')}`);
        for (const o of [...tpOrders, ...slOrders]) {
          const label = o.type === 'take_profit' ? chalk.green('TP') : chalk.red('SL');
          lines.push(`    #${o.orderId}  ${o.market} ${o.side.toUpperCase()}  ${label} @ $${o.price.toFixed(2)}`);
        }
        lines.push('');
      }

      lines.push(chalk.dim('  Orders are on-chain and visible on flash.trade'));
      lines.push('');

      return { success: true, message: lines.join('\n') };
    } catch (err: unknown) {
      return { success: false, message: `  Failed to fetch orders: ${getErrorMessage(err)}` };
    }
  },
};

export const allOrderTools: ToolDefinition[] = [
  flashCloseAll,
  setTpSlTool,
  removeTpSlTool,
  tpSlStatusTool,
  limitOrderPlaceTool,
  limitOrderCancelTool,
  limitOrderEditTool,
  limitOrderListTool,
];
