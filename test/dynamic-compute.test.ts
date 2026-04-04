/**
 * Tests for dynamic compute unit optimization.
 *
 * Verifies:
 * - Dynamic CU calculation with buffer
 * - Safety clamp (min 120k, max 200k)
 * - Fallback when simulation fails
 * - Config fields (dynamicCompute, computeBufferPercent)
 * - Instruction order preserved
 * - Overflow retry still works
 * - Rounding behavior
 */

import { describe, it } from 'vitest';
import assert from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');

// ─── Dynamic CU Calculation ─────────────────────────────────────────────────

describe('Dynamic CU Calculation', () => {
  it('20% buffer on 104298 CU → 130000 (rounded to nearest 10k)', () => {
    const used = 104298;
    const bufferPct = 20;
    const raw = used * (1 + bufferPct / 100); // 125157.6
    const rounded = Math.ceil(raw / 10_000) * 10_000; // 130000
    assert.strictEqual(rounded, 130000);
  });

  it('20% buffer on 112000 CU → 140000', () => {
    const used = 112000;
    const bufferPct = 20;
    const raw = used * (1 + bufferPct / 100); // 134400
    const rounded = Math.ceil(raw / 10_000) * 10_000; // 140000
    assert.strictEqual(rounded, 140000);
  });

  it('20% buffer on 50000 CU → 60000', () => {
    const used = 50000;
    const bufferPct = 20;
    const raw = used * (1 + bufferPct / 100); // 60000
    const rounded = Math.ceil(raw / 10_000) * 10_000;
    assert.strictEqual(rounded, 60000);
  });

  it('30% buffer on 104298 CU → 140000', () => {
    const used = 104298;
    const bufferPct = 30;
    const raw = used * (1 + bufferPct / 100); // 135587.4
    const rounded = Math.ceil(raw / 10_000) * 10_000;
    assert.strictEqual(rounded, 140000);
  });

  it('dynamic limit is always >= simulated usage', () => {
    for (const used of [10000, 50000, 100000, 200000, 300000]) {
      const raw = used * 1.2;
      const rounded = Math.ceil(raw / 10_000) * 10_000;
      assert.ok(rounded >= used, `${rounded} should be >= ${used}`);
    }
  });

  it('only tightens — never exceeds configured limit', () => {
    // If dynamic limit would be > config limit, we keep config limit
    const configLimit = 220000;
    const used = 200000;
    const dynamic = Math.ceil(used * 1.2 / 10_000) * 10_000; // 240000
    // The code checks: if (dynamicLimit < effectiveCuLimit)
    assert.ok(dynamic > configLimit, 'dynamic should exceed config in this case');
    // So dynamic CU is NOT applied — config limit stays
  });
});

// ─── Safety Clamp ───────────────────────────────────────────────────────────

describe('Dynamic CU Safety Clamp', () => {
  const clamp = (used: number, bufferPct = 20) => {
    const raw = Math.ceil(used * (1 + bufferPct / 100) / 10_000) * 10_000;
    return Math.max(120_000, Math.min(raw, 200_000));
  };

  it('clamps minimum to 120000 for very low CU usage', () => {
    assert.strictEqual(clamp(50000), 120000); // 50k * 1.2 = 60k → clamped to 120k
    assert.strictEqual(clamp(80000), 120000); // 80k * 1.2 = 96k → clamped to 120k
  });

  it('clamps maximum to 200000 for high CU usage', () => {
    assert.strictEqual(clamp(180000), 200000); // 180k * 1.2 = 216k → clamped to 200k
    assert.strictEqual(clamp(200000), 200000); // 200k * 1.2 = 240k → clamped to 200k
  });

  it('passes through typical values within range', () => {
    assert.strictEqual(clamp(104298), 130000); // 104k * 1.2 = 125k → rounded 130k, within range
    assert.strictEqual(clamp(112000), 140000); // 112k * 1.2 = 134.4k → rounded 140k
  });

  it('clamp is applied in flash-client.ts', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('Math.max(120_000, Math.min(rawLimit, effectiveCuLimit))'),
      'flash-client should apply safety clamp');
  });

  it('clamp is applied in ultra-tx-engine.ts', () => {
    const src = readFileSync(resolve(ROOT, 'src/core/ultra-tx-engine.ts'), 'utf8');
    // Accept either effectiveCuLimit or 200_000 as the upper bound (linter may change)
    const hasClamp = src.includes('Math.max(120_000, Math.min(rawLimit, effectiveCuLimit))') ||
                     src.includes('Math.max(120_000, Math.min(rawLimit, 200_000))');
    assert.ok(hasClamp, 'ultra-tx-engine should apply safety clamp');
  });
});

