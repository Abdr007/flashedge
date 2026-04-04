/**
 * Command Safety Guard
 *
 * Prevents destructive commands from executing via fuzzy matches or AI misinterpretation.
 * Protected commands require EXACT string match — no fuzzy, no AI, no typo correction.
 */

import { ActionType } from '../types/index.js';

/** Commands that must NEVER execute from fuzzy/AI matches. Exact input only. */
const PROTECTED_COMMANDS = new Set<string>([
  'exit',
  'quit',
  'wallet disconnect',
  'wallet remove',
  'wallet delete',
  'close all',
  'close-all',
  'closeall',
  'exit all',
]);

/** Actions that are destructive and should not come from AI interpretation. */
const PROTECTED_ACTIONS = new Set<ActionType>([
  ActionType.WalletDisconnect,
  ActionType.WalletRemove,
  ActionType.CloseAll,
]);

/**
 * Check if a parsed intent from the AI interpreter should be blocked.
 * Returns true if the intent is a protected action that was NOT typed exactly.
 */
export function shouldBlockAiIntent(originalInput: string, action: ActionType): boolean {
  if (!PROTECTED_ACTIONS.has(action)) return false;

  const lower = originalInput.toLowerCase().trim();

  // Allow if the user typed the exact command
  if (PROTECTED_COMMANDS.has(lower)) return false;

  // Block — the AI inferred a destructive action from a non-exact input
  return true;
}

/**
 * Check if an input is a known protected command (exact match).
 */
export function isProtectedCommand(input: string): boolean {
  return PROTECTED_COMMANDS.has(input.toLowerCase().trim());
}

/**
 * Get a "did you mean" suggestion for a near-miss command.
 * Only suggests for very close matches (edit distance 1-2).
 */
export function getSafeCommandSuggestion(input: string): string | null {
  const lower = input.toLowerCase().trim();

  // Common near-misses for protected commands
  const suggestions: Record<string, string[]> = {
    exit: ['eexit', 'exiit', 'exitt', 'exi', 'exot', 'exir'],
    quit: ['quiit', 'qut', 'quitt', 'qit'],
    'close all': ['clsoe all', 'colse all', 'closee all', 'close al'],
    'wallet disconnect': ['wallet disconect', 'walet disconnect', 'wallet disconnet'],
  };

  for (const [correct, typos] of Object.entries(suggestions)) {
    if (typos.includes(lower)) return correct;
  }

  // Generic edit-distance check for short commands
  for (const cmd of PROTECTED_COMMANDS) {
    if (Math.abs(cmd.length - lower.length) <= 2 && editDist(lower, cmd) <= 2) {
      return cmd;
    }
  }

  return null;
}

function editDist(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 4;
  const m: number[][] = [];
  for (let i = 0; i <= a.length; i++) m[i] = [i];
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + c);
    }
  return m[a.length][b.length];
}
