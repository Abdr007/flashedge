/**
 * Flash SDK — Error Types
 *
 * Typed exceptions for SDK consumers. Maps CLI error codes
 * to structured, catchable errors.
 */

import type { FlashErrorInfo } from './types.js';

/**
 * Base error class for all Flash SDK errors.
 * Contains structured error code, human message, and detail payload.
 */
export class FlashError extends Error {
  /** Machine-readable error code (e.g. 'INSUFFICIENT_BALANCE') */
  readonly code: string;
  /** Additional error context */
  readonly details: Record<string, unknown>;
  /** The raw command that was executed */
  readonly command?: string;

  constructor(code: string, message: string, details: Record<string, unknown> = {}, command?: string) {
    super(message);
    this.name = 'FlashError';
    this.code = code;
    this.details = details;
    this.command = command;
  }

  /** Create from a CLI JSON error response. */
  static fromErrorInfo(info: FlashErrorInfo, command?: string): FlashError {
    return new FlashError(info.code, info.message, info.details, command);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      command: this.command,
    };
  }
}

/**
 * Thrown when the CLI process times out.
 */
export class FlashTimeoutError extends FlashError {
  constructor(command: string, timeoutMs: number) {
    super('COMMAND_TIMEOUT', `Command timed out after ${timeoutMs}ms: ${command}`, { timeoutMs }, command);
    this.name = 'FlashTimeoutError';
  }
}

/**
 * Thrown when the CLI output is not valid JSON.
 */
export class FlashParseError extends FlashError {
  /** The raw stdout that failed to parse */
  readonly rawOutput: string;

  constructor(command: string, rawOutput: string) {
    super(
      'PARSE_ERROR',
      `Failed to parse CLI output as JSON for command: ${command}`,
      { rawOutputLength: rawOutput.length, rawOutputPreview: rawOutput.slice(0, 200) },
      command,
    );
    this.name = 'FlashParseError';
    this.rawOutput = rawOutput;
  }
}

/**
 * Thrown when the CLI process exits with a non-zero code.
 */
export class FlashProcessError extends FlashError {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(command: string, exitCode: number | null, stderr: string) {
    super(
      'PROCESS_ERROR',
      `CLI process failed (exit ${exitCode}): ${stderr.slice(0, 200) || 'unknown error'}`,
      { exitCode, stderr: stderr.slice(0, 1000) },
      command,
    );
    this.name = 'FlashProcessError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}
