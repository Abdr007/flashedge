import * as readline from 'readline';
import { ToolEngine } from '../tools/engine.js';
import { ParsedIntent, ToolResult } from '../types/index.js';
import { getErrorMessage } from '../utils/retry.js';
import { theme } from './theme.js';
import { TermRenderer } from './renderer.js';

// ─── Watch Mode ─────────────────────────────────────────────────────────────
//
// Repeatedly executes a read-only CLI command and refreshes the output,
// similar to the Linux `watch` utility.
//
// Design constraints:
//   • Read-only — trading commands are rejected before execution
//   • Diff-based rendering — only changed lines are updated
//   • Complete input isolation — readline is paused, stdin is in raw mode
//   • Cleans up timers and raw mode on exit
//   • Does not modify any other subsystem

const REFRESH_INTERVAL_MS = 5_000;

/** Commands that mutate state — blocked in watch mode */
const BLOCKED_PREFIXES = [
  'open',
  'close',
  'add',
  'remove',
  'wallet import',
  'wallet connect',
  'wallet disconnect',
  'wallet use',
  'wallet remove',
  'dryrun',
  'dry-run',
  'dry run',
  'doctor',
  'watch',
];

/**
 * Returns an error string if the command is blocked, or null if allowed.
 */
function validateWatchCommand(command: string): string | null {
  const lower = command.toLowerCase().trim();

  for (const prefix of BLOCKED_PREFIXES) {
    if (lower === prefix || lower.startsWith(prefix + ' ')) {
      return 'watch does not support trading commands.';
    }
  }

  return null;
}

export interface WatchDeps {
  engine: ToolEngine;
  parseCommand: (input: string) => Promise<ParsedIntent>;
  rl: readline.Interface;
}

/**
 * Start watch mode — repeatedly runs a read-only command every 5 seconds.
 * Resolves when the user presses 'q' to exit.
 *
 * Input isolation: readline is paused BEFORE any rendering begins.
 * All keyboard input goes through raw mode handler only.
 */
export async function startWatch(command: string, deps: WatchDeps): Promise<void> {
  // ─── Validate command ──────────────────────────────────────────
  const blockReason = validateWatchCommand(command);
  if (blockReason) {
    console.log('');
    console.log(theme.negative(`  Error: ${blockReason}`));
    console.log('');
    return;
  }

  // ─── Parse the inner command once to verify it's valid ─────────
  let intent: ParsedIntent;
  try {
    intent = await deps.parseCommand(command);
  } catch (err) {
    console.log(theme.negative(`  Error parsing command: ${getErrorMessage(err)}`));
    return;
  }

  // ─── ISOLATE INPUT BEFORE ANY RENDERING ─────────────────────────
  // Critical: pause readline FIRST to prevent any keystrokes from
  // reaching the readline buffer while watch mode is active.
  deps.rl.pause();

  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // ─── State ─────────────────────────────────────────────────────
  let running = true;
  let refreshing = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  const renderer = new TermRenderer();

  const restoreTerminal = () => {
    running = false;
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw ?? false);
    }
    process.stdin.pause();
    process.stdin.resume();
    renderer.clear();
    renderer.reset();
    deps.rl.resume();
  };

  try {
    const buildHeader = (): string[] => {
      const now = new Date().toLocaleTimeString();
      return [
        '',
        `  ${theme.accentBold('WATCH MODE')}`,
        theme.dim(
          `  ${now}  |  Watching: ${theme.value(command)}  |  Refresh ${REFRESH_INTERVAL_MS / 1000}s  |  Press ${theme.value('q')} to exit`,
        ),
        `  ${theme.separator(Math.min(process.stdout.columns || 80, 80))}`,
      ];
    };

    const fetchOutput = async (): Promise<string> => {
      // Re-parse each refresh so data is fresh
      let freshIntent: ParsedIntent;
      try {
        freshIntent = await deps.parseCommand(command);
      } catch {
        freshIntent = intent;
      }

      const result: ToolResult = await deps.engine.dispatch(freshIntent);
      return result.message;
    };

    const render = async () => {
      if (!running || refreshing) return;
      refreshing = true;

      try {
        const output = await fetchOutput();
        const headerLines = buildHeader();
        const outputLines = output.split('\n');
        const frame = [...headerLines, ...outputLines, ''];

        // Only update if frame content changed
        if (renderer.hasChanged(frame)) {
          renderer.render(frame);
        }
      } catch (err) {
        const headerLines = buildHeader();
        const errLines = [...headerLines, '', theme.negative(`  Refresh error: ${getErrorMessage(err)}`), ''];
        renderer.render(errLines);
      } finally {
        refreshing = false;
      }
    };

    // ─── Initial render ────────────────────────────────────────────
    renderer.clear();
    await render();

    // ─── Refresh interval ─────────────────────────────────────────
    interval = setInterval(() => {
      if (running && !refreshing) {
        render().catch(() => {});
      }
    }, REFRESH_INTERVAL_MS);
    interval.unref();

    // ─── Key listener — exit on 'q' ───────────────────────────────
    await new Promise<void>((resolve) => {
      const onKey = (data: Buffer) => {
        const key = data.toString();

        // Exit on 'q', 'Q', or Ctrl+C (0x03)
        if (key === 'q' || key === 'Q' || key === '\x03') {
          // Remove listener FIRST to prevent double-fire
          process.stdin.removeListener('data', onKey);
          restoreTerminal();
          resolve();
        }
        // All other keys are silently consumed — they never reach readline
      };

      process.stdin.on('data', onKey);
    });
  } finally {
    // Ensure terminal state is always restored even if an error escapes
    if (running) {
      restoreTerminal();
    }
  }
}
