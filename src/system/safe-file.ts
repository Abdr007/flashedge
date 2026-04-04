/**
 * Atomic file write with rollback guarantee.
 *
 * Strategy: write to temp file → rename (atomic on most filesystems).
 * If anything fails, the original file is untouched.
 */

import { writeFileSync, renameSync, unlinkSync, existsSync, readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { getLogger } from '../utils/logger.js';

/**
 * Write data to file atomically.
 * - Writes to a temp file first
 * - Renames temp → target (atomic on POSIX)
 * - If rename fails, cleans up temp file
 * - Original file is never corrupted
 */
export function atomicWriteFileSync(filePath: string, data: string, mode = 0o600): boolean {
  const tempPath = `${filePath}.tmp.${process.pid}`;
  try {
    writeFileSync(tempPath, data, { mode });
    renameSync(tempPath, filePath);
    return true;
  } catch (error) {
    // Clean up temp file on failure
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      /* best effort cleanup */
    }
    getLogger().debug('SAFE-FILE', `Atomic write failed for ${filePath}: ${error}`);
    return false;
  }
}

/**
 * Read and validate a JSON file with rollback to backup.
 *
 * - Tries to read and parse the primary file
 * - If corrupt, tries the .bak backup
 * - If both fail, returns null
 * - On successful read, saves a backup copy
 */
export function safeReadJson<T>(
  filePath: string,
  validator: (data: unknown) => T | null,
): T | null {
  // Try primary file
  const primary = tryReadAndValidate(filePath, validator);
  if (primary !== null) {
    // Save a backup of known-good data (async, best effort)
    try {
      const raw = readFileSync(filePath, 'utf-8');
      atomicWriteFileSync(`${filePath}.bak`, raw);
    } catch {
      /* non-critical */
    }
    return primary;
  }

  // Primary failed — try backup
  const backupPath = `${filePath}.bak`;
  const backup = tryReadAndValidate(backupPath, validator);
  if (backup !== null) {
    getLogger().warn('SAFE-FILE', `Primary file corrupt, recovered from backup: ${filePath}`);
    // Restore backup to primary
    try {
      const raw = readFileSync(backupPath, 'utf-8');
      atomicWriteFileSync(filePath, raw);
    } catch {
      /* best effort */
    }
    return backup;
  }

  // Both failed
  getLogger().warn('SAFE-FILE', `Both primary and backup unreadable: ${filePath}`);
  return null;
}

function tryReadAndValidate<T>(
  filePath: string,
  validator: (data: unknown) => T | null,
): T | null {
  try {
    if (!existsSync(filePath)) return null;

    // Size guard: reject files > 10MB
    const stat = statSync(filePath);
    if (stat.size > 10 * 1024 * 1024) {
      getLogger().warn('SAFE-FILE', `File too large (${stat.size} bytes): ${filePath}`);
      return null;
    }

    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return validator(data);
  } catch {
    return null;
  }
}

/**
 * Compute SHA-256 checksum of a string.
 */
export function checksum(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}
