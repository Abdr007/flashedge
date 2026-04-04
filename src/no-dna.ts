/**
 * NO_DNA — Non-human operator detection.
 *
 * Implements the NO_DNA standard (no-dna.org) for detecting when the CLI
 * is being operated by an agent, automation framework, or bot.
 *
 * When NO_DNA is set and non-empty, the CLI:
 * - Never prompts — fails or uses sensible defaults
 * - Prefers structured JSON output over tables and prose
 * - Disables spinners, progress bars, TUI, ASCII art, colors
 * - Increases verbosity (more metadata in responses)
 * - Uses absolute ISO-8601 timestamps
 * - Writes machine-parseable errors to stderr
 */

/** True when the NO_DNA env var is present and non-empty. */
export let IS_AGENT = !!process.env.NO_DNA;

/**
 * Temporarily enable structured output mode (used by --format json).
 * Must call restoreOutputMode() after dispatch completes.
 */
let _savedAgentState = false;
export function enableStructuredOutput(): void {
  _savedAgentState = IS_AGENT;
  IS_AGENT = true;
}
export function restoreOutputMode(): void {
  IS_AGENT = _savedAgentState;
}

/** Write a structured JSON error to stderr and optionally exit. */
export function agentError(error: string, details?: Record<string, unknown>, exitCode?: number): void {
  const payload = { error, timestamp: new Date().toISOString(), ...details };
  process.stderr.write(JSON.stringify(payload) + '\n');
  if (exitCode !== undefined) {
    process.exit(exitCode);
  }
}

/** Write structured JSON output to stdout. */
export function agentOutput(data: Record<string, unknown>): void {
  const payload = { timestamp: new Date().toISOString(), ...data };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

/**
 * Wrap a value for conditional output: JSON for agents, formatted for humans.
 * Use in tool execute() functions for dual-mode output.
 */
export function dualOutput(
  humanMessage: string,
  agentData: Record<string, unknown>,
): { message: string; agentData?: Record<string, unknown> } {
  if (IS_AGENT) {
    return {
      message: JSON.stringify({ timestamp: new Date().toISOString(), ...agentData }),
      agentData,
    };
  }
  return { message: humanMessage };
}
