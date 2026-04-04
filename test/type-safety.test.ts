/**
 * Type Safety Regression Test
 *
 * Ensures `as any` and `: any` casts do not creep back into the codebase.
 * Allowed only with an eslint-disable comment documenting the reason.
 */

import { describe, it, assert } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

/**
 * Check whether a match line is guarded by an eslint-disable comment.
 * Looks at the match itself and the preceding line in the original file.
 */
function isGuarded(filePath: string, lineNum: number, lineContent: string): boolean {
  if (lineContent.includes('eslint-disable')) return true;
  if (lineContent.includes('without `as any`')) return true;
  // Check the preceding line
  if (lineNum > 1) {
    try {
      const lines = readFileSync(filePath, 'utf-8').split('\n');
      const prevLine = lines[lineNum - 2] ?? ''; // lineNum is 1-based
      if (prevLine.includes('eslint-disable')) return true;
    } catch {
      // File read failure — treat as unguarded
    }
  }
  return false;
}

function findUnguarded(pattern: string): string[] {
  const result = execSync(
    `grep -rn "${pattern}" src/ --include="*.ts" || true`,
    { encoding: 'utf-8' },
  ).trim();

  if (!result) return [];

  const lines = result.split('\n').filter(Boolean);
  const unguarded: string[] = [];

  for (const line of lines) {
    // Parse "filepath:linenum:content"
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (!match) continue;
    const [, filePath, lineStr, content] = match;
    const lineNum = parseInt(lineStr, 10);
    if (!isGuarded(filePath, lineNum, content)) {
      unguarded.push(line);
    }
  }

  return unguarded;
}

describe('Type Safety', () => {
  it('no unguarded "as any" in src/', () => {
    const unguarded = findUnguarded('as any');
    assert.strictEqual(
      unguarded.length,
      0,
      `Found unguarded "as any" usage:\n${unguarded.join('\n')}\n\nEach "as any" must have an eslint-disable comment with justification.`,
    );
  });

  it('no unguarded ": any" in src/', () => {
    const unguarded = findUnguarded(': any');
    assert.strictEqual(
      unguarded.length,
      0,
      `Found unguarded ": any" usage:\n${unguarded.join('\n')}\n\nEach ": any" must have an eslint-disable comment with justification.`,
    );
  });

  it('[key: string]: any does not exist in types', () => {
    const result = execSync(
      `grep -rn "\\[key: string\\]: any" src/ --include="*.ts" || true`,
      { encoding: 'utf-8' },
    ).trim();

    assert.strictEqual(
      result,
      '',
      `Found unsafe index signatures:\n${result}\n\nUse [key: string]: unknown instead.`,
    );
  });
});
