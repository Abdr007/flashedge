/**
 * Tests for release readiness:
 * - Build info metadata
 * - Version command
 * - Update command (registry check)
 * - CI configuration
 * - Distribution files
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');

// ─── Build Info ─────────────────────────────────────────────────────────────

describe('Build Info', () => {
  it('BUILD_INFO has all required fields', async () => {
    const { BUILD_INFO } = await import('../src/build-info.js');
    assert.ok(BUILD_INFO.version, 'version should be set');
    assert.ok(BUILD_INFO.gitHash, 'gitHash should be set');
    assert.ok(BUILD_INFO.branch, 'branch should be set');
    assert.ok(BUILD_INFO.buildDate, 'buildDate should be set');
    assert.ok(BUILD_INFO.platform, 'platform should be set');
    assert.ok(BUILD_INFO.arch, 'arch should be set');
  });

  it('version follows semver format', async () => {
    const { BUILD_INFO } = await import('../src/build-info.js');
    assert.ok(/^\d+\.\d+\.\d+/.test(BUILD_INFO.version), `version '${BUILD_INFO.version}' should be semver`);
  });

  it('buildDate is ISO-8601', async () => {
    const { BUILD_INFO } = await import('../src/build-info.js');
    const d = new Date(BUILD_INFO.buildDate);
    assert.ok(!isNaN(d.getTime()), 'buildDate should be parseable');
    assert.ok(BUILD_INFO.buildDate.includes('T'), 'buildDate should be ISO-8601');
  });

  it('build-info generation script exists', () => {
    assert.ok(existsSync(resolve(ROOT, 'scripts/generate-build-info.sh')));
  });

  it('generation script captures platform and arch', () => {
    const script = readFileSync(resolve(ROOT, 'scripts/generate-build-info.sh'), 'utf8');
    assert.ok(script.includes('uname -s'), 'should capture platform via uname -s');
    assert.ok(script.includes('uname -m'), 'should capture arch via uname -m');
    assert.ok(script.includes('PLATFORM'), 'should set PLATFORM var');
    assert.ok(script.includes('ARCH'), 'should set ARCH var');
  });
});

// ─── Package.json ───────────────────────────────────────────────────────────

describe('Package.json', () => {
  it('has bin entry for flash', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.bin, 'should have bin field');
    assert.ok(pkg.bin.flash, 'should have flash binary');
    assert.ok(pkg.bin.flash.includes('dist/index.js'), 'should point to dist/index.js');
  });

  it('has prepack script for clean npm publish', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts.prepack, 'should have prepack script');
    assert.ok(pkg.scripts.prepack.includes('build'), 'prepack should run build');
  });

  it('requires Node >= 20', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.engines?.node, 'should have engines.node');
    assert.ok(pkg.engines.node.includes('20'), 'should require Node 20+');
  });

  it('version matches BUILD_INFO', async () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    const { BUILD_INFO } = await import('../src/build-info.js');
    assert.strictEqual(pkg.version, BUILD_INFO.version);
  });
});

// ─── CI Configuration ───────────────────────────────────────────────────────

describe('CI Configuration', () => {
  it('CI workflow exists', () => {
    assert.ok(existsSync(resolve(ROOT, '.github/workflows/ci.yml')));
  });

  it('CI runs tests with SIMULATION_MODE=true', () => {
    const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
    assert.ok(ci.includes('SIMULATION_MODE'), 'should set SIMULATION_MODE');
    assert.ok(ci.includes('"true"'), 'SIMULATION_MODE should be true');
  });

  it('CI has test count regression guard >= 800', () => {
    const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
    assert.ok(ci.includes('800'), 'minimum test count should be 800');
  });

  it('release workflow exists', () => {
    assert.ok(existsSync(resolve(ROOT, '.github/workflows/release.yml')), 'should have release workflow');
  });
});

// ─── Distribution Files ─────────────────────────────────────────────────────

describe('Distribution', () => {
  it('install script exists', () => {
    assert.ok(existsSync(resolve(ROOT, 'scripts/install.sh')));
  });

  it('install script checks for node', () => {
    const script = readFileSync(resolve(ROOT, 'scripts/install.sh'), 'utf8');
    assert.ok(script.includes('node'), 'should check for node');
  });

  it('install script is POSIX shell', () => {
    const script = readFileSync(resolve(ROOT, 'scripts/install.sh'), 'utf8');
    assert.ok(script.startsWith('#!/'), 'should have shebang');
  });
});

// ─── Non-Interactive Commands ───────────────────────────────────────────────

describe('Non-Interactive Commands', () => {
  it('index.ts registers version command', async () => {
    // Just verify the command exists by checking source
    const src = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
    assert.ok(src.includes("command('version')"), 'should have version subcommand');
  });

  it('index.ts registers update command', () => {
    const src = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
    assert.ok(src.includes("command('update')"), 'should have update subcommand');
  });

  it('index.ts registers price command', () => {
    const src = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
    assert.ok(src.includes("command('price"), 'should have price subcommand');
  });

  it('index.ts registers completion command', () => {
    const src = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
    assert.ok(src.includes("command('completion"), 'should have completion subcommand');
  });

  it('index.ts registers doctor command', () => {
    const src = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
    assert.ok(src.includes("command('doctor')"), 'should have doctor subcommand');
  });

  it('all commands support agent mode (NO_DNA)', () => {
    const src = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
    // Every command action should check IS_AGENT somewhere
    const cmdCount = (src.match(/\.command\('/g) || []).length;
    const agentRefs = (src.match(/IS_AGENT|agentOutput|agentError/g) || []).length;
    // At least half the commands should reference agent mode
    assert.ok(agentRefs >= cmdCount, `${agentRefs} agent refs for ${cmdCount} commands`);
  });
});

// ─── Logging ────────────────────────────────────────────────────────────────

describe('Logging Configuration', () => {
  it('FLASH_LOG_LEVEL env var is supported', async () => {
    const { parseLogLevel, LogLevel } = await import('../src/utils/logger.js');
    assert.strictEqual(parseLogLevel('debug'), LogLevel.Debug);
    assert.strictEqual(parseLogLevel('error'), LogLevel.Error);
  });

  it('log file has size rotation', async () => {
    const src = readFileSync(resolve(ROOT, 'src/utils/logger.ts'), 'utf8');
    assert.ok(src.includes('MAX_LOG_FILE_BYTES'), 'should have max log file size');
    assert.ok(src.includes('.old'), 'should rotate to .old');
  });

  it('log scrubbing masks API keys', async () => {
    const src = readFileSync(resolve(ROOT, 'src/utils/logger.ts'), 'utf8');
    assert.ok(src.includes('sk-ant-'), 'should scrub Anthropic keys');
    assert.ok(src.includes('gsk_'), 'should scrub Groq keys');
    assert.ok(src.includes('api_key'), 'should scrub generic API keys');
  });
});

// ─── Safety Invariants ──────────────────────────────────────────────────────

describe('Safety Invariants', () => {
  it('global error handlers exist', () => {
    const src = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
    assert.ok(src.includes('unhandledRejection'), 'should handle unhandled rejections');
    assert.ok(src.includes('uncaughtException'), 'should handle uncaught exceptions');
  });

  it('signing guard is initialized at startup', () => {
    const src = readFileSync(resolve(ROOT, 'src/cli/terminal.ts'), 'utf8');
    assert.ok(src.includes('initSigningGuard'), 'should init signing guard');
  });

  it('simulation mode defaults to true', () => {
    const src = readFileSync(resolve(ROOT, 'src/config/index.ts'), 'utf8');
    // The default should be simulation mode on unless explicitly set to false
    assert.ok(src.includes("'true'"), 'simulation mode should default to true');
  });

  it('RPC URL validation exists', () => {
    const src = readFileSync(resolve(ROOT, 'src/config/index.ts'), 'utf8');
    assert.ok(src.includes('validateRpcUrl'), 'should validate RPC URLs');
    assert.ok(src.includes('HTTPS'), 'should require HTTPS');
  });
});