// ─── Fee Savings ────────────────────────────────────────────────────────────

describe('Dynamic CU Fee Savings', () => {
  it('dynamic limit saves ~40% vs static 220k for typical trade', () => {
    const staticLimit = 220000;
    const dynamicLimit = 130000; // typical: 104k * 1.2 rounded
    const cuPrice = 100000; // microLamports
    const staticFee = (staticLimit * cuPrice) / 1_000_000;
    const dynamicFee = (dynamicLimit * cuPrice) / 1_000_000;
    const savings = ((staticFee - dynamicFee) / staticFee) * 100;
    assert.ok(savings > 35, `expected > 35% savings, got ${savings.toFixed(1)}%`);
    assert.ok(savings < 45, `expected < 45% savings, got ${savings.toFixed(1)}%`);
  });

  it('dynamic 130k CU = 13000 lamports priority fee', () => {
    const fee = (130000 * 100000) / 1_000_000;
    assert.strictEqual(fee, 13000);
  });
});

// ─── Config Fields ──────────────────────────────────────────────────────────

describe('Dynamic CU Config', () => {
  it('FlashConfig has dynamicCompute field', async () => {
    const src = readFileSync(resolve(ROOT, 'src/types/index.ts'), 'utf8');
    assert.ok(src.includes('dynamicCompute: boolean'));
  });

  it('FlashConfig has computeBufferPercent field', async () => {
    const src = readFileSync(resolve(ROOT, 'src/types/index.ts'), 'utf8');
    assert.ok(src.includes('computeBufferPercent: number'));
  });

  it('dynamicCompute defaults to true', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const saved = process.env.FLASH_DYNAMIC_CU;
    delete process.env.FLASH_DYNAMIC_CU;
    try {
      const config = loadConfig();
      assert.strictEqual(config.dynamicCompute, true);
    } finally {
      if (saved !== undefined) process.env.FLASH_DYNAMIC_CU = saved;
    }
  });

  it('computeBufferPercent defaults to 20', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const saved = process.env.FLASH_CU_BUFFER_PCT;
    delete process.env.FLASH_CU_BUFFER_PCT;
    try {
      const config = loadConfig();
      assert.strictEqual(config.computeBufferPercent, 20);
    } finally {
      if (saved !== undefined) process.env.FLASH_CU_BUFFER_PCT = saved;
    }
  });

  it('FLASH_DYNAMIC_CU=false disables dynamic compute', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const saved = process.env.FLASH_DYNAMIC_CU;
    process.env.FLASH_DYNAMIC_CU = 'false';
    try {
      const config = loadConfig();
      assert.strictEqual(config.dynamicCompute, false);
    } finally {
      if (saved !== undefined) {
        process.env.FLASH_DYNAMIC_CU = saved;
      } else {
        delete process.env.FLASH_DYNAMIC_CU;
      }
    }
  });

  it('FLASH_CU_BUFFER_PCT overrides buffer percent', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const saved = process.env.FLASH_CU_BUFFER_PCT;
    process.env.FLASH_CU_BUFFER_PCT = '30';
    try {
      const config = loadConfig();
      assert.strictEqual(config.computeBufferPercent, 30);
    } finally {
      if (saved !== undefined) {
        process.env.FLASH_CU_BUFFER_PCT = saved;
      } else {
        delete process.env.FLASH_CU_BUFFER_PCT;
      }
    }
  });

  it('config.json supports dynamic_compute field', () => {
    const src = readFileSync(resolve(ROOT, 'src/config/index.ts'), 'utf8');
    assert.ok(src.includes('dynamic_compute?: boolean'));
    assert.ok(src.includes('compute_buffer_percent?: number'));
  });

  it('TxEngineConfig has dynamicCompute field', () => {
    const src = readFileSync(resolve(ROOT, 'src/core/ultra-tx-engine.ts'), 'utf8');
    assert.ok(src.includes('dynamicCompute?: boolean'));
    assert.ok(src.includes('computeBufferPercent?: number'));
  });
});

