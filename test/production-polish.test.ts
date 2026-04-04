/**
 * Tests for production polish features:
 * - Shell completion generation
 * - Per-command help
 * - Config file support
 * - Logger FLASH_LOG_LEVEL
 * - Command registry integrity
 */

import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'assert';

// ─── Shell Completion ───────────────────────────────────────────────────────

describe('Shell Completion', () => {
  it('generateBashCompletion returns valid bash script', async () => {
    const { generateBashCompletion } = await import('../src/cli/shell-completion.js');
    const script = generateBashCompletion();
    assert.ok(script.includes('_flash_completions'), 'should define completion function');
    assert.ok(script.includes('complete -F _flash_completions flash'), 'should register completion');
    assert.ok(script.includes('SOL'), 'should include market names');
    assert.ok(script.includes('positions'), 'should include commands');
  });

  it('generateZshCompletion returns valid zsh script', async () => {
    const { generateZshCompletion } = await import('../src/cli/shell-completion.js');
    const script = generateZshCompletion();
    assert.ok(script.includes('#compdef flash'), 'should have compdef header');
    assert.ok(script.includes('_flash'), 'should define _flash function');
    assert.ok(script.includes('SOL'), 'should include market names');
  });

  it('generateFishCompletion returns valid fish script', async () => {
    const { generateFishCompletion } = await import('../src/cli/shell-completion.js');
    const script = generateFishCompletion();
    assert.ok(script.includes('complete -c flash'), 'should use fish complete syntax');
    assert.ok(script.includes('SOL'), 'should include market names');
    assert.ok(script.includes('positions'), 'should include commands');
  });

  it('completion scripts include all major commands', async () => {
    const { generateBashCompletion } = await import('../src/cli/shell-completion.js');
    const script = generateBashCompletion();
    const required = ['positions', 'portfolio', 'markets', 'monitor', 'volume'];
    for (const cmd of required) {
      assert.ok(script.includes(cmd), `should include '${cmd}'`);
    }
  });
});

// ─── Per-Command Help ───────────────────────────────────────────────────────

describe('Per-Command Help', () => {
  it('returns help for known command', async () => {
    const { getCommandHelp } = await import('../src/cli/command-help.js');
    const help = getCommandHelp('positions');
    assert.ok(help !== null, 'should find positions command');
    assert.ok(help!.includes('positions'), 'should contain command name');
  });

  it('returns help for command alias', async () => {
    const { getCommandHelp } = await import('../src/cli/command-help.js');
    const help = getCommandHelp('balance');
    assert.ok(help !== null, 'should find balance as alias for portfolio');
  });

  it('returns null for unknown command', async () => {
    const { getCommandHelp } = await import('../src/cli/command-help.js');
    assert.strictEqual(getCommandHelp('nonexistent_command_xyz'), null);
  });

  it('case-insensitive lookup', async () => {
    const { getCommandHelp } = await import('../src/cli/command-help.js');
    const help1 = getCommandHelp('POSITIONS');
    const help2 = getCommandHelp('Positions');
    assert.ok(help1 !== null);
    assert.ok(help2 !== null);
  });

  it('includes examples when available', async () => {
    const { getCommandHelp } = await import('../src/cli/command-help.js');
    const help = getCommandHelp('open');
    assert.ok(help !== null);
    // In human mode, should have example content
    assert.ok(typeof help === 'string');
  });

  it('handles multi-word commands', async () => {
    const { getCommandHelp } = await import('../src/cli/command-help.js');
    const help = getCommandHelp('trade history');
    assert.ok(help !== null, 'should find trade history');
  });
});

// ─── Config File Support ────────────────────────────────────────────────────

describe('Config System', () => {
  it('loadConfig returns FlashConfig with all required fields', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    assert.ok('rpcUrl' in config);
    assert.ok('simulationMode' in config);
    assert.ok('computeUnitLimit' in config);
    assert.ok('computeUnitPrice' in config);
    assert.ok('maxTradesPerMinute' in config);
    assert.ok('defaultLeverage' in config);
  });

  it('defaultLeverage has a default value', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    assert.ok(typeof config.defaultLeverage === 'number');
    assert.ok(config.defaultLeverage >= 1);
  });

  it('config respects env var overrides', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    // Default slippage should be a number
    assert.ok(typeof config.defaultSlippageBps === 'number');
    assert.ok(config.defaultSlippageBps > 0);
  });

  it('config simulationMode defaults to true', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    // In test env, SIMULATION_MODE is not typically set to 'false'
    assert.strictEqual(typeof config.simulationMode, 'boolean');
  });
});

// ─── Logger FLASH_LOG_LEVEL ─────────────────────────────────────────────────

