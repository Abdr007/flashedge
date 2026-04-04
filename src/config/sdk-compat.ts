/**
 * Flash SDK Compatibility Check
 *
 * Verifies the installed flash-sdk version is within the expected major range.
 * Called at startup to warn operators about potential incompatibilities.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/** Expected major version of flash-sdk */
const COMPATIBLE_MAJOR = 15;
const COMPATIBLE_SDK_RANGE = `>=${COMPATIBLE_MAJOR}.0.0 <${COMPATIBLE_MAJOR + 1}.0.0`;

export interface SdkCompatResult {
  compatible: boolean;
  installed: string;
  expected: string;
}

/**
 * Check whether the installed flash-sdk version is compatible.
 * Uses major-version matching only (no semver dependency).
 */
export function checkSdkCompatibility(): SdkCompatResult {
  const expected = COMPATIBLE_SDK_RANGE;
  let installed = 'unknown';

  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('flash-sdk/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    installed = pkg.version ?? 'unknown';
  } catch {
    return { compatible: false, installed, expected };
  }

  // Parse major version from semver string (e.g. "15.8.3" -> 15)
  const majorMatch = installed.match(/^(\d+)\./);
  if (!majorMatch) {
    return { compatible: false, installed, expected };
  }

  const major = parseInt(majorMatch[1], 10);
  const compatible = major === COMPATIBLE_MAJOR;

  return { compatible, installed, expected };
}