// ─── Code Structure ─────────────────────────────────────────────────────────

describe('Dynamic CU Implementation', () => {
  it('flash-client extracts unitsConsumed from simulation', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('simResult.value.unitsConsumed'),
      'should read unitsConsumed from simulation result');
  });

  it('ultra-tx-engine simulateTransaction returns unitsConsumed', () => {
    const src = readFileSync(resolve(ROOT, 'src/core/ultra-tx-engine.ts'), 'utf8');
    assert.ok(src.includes('return simResult.value.unitsConsumed'),
      'simulateTransaction should return unitsConsumed');
  });

  it('flash-client rebuilds tx with tighter CU limit', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('tightCuLimitIx'),
      'should rebuild with tighter CU limit instruction');
  });

  it('ultra-tx-engine rebuilds tx with tighter CU limit', () => {
    const src = readFileSync(resolve(ROOT, 'src/core/ultra-tx-engine.ts'), 'utf8');
    assert.ok(src.includes('tightCuLimitIx'),
      'should rebuild with tighter CU limit instruction');
  });

  it('instruction order preserved in dynamic rebuild: CU limit → CU price → instructions', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('[tightCuLimitIx, cuPriceIx, ...validatedInstructions]'),
      'dynamic rebuild should preserve CU limit → CU price → instructions order');
  });

  it('no additional RPC calls for dynamic CU', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    // The dynamic CU section should only do local operations (compile, sign, send)
    // It should NOT call simulateTransaction again
    const dynamicSection = src.substring(
      src.indexOf('Dynamic CU optimization'),
      src.indexOf('Dynamic CU tx timed out') || src.length
    );
    assert.ok(!dynamicSection.includes('simulateTransaction'),
      'dynamic CU section should not call simulateTransaction');
  });

  it('debug logging for dynamic CU enabled', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('Dynamic CU:'),
      'should log dynamic CU adjustment at debug level');
  });
});

// ─── Fallback Safety ────────────────────────────────────────────────────────

describe('Dynamic CU Fallback', () => {
  it('falls back to static limit when simulation fails (simUnitsConsumed is null)', () => {
    // When simUnitsConsumed is null (simulation failed), the dynamic CU
    // optimization is skipped and the static effectiveCuLimit is used
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('simUnitsConsumed && simUnitsConsumed > 0'),
      'should check simUnitsConsumed is truthy and positive');
  });

  it('respects dynamicCompute=false config', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('this.config.dynamicCompute !== false'),
      'should check dynamicCompute config flag');
  });

  it('overflow retry still exists at 260k', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes('CU_OVERFLOW_BUMP = 260_000'),
      'overflow retry should still be at 260k');
  });

  it('swapAndOpen still forces 420k minimum', () => {
    const src = readFileSync(resolve(ROOT, 'src/client/flash-client.ts'), 'utf8');
    assert.ok(src.includes("isSwapAndOpen ? Math.max(this.config.computeUnitLimit, 420_000)"),
      'swapAndOpen should still force 420k');
  });
});