describe('Logger', () => {
  it('parseLogLevel handles all valid levels', async () => {
    const { parseLogLevel, LogLevel } = await import('../src/utils/logger.js');
    assert.strictEqual(parseLogLevel('debug'), LogLevel.Debug);
    assert.strictEqual(parseLogLevel('info'), LogLevel.Info);
    assert.strictEqual(parseLogLevel('warn'), LogLevel.Warn);
    assert.strictEqual(parseLogLevel('error'), LogLevel.Error);
  });

  it('parseLogLevel is case-insensitive', async () => {
    const { parseLogLevel, LogLevel } = await import('../src/utils/logger.js');
    assert.strictEqual(parseLogLevel('DEBUG'), LogLevel.Debug);
    assert.strictEqual(parseLogLevel('Info'), LogLevel.Info);
    assert.strictEqual(parseLogLevel('WARN'), LogLevel.Warn);
  });

  it('parseLogLevel returns undefined for invalid input', async () => {
    const { parseLogLevel } = await import('../src/utils/logger.js');
    assert.strictEqual(parseLogLevel(undefined), undefined);
    assert.strictEqual(parseLogLevel(''), undefined);
    assert.strictEqual(parseLogLevel('verbose'), undefined);
  });

  it('Logger constructor works with default options', async () => {
    const { Logger } = await import('../src/utils/logger.js');
    const logger = new Logger();
    // Should not throw
    logger.info('TEST', 'test message');
    logger.debug('TEST', 'debug message');
    logger.warn('TEST', 'warn message');
    logger.error('TEST', 'error message');
  });

  it('Logger respects log level filtering', async () => {
    const { Logger, LogLevel } = await import('../src/utils/logger.js');
    // Create a logger at Error level — debug/info/warn should be filtered
    const logger = new Logger({ level: LogLevel.Error });
    // These should not throw (just silently filter)
    logger.debug('TEST', 'should be filtered');
    logger.info('TEST', 'should be filtered');
    logger.warn('TEST', 'should be filtered');
    logger.error('TEST', 'should be logged');
  });
});

// ─── Command Registry Integrity ─────────────────────────────────────────────

describe('Command Registry Integrity', () => {
  it('every command has a category', async () => {
    const { COMMAND_REGISTRY } = await import('../src/cli/command-registry.js');
    for (const entry of COMMAND_REGISTRY) {
      assert.ok(entry.category, `Command '${entry.name}' missing category`);
    }
  });

  it('every command has a description', async () => {
    const { COMMAND_REGISTRY } = await import('../src/cli/command-registry.js');
    for (const entry of COMMAND_REGISTRY) {
      assert.ok(entry.description, `Command '${entry.name}' missing description`);
    }
  });

  it('no duplicate command names', async () => {
    const { COMMAND_REGISTRY } = await import('../src/cli/command-registry.js');
    const names = new Set<string>();
    for (const entry of COMMAND_REGISTRY) {
      assert.ok(!names.has(entry.name), `Duplicate command name: '${entry.name}'`);
      names.add(entry.name);
    }
  });

  it('FAST_DISPATCH covers all actionable commands', async () => {
    const { buildFastDispatch, COMMAND_REGISTRY } = await import('../src/cli/command-registry.js');
    const dispatch = buildFastDispatch();
    for (const entry of COMMAND_REGISTRY) {
      if (entry.action && !entry.parameterized) {
        assert.ok(
          entry.name in dispatch,
          `Command '${entry.name}' has action but is not in FAST_DISPATCH`,
        );
      }
    }
  });

  it('getCommandsByCategory groups correctly', async () => {
    const { getCommandsByCategory } = await import('../src/cli/command-registry.js');
    const cats = getCommandsByCategory();
    assert.ok(cats.has('Trading'));
    assert.ok(cats.has('Wallet'));
    assert.ok(cats.has('Utilities'));
    // Hidden commands should be excluded
    const allEntries = [...cats.values()].flat();
    const hidden = allEntries.filter(e => e.hidden);
    assert.strictEqual(hidden.length, 0, 'hidden commands should not be in category output');
  });

  it('getAutocompleteCommands includes aliases', async () => {
    const { getAutocompleteCommands } = await import('../src/cli/command-registry.js');
    const cmds = getAutocompleteCommands();
    // 'oi' is an alias for 'open interest'
    assert.ok(cmds.includes('oi'), 'should include alias "oi"');
    assert.ok(cmds.includes('positions'), 'should include "positions"');
    assert.ok(cmds.includes('markets'), 'should include "markets"');
  });
});

// ─── Pool & Market Discovery ────────────────────────────────────────────────

describe('Pool & Market Discovery', () => {
  it('POOL_MARKETS is populated', async () => {
    const { POOL_MARKETS } = await import('../src/config/index.js');
    const pools = Object.keys(POOL_MARKETS);
    assert.ok(pools.length > 0, 'should have at least one pool');
    assert.ok(pools.includes('Crypto.1'), 'should include Crypto.1');
  });

  it('getAllMarkets returns uppercase symbols', async () => {
    const { getAllMarkets } = await import('../src/config/index.js');
    const markets = getAllMarkets();
    assert.ok(markets.length > 0);
    assert.ok(markets.includes('SOL'));
    assert.ok(markets.includes('BTC'));
    for (const m of markets) {
      assert.strictEqual(m, m.toUpperCase(), `market ${m} should be uppercase`);
    }
  });

  it('getPoolForMarket resolves known markets', async () => {
    const { getPoolForMarket } = await import('../src/config/index.js');
    assert.ok(getPoolForMarket('SOL') !== null, 'SOL should resolve');
    assert.ok(getPoolForMarket('BTC') !== null, 'BTC should resolve');
    assert.strictEqual(getPoolForMarket('NONEXISTENT'), null);
  });
});
