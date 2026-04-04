import { appendFile, appendFileSync, mkdirSync, existsSync, writeFileSync, chmodSync, statSync, renameSync } from 'fs';
import { dirname, resolve } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';

const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024; // 10MB max before rotation

/** Background categories whose errors should NOT interrupt the interactive prompt.
 *  These are logged to file only — not printed to console. */
const BACKGROUND_CATEGORIES = new Set(['HEALTH', 'RETRY', 'MEMORY', 'ORACLE', 'MAINTENANCE', 'RECONCILER']);

export type LogFormat = 'text' | 'json';

export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.Debug]: 'DEBUG',
  [LogLevel.Info]: 'INFO',
  [LogLevel.Warn]: 'WARN',
  [LogLevel.Error]: 'ERROR',
};

const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  [LogLevel.Debug]: chalk.gray,
  [LogLevel.Info]: chalk.cyan,
  [LogLevel.Warn]: chalk.yellow,
  [LogLevel.Error]: chalk.red,
};

export class Logger {
  private level: LogLevel;
  private logFilePath: string | null;
  private showInCli: boolean;
  private format: LogFormat;

  /** Consecutive file write failures — triggers console fallback */
  private writeFailures = 0;
  private static readonly MAX_WRITE_FAILURES = 5;
  /** Whether we've already warned about file write issues */
  private writeFailureWarned = false;

  /** Correlation ID for the current request/command. */
  private static _requestId: string | null = null;

  static setRequestId(id: string): void {
    Logger._requestId = id;
  }
  static clearRequestId(): void {
    Logger._requestId = null;
  }
  static get requestId(): string | null {
    return Logger._requestId;
  }

  constructor(opts?: { level?: LogLevel; logFile?: string; showInCli?: boolean; format?: LogFormat }) {
    this.level = opts?.level ?? LogLevel.Info;
    this.logFilePath = opts?.logFile ?? null;
    this.showInCli = opts?.showInCli ?? false;
    this.format = opts?.format ?? 'text';

    if (this.logFilePath) {
      // Validate log file path — must be under home directory to prevent arbitrary writes
      const resolvedPath = resolve(this.logFilePath);
      const home = homedir();
      const homePrefix = home.endsWith('/') ? home : home + '/';
      if (resolvedPath !== home && !resolvedPath.startsWith(homePrefix)) {
        this.logFilePath = null; // Reject paths outside home directory
      }
    }

    if (this.logFilePath) {
      const dir = dirname(this.logFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      // Create file with restricted permissions (owner-only read/write)
      if (!existsSync(this.logFilePath)) {
        writeFileSync(this.logFilePath, '', { mode: 0o600 });
      }
      try {
        chmodSync(this.logFilePath, 0o600);
      } catch {
        // Best-effort permission setting
      }
    }
  }

  debug(category: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Debug, category, message, data);
  }

