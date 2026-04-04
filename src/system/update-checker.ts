/**
 * Silent, non-spammy startup version check.
 *
 * Rules:
 * - Runs ONCE per session, 15 seconds after startup (non-blocking)
 * - Shows notification ONLY when a new version is available
 * - Never shows the same version notification twice (persisted to disk)
 * - Never blocks the event loop or user input
 * - Never crashes the terminal on failure
 * - No retry — if check fails, silently skip
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { getLogger } from '../utils/logger.js';
import { BUILD_INFO } from '../build-info.js';

const STATE_DIR = join(homedir(), '.flash');
const STATE_FILE = join(STATE_DIR, 'update-state.json');
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/bolt-terminal/latest';
const CHECK_TIMEOUT_MS = 8_000;

/** Minimum interval between checks (24 hours). Prevents re-checking on rapid restarts. */
const MIN_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface UpdateState {
  lastNotifiedVersion: string;
  lastCheckTimestamp: number;
}

function loadState(): UpdateState {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = readFileSync(STATE_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (
        typeof data.lastNotifiedVersion === 'string' &&
        typeof data.lastCheckTimestamp === 'number'
      ) {
        return data as UpdateState;
      }
    }
  } catch {
    // Corrupted state file — start fresh
  }
  return { lastNotifiedVersion: '', lastCheckTimestamp: 0 };
}

function saveState(state: UpdateState): void {
  try {
    if (!existsSync(STATE_DIR)) {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    }
    writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
  } catch {
    // Non-critical — worst case is a duplicate notification next session
  }
}

/**
 * Compare two semver strings. Returns:
 *  1 if a > b, -1 if a < b, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/**
 * Validate npm registry response shape.
 * Rejects anything that doesn't look like a valid version response.
 */
function validateRegistryResponse(data: unknown): string | null {
  if (
    typeof data === 'object' &&
    data !== null &&
    'version' in data &&
    typeof (data as Record<string, unknown>).version === 'string'
  ) {
    const version = (data as Record<string, unknown>).version as string;
    // Must look like a semver: digits.digits.digits with optional pre-release
    if (/^\d+\.\d+\.\d+/.test(version)) {
      return version;
    }
  }
  return null;
}

/**
 * Run a silent, non-blocking version check.
 * Call this once during terminal startup (delayed by 15s).
 */
export async function silentVersionCheck(): Promise<void> {
  const logger = getLogger();

  try {
    const state = loadState();
    const now = Date.now();

    // Rate limit: don't check more than once per 24 hours
    if (now - state.lastCheckTimestamp < MIN_CHECK_INTERVAL_MS) {
      logger.debug('UPDATE', 'Skipping version check — checked recently');
      return;
    }

    const currentVersion = BUILD_INFO.version;

    // Fetch with timeout — non-blocking, fire-and-forget style
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(NPM_REGISTRY_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      // Package not published or registry issue — silently skip
      logger.debug('UPDATE', `Registry returned ${res.status}`);
      saveState({ ...state, lastCheckTimestamp: now });
      return;
    }

    // Response size guard: reject responses > 50KB (npm metadata is typically ~2KB)
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > 50_000) {
      logger.debug('UPDATE', 'Registry response too large, skipping');
      return;
    }

    const body = await res.json();
    const latestVersion = validateRegistryResponse(body);

    if (!latestVersion) {
      logger.debug('UPDATE', 'Invalid registry response shape');
      saveState({ ...state, lastCheckTimestamp: now });
      return;
    }

    // Update check timestamp
    state.lastCheckTimestamp = now;

    // Compare versions
    if (compareSemver(latestVersion, currentVersion) <= 0) {
      // Already up to date
      saveState(state);
      return;
    }

    // New version available — but have we already notified about this one?
    if (state.lastNotifiedVersion === latestVersion) {
      // Already notified in a previous session — stay silent
      saveState(state);
      return;
    }

    // Show notification ONCE
    console.log('');
    console.log(
      `  ${chalk.cyan('Update available:')} v${currentVersion} → ${chalk.green(`v${latestVersion}`)}`,
    );
    console.log(chalk.dim('  Run: npm update -g bolt-terminal'));
    console.log('');

    // Record that we notified about this version
    state.lastNotifiedVersion = latestVersion;
    saveState(state);
    logger.info('UPDATE', `Notified user: v${currentVersion} → v${latestVersion}`);
  } catch {
    // Silently swallow ALL errors — this must never break the terminal
    logger.debug('UPDATE', 'Version check failed (silently ignored)');
  }
}
