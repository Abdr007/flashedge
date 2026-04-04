/**
 * Per-Command Help
 *
 * Provides detailed help for individual commands.
 * Usage: `help <command>` — e.g. `help open`, `help portfolio`
 */

import { COMMAND_REGISTRY, CommandEntry } from './command-registry.js';
import { theme } from './theme.js';
import { IS_AGENT } from '../no-dna.js';

// ─── Examples Map ────────────────────────────────────────────────────────────

const COMMAND_EXAMPLES: Record<string, string[]> = {
  open: ['open 5x long SOL $500', 'long sol 2x 10', 'short eth 3x 20'],
  close: ['close SOL long', 'close sol', 'close all'],
  'close all': ['close all'],
  positions: ['positions'],
  portfolio: ['portfolio', 'balance'],
  markets: ['markets'],
  analyze: ['analyze SOL', 'analyze BTC'],
  limit: ['limit long SOL 2x $100 @ $82', 'limit short ETH 3x $50 @ $4200'],
  'tp status': ['tp status', 'tpsl'],
  dryrun: ['dryrun open 5x long SOL $500', 'dryrun close SOL long'],
  wallet: ['wallet'],
  'wallet tokens': ['wallet tokens'],
  'wallet use': ['wallet use main', 'wallet use trading'],
  'wallet connect': ['wallet connect ~/my-keypair.json'],
  'wallet import': ['wallet import'],
  'wallet list': ['wallet list'],
  'wallet balance': ['wallet balance'],
  'wallet disconnect': ['wallet disconnect'],
  monitor: ['monitor'],
  'trade history': ['trade history', 'trades', 'journal'],
  volume: ['volume'],
  'open interest': ['open interest', 'oi'],
  leaderboard: ['leaderboard'],
  'whale activity': ['whale activity', 'whales'],
  fees: ['fees'],
  liquidations: ['liquidations SOL', 'liquidations BTC'],
  funding: ['funding SOL', 'funding ETH'],
  depth: ['depth SOL', 'depth BTC'],
  'protocol health': ['protocol health'],
  dashboard: ['dashboard', 'dash'],
  'risk report': ['risk report', 'risk'],
  exposure: ['exposure'],
  rebalance: ['rebalance'],
  'inspect protocol': ['inspect protocol', 'inspect'],
  'inspect pool': ['inspect pool crypto', 'inspect pool governance'],
  'inspect market': ['inspect market SOL', 'inspect market BTC'],
  add: ['add $200 to SOL long', 'add $50 to ETH short'],
  remove: ['remove $100 from ETH long', 'remove $50 from SOL short'],
  orders: ['orders'],
  'cancel order': ['cancel order 1'],
  'edit limit': ['edit limit 1 $85'],
  swap: ['swap SOL USDC $10'],
  'rpc status': ['rpc status'],
  'rpc test': ['rpc test'],
  doctor: ['doctor'],
  'engine status': ['engine status', 'engine'],
  'tx metrics': ['tx metrics', 'tx stats'],
  'tx inspect': ['tx inspect <signature>'],
  'tx debug': ['tx debug <signature>'],
  'system status': ['system status'],
  'system audit': ['system audit'],
  'protocol status': ['protocol status'],
  degen: ['degen on', 'degen off'],
  earn: ['earn'],
  'earn add': ['earn add $100 crypto'],
  'earn remove': ['earn remove 50% crypto'],
  'earn stake': ['earn stake $200 governance'],
  'earn unstake': ['earn unstake 25% governance'],
  'earn claim': ['earn claim'],
  'source verify': ['source verify SOL', 'source verify BTC'],
  'protocol fees': ['protocol fees SOL'],
  'protocol verify': ['protocol verify'],
  'position debug': ['position debug SOL'],
  'benchmark engine': ['benchmark engine'],
};

// ─── Lookup ──────────────────────────────────────────────────────────────────

/**
 * Find a CommandEntry by name or alias (case-insensitive).
 */
function findCommand(query: string): CommandEntry | null {
  const q = query.toLowerCase().trim();
  for (const entry of COMMAND_REGISTRY) {
    if (entry.name.toLowerCase() === q) return entry;
    if (entry.aliases) {
      for (const alias of entry.aliases) {
        if (alias.toLowerCase() === q) return entry;
      }
    }
    if (entry.dispatchAliases) {
      for (const alias of entry.dispatchAliases) {
        if (alias.toLowerCase() === q) return entry;
      }
    }
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get detailed help for a single command.
 * Returns a formatted string (themed for human, JSON for agent), or null if not found.
 */
export function getCommandHelp(commandName: string): string | null {
  const entry = findCommand(commandName);
  if (!entry) return null;

  const syntax = entry.helpFormat || entry.name;
  const aliases = [...(entry.aliases || []), ...(entry.dispatchAliases || [])];
  const examples = COMMAND_EXAMPLES[entry.name] || [];

  // ── Agent mode: return JSON ──
  if (IS_AGENT) {
    const obj: Record<string, unknown> = {
      command: entry.name,
      syntax,
      description: entry.description,
      category: entry.category,
    };
    if (aliases.length > 0) obj.aliases = aliases;
    if (examples.length > 0) obj.examples = examples;
    return JSON.stringify(obj);
  }

  // ── Human mode: themed output ──
  const lines: string[] = ['', `  ${theme.accentBold(syntax)}`, `  ${theme.separator(40)}`, `  ${entry.description}`];

  if (aliases.length > 0) {
    lines.push(`  ${theme.dim('Aliases:')} ${theme.command(aliases.join(', '))}`);
  }

  if (examples.length > 0) {
    lines.push('');
    lines.push(`  ${theme.section('Examples:')}`);
    for (const ex of examples) {
      lines.push(`    ${theme.command(ex)}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