  info(category: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Info, category, message, data);
  }

  warn(category: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Warn, category, message, data);
  }

  error(category: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Error, category, message, data);
  }

  trade(action: string, details: Record<string, unknown>): void {
    this.info('TRADE', `${action}`, details);
  }

  tradeStructured(
    action: string,
    details: {
      market?: string;
      side?: string;
      leverage?: number;
      collateral?: number;
      sizeUsd?: number;
      txSignature?: string;
      latencyMs?: number;
      error?: string;
    },
  ): void {
    this.info('TRADE', action, details as Record<string, unknown>);
  }

  api(endpoint: string, details?: Record<string, unknown>): void {
    this.debug('API', endpoint, details);
  }

  private log(level: LogLevel, category: string, message: string, data?: Record<string, unknown>): void {
    if (level < this.level) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      data,
    };

    // Write to file (or fallback to console if file writes are failing)
    if (this.logFilePath && this.writeFailures < Logger.MAX_WRITE_FAILURES) {
      this.writeToFile(entry);
    } else if (this.logFilePath && this.writeFailures >= Logger.MAX_WRITE_FAILURES && level >= LogLevel.Warn) {
      // File broken — fallback important messages to console
      this.writeToConsole(entry);
    }

    // Show in CLI only if explicitly enabled (showInCli) or for user-facing errors.
    // Suppress noisy background categories (HEALTH, RETRY, MEMORY, ORACLE) from the
    // interactive prompt — they are still written to the log file.
    if (this.showInCli) {
      this.writeToConsole(entry);
    } else if (level >= LogLevel.Error) {
      const bg = BACKGROUND_CATEGORIES.has(entry.category);
      if (!bg) {
        this.writeToConsole(entry);
      }
    }
  }

  /** Scrub sensitive data from strings before writing to logs. */
  private scrub(text: string): string {
    return (
      text
        .replace(/api[_-]?key=[^&\s"]+/gi, 'api_key=***')
        .replace(/sk-ant-[^\s"]+/g, 'sk-ant-***')
        .replace(/gsk_[^\s"]+/g, 'gsk_***')
        // [L-12] Mask base58 private keys (64-88 chars of base58 alphabet)
        .replace(/[1-9A-HJ-NP-Za-km-z]{64,88}/g, (m) => m.slice(0, 8) + '***REDACTED***')
        // [F-10] Truncate full URLs to origin only — prevent leaking paths/tokens
        .replace(/https?:\/\/[^\s"']+/g, (url) => {
          try { return new URL(url).origin + '/***'; } catch { return url; }
        })
    );
  }

  private logRotationChecked = 0;

  private writeToFile(entry: LogEntry): void {
    if (!this.logFilePath) return;

    let line: string;

    if (this.format === 'json') {
      const obj: Record<string, unknown> = {
        timestamp: entry.timestamp,
        level: LEVEL_LABELS[entry.level],
        module: entry.category,
        message: this.scrub(entry.message),
      };
      if (Logger._requestId) obj.request_id = Logger._requestId;
      if (entry.data) {
        try {
          obj.data = JSON.parse(this.scrub(JSON.stringify(entry.data)));
        } catch {
          obj.data = {};
        }
      }
      line = JSON.stringify(obj) + '\n';
    } else {
      const reqId = Logger._requestId ? ` [req:${Logger._requestId}]` : '';
      const dataStr = entry.data ? ` ${this.scrub(JSON.stringify(entry.data))}` : '';
      line = `[${entry.timestamp}] ${LEVEL_LABELS[entry.level]} [${entry.category}]${reqId} ${this.scrub(entry.message)}${dataStr}\n`;
    }

    // Check log size periodically (every ~100 writes) and rotate if needed
    if (++this.logRotationChecked % 100 === 0) {
      try {
        const size = statSync(this.logFilePath).size;
        if (size > MAX_LOG_FILE_BYTES) {
          const rotated = this.logFilePath + '.old';
          try {
            renameSync(rotated, rotated + '.2');
          } catch {
            /* ignore */
          }
          renameSync(this.logFilePath, rotated);
          writeFileSync(this.logFilePath, '', { mode: 0o600 });
        }
      } catch {
        /* best-effort rotation */
      }
    }

    appendFile(this.logFilePath, line, (err) => {
      if (err) {
        this.writeFailures++;
        if (!this.writeFailureWarned && this.writeFailures >= Logger.MAX_WRITE_FAILURES) {
          this.writeFailureWarned = true;
          // Fallback: write to stderr so the user knows logs are broken
          console.error(chalk.yellow(`  [WARN] Log file write failed ${this.writeFailures} times: ${err.code ?? err.message}. Falling back to console.`));
        }
      } else {
        // Reset failure counter on successful write
        if (this.writeFailures > 0) {
          this.writeFailures = 0;
          if (this.writeFailureWarned) {
            this.writeFailureWarned = false;
            console.error(chalk.green('  [INFO] Log file writes restored.'));
          }
        }
      }
    });
  }

  /**
   * Write a final log entry synchronously (for shutdown).
   * Ensures the entry is flushed to disk before process.exit().
   */
  flushSync(category: string, message: string, data?: Record<string, unknown>): void {
    if (!this.logFilePath) return;
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: LogLevel.Info,
      category,
      message,
      data,
    };
    const dataStr = entry.data ? ` ${this.scrub(JSON.stringify(entry.data))}` : '';
    const line = `[${entry.timestamp}] ${LEVEL_LABELS[entry.level]} [${entry.category}] ${this.scrub(entry.message)}${dataStr}\n`;
    try {
      appendFileSync(this.logFilePath, line);
    } catch {
      // Best-effort
    }
  }

  private writeToConsole(entry: LogEntry): void {
    const colorFn = LEVEL_COLORS[entry.level];
    const label = colorFn(`[${LEVEL_LABELS[entry.level]}]`);
    const cat = chalk.dim(`[${entry.category}]`);
    const msg = entry.level >= LogLevel.Error ? chalk.red(entry.message) : entry.message;
    console.error(`  ${label} ${cat} ${msg}`);
  }
}

/** Parse FLASH_LOG_LEVEL env var to LogLevel. */
export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value) return undefined;
  const map: Record<string, LogLevel> = {
    debug: LogLevel.Debug,
    info: LogLevel.Info,
    warn: LogLevel.Warn,
    error: LogLevel.Error,
  };
  return map[value.toLowerCase()];
}

/** Generate a short random request ID (8 hex chars). */
export function generateRequestId(): string {
  return Math.random().toString(16).slice(2, 10);
}

// Singleton logger instance
let _logger: Logger | null = null;

export function initLogger(opts?: {
  level?: LogLevel;
  logFile?: string;
  showInCli?: boolean;
  format?: LogFormat;
}): Logger {
  // FLASH_LOG_LEVEL env var — overrides default level unless explicitly provided
  const envLevel = parseLogLevel(process.env.FLASH_LOG_LEVEL);
  const envFormat = (process.env.FLASH_LOG_FORMAT?.toLowerCase() === 'json' ? 'json' : 'text') as LogFormat;
  const level = opts?.level ?? envLevel ?? LogLevel.Info;
  const format = opts?.format ?? envFormat;
  _logger = new Logger({ ...opts, level, format });
  return _logger;
}

export function getLogger(): Logger {
  if (!_logger) {
    const envLevel = parseLogLevel(process.env.FLASH_LOG_LEVEL);
    _logger = new Logger({ level: envLevel ?? LogLevel.Info });
  }
  return _logger;
}
