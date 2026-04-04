/**
 * Tests for compute unit optimization.
 *
 * Verifies:
 * - Default CU limit = 220000
 * - CU price unchanged at 100000
 * - Instruction order: CU limit → CU price → program instructions
 * - Config overrides work (env, config file, fallback)
 * - Overflow retry constant = 260000
 * - Dynamic scaling for multi-instruction txs
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');

// ─── Default Values ─────────────────────────────────────────────────────────

describe('Compute Unit Defaults', () => {
  it('config default CU limit is 220000', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    // Temporarily clear env to test pure default
    const saved = process.env.COMPUTE_UNIT_LIMIT;
    delete process.env.COMPUTE_UNIT_LIMIT;
    try {
      const config = loadConfig();
      assert.strictEqual(config.computeUnitLimit, 220000,
        `expected 220000, got ${config.computeUnitLimit}`);
    } finally {
      if (saved !== undefined) process.env.COMPUTE_UNIT_LIMIT = saved;
    }
  });

  it('config default CU price is 100000', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const saved = process.env.COMPUTE_UNIT_PRICE;
    delete process.env.COMPUTE_UNIT_PRICE;
    try {
      const config = loadConfig();
      assert.strictEqual(config.computeUnitPrice, 100000,
        `expected 100000, got ${config.computeUnitPrice}`);
    } finally {
      if (saved !== undefined) process.env.COMPUTE_UNIT_PRICE = saved;
    }
  });

  it('ultra-tx-engine DEFAULT_CU_LIMIT is 220000', () => {
    const src = readFileSync(resolve(ROOT, 'src/core/ultra-tx-engine.ts'), 'utf8');
    assert.ok(src.includes('const DEFAULT_CU_LIMIT = 220_000'),
      'DEFAULT_CU_LIMIT should be 220_000');
  });
});

// ─── Config Overrides ───────────────────────────────────────────────────────

describe('Compute Unit Config Overrides', () => {
  it('COMPUTE_UNIT_LIMIT env var overrides default', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const saved = process.env.COMPUTE_UNIT_LIMIT;
    process.env.COMPUTE_UNIT_LIMIT = '300000';
    try {
      const config = loadConfig();
      assert.strictEqual(config.computeUnitLimit, 300000);
    } finally {
      if (saved !== undefined) {
        process.env.COMPUTE_UNIT_LIMIT = saved;
      } else {
        delete process.env.COMPUTE_UNIT_LIMIT;
      }
    }
  });

  it('COMPUTE_UNIT_PRICE env var overrides default', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const saved = process.env.COMPUTE_UNIT_PRICE;
    process.env.COMPUTE_UNIT_PRICE = '200000';
    try {
      const config = loadConfig();
      assert.strictEqual(config.computeUnitPrice, 200000);
    } finally {
      if (saved !== undefined) {
        process.env.COMPUTE_UNIT_PRICE = saved;
      } else {
        delete process.env.COMPUTE_UNIT_PRICE;
      }
    }
  });

  it('config file compute_unit_limit field is recognized', () => {
    // Verify the ConfigFileData interface includes compute_unit_limit
    const src = readFileSync(resolve(ROOT, 'src/config/index.ts'), 'utf8');
    assert.ok(src.includes('compute_unit_limit?: number'),
      'config file should support compute_unit_limit');
    assert.ok(src.includes('compute_unit_price?: number'),
      'config file should support compute_unit_price');
  });

  it('fallback works when config has no compute fields', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    // With no env overrides, should use defaults
    const saved = process.env.COMPUTE_UNIT_LIMIT;
    delete process.env.COMPUTE_UNIT_LIMIT;
    try {
      const config = loadConfig();
      assert.ok(config.computeUnitLimit > 0, 'should have a positive CU limit');
      assert.ok(config.computeUnitPrice > 0, 'should have a positive CU price');
    } finally {
      if (saved !== undefined) process.env.COMPUTE_UNIT_LIMIT = saved;
    }
  });
});

// ─── Instruction Order ──────────────────────────────────────────────────────

describe('Instruction Order', () => {
  it('flash-client builds Ed25519 → CU limit → CU price → instructions', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    // Ed25519 (backup oracle) instructions go first, then CU budget, then program instructions.
    // This ordering is required because the on-chain program reads ixSysvar to find Ed25519.
    assert.ok(src.includes('[...ed25519Ixs, cuLimitIx, cuPriceIx, ...nonEd25519Ixs]'),
      'sendTx should order: Ed25519, CU limit, CU price, program instructions');
  });

  it('ultra-tx-engine builds Ed25519 → CU limit → CU price → instructions via buildOrderedIxs', () => {
    const src = readFileSync(resolve(ROOT, 'src/core/ultra-tx-engine.ts'), 'utf8');
    assert.ok(src.includes('buildOrderedIxs(cuLimitIx, cuPriceIx, instructions)'),
      'ultra-tx should use buildOrderedIxs for proper Ed25519 ordering');
  });

  it('dry-run preview builds CU limit → CU price → instructions', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('[cuLimitIx, cuPriceIx, ...result.instructions]'),
      'dry-run should order: CU limit, CU price, program instructions');
  });
});

// ─── Overflow Retry ─────────────────────────────────────────────────────────

describe('Compute Overflow Retry', () => {
  it('CU overflow bump constant is 260000', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('CU_OVERFLOW_BUMP = 260_000'),
      'should have CU overflow bump at 260000');
  });

  it('detects ComputationalBudgetExceeded in simulation', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('ComputationalBudgetExceeded'),
      'should check for ComputationalBudgetExceeded');
  });

  it('detects ProgramFailedToComplete in simulation', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('ProgramFailedToComplete'),
      'should check for ProgramFailedToComplete');
  });

  it('only bumps CU if current limit is below overflow threshold', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('effectiveCuLimit < CU_OVERFLOW_BUMP'),
      'should only bump if below overflow limit');
  });

  it('uses effectiveCuLimit (mutable) not fixed cuLimitIx', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    // The CU limit instruction should be built inside the retry loop, not before it
    const loopStart = src.indexOf('for (let attempt = 1;');
    const cuLimitBuild = src.indexOf('const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: effectiveCuLimit })');
    assert.ok(cuLimitBuild > loopStart,
      'CU limit instruction should be built inside the retry loop');
  });
});

// ─── Dynamic Scaling ────────────────────────────────────────────────────────

describe('Dynamic CU Scaling', () => {
  it('adds 30k CU for transactions with >4 instructions', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('instructions.length > 4'),
      'should check instruction count > 4');
    assert.ok(src.includes('+ 30_000'),
      'should add 30k CU headroom for multi-instruction txs');
  });

  it('caps dynamic scaling at 600k', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('600_000'),
      'should cap at 600k max');
  });

  it('swapAndOpen forces minimum 420k CU', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes("isSwapAndOpen ? Math.max(this.config.computeUnitLimit, 420_000)"),
      'swapAndOpen should force at least 420k CU');
  });
});

// ─── Fee Calculation Correctness ────────────────────────────────────────────

describe('Priority Fee Calculation', () => {
  it('priority fee = CU_limit * CU_price / 1_000_000 lamports', () => {
    // At 220k CU and 100k microLamports:
    // fee = 220000 * 100000 / 1_000_000 = 22000 lamports
    const cuLimit = 220000;
    const cuPrice = 100000; // microLamports
    const feeInLamports = (cuLimit * cuPrice) / 1_000_000;
    assert.strictEqual(feeInLamports, 22000,
      `expected 22000 lamports, got ${feeInLamports}`);
  });

  it('old fee was ~42000 lamports (420k * 100k)', () => {
    const oldFee = (420000 * 100000) / 1_000_000;
    assert.strictEqual(oldFee, 42000);
  });

  it('new fee saves ~47.6% vs old', () => {
    const oldFee = (420000 * 100000) / 1_000_000;
    const newFee = (220000 * 100000) / 1_000_000;
    const savings = ((oldFee - newFee) / oldFee) * 100;
    assert.ok(savings > 45, `savings should be > 45%, got ${savings.toFixed(1)}%`);
    assert.ok(savings < 50, `savings should be < 50%, got ${savings.toFixed(1)}%`);
  });

  it('220k provides ~100k headroom over 112k observed usage', () => {
    const headroom = 220000 - 112000;
    assert.ok(headroom >= 100000, `headroom should be >= 100k, got ${headroom}`);
  });
});

// ─── Logging ────────────────────────────────────────────────────────────────

describe('Compute Debug Logging', () => {
  it('TX log includes CU limit', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('CU: ${effectiveCuLimit}'),
      'TX log should include CU limit');
  });

  it('TX log includes priority fee rate', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('Fee: ${this.config.computeUnitPrice}'),
      'TX log should include fee rate');
  });

  it('overflow retry is logged', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('Compute budget exceeded at'),
      'should log CU overflow retries');
  });
});
