import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/cli/theme.js', () => ({
  theme: {
    accentBold: (s: string) => s,
    accent: (s: string) => s,
    dim: (s: string) => s,
  },
}));

describe('Swap Tool', () => {
  describe('validation', () => {
    it('rejects same input and output token', async () => {
      const { swapTool } = await import('../src/tools/swap-tools.js');
      const result = await swapTool.execute(
        { inputToken: 'SOL', outputToken: 'SOL', amount: 100 },
        { flashClient: {} } as any,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('different');
    });

    it('rejects zero amount', async () => {
      const { swapTool } = await import('../src/tools/swap-tools.js');
      const result = await swapTool.execute(
        { inputToken: 'SOL', outputToken: 'USDC', amount: 0 },
        { flashClient: {} } as any,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('positive');
    });

    it('rejects negative amount', async () => {
      const { swapTool } = await import('../src/tools/swap-tools.js');
      const result = await swapTool.execute(
        { inputToken: 'SOL', outputToken: 'USDC', amount: -50 },
        { flashClient: {} } as any,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('positive');
    });

    it('rejects NaN amount', async () => {
      const { swapTool } = await import('../src/tools/swap-tools.js');
      const result = await swapTool.execute(
        { inputToken: 'SOL', outputToken: 'USDC', amount: NaN },
        { flashClient: {} } as any,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('positive');
    });

    it('returns unavailable when client has no swap method', async () => {
      const { swapTool } = await import('../src/tools/swap-tools.js');
      const result = await swapTool.execute(
        { inputToken: 'SOL', outputToken: 'USDC', amount: 100 },
        { flashClient: {} } as any,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('not available');
    });

    it('handles swap execution success', async () => {
      const { swapTool } = await import('../src/tools/swap-tools.js');
      const mockClient = {
        swap: vi.fn().mockResolvedValue({
          amountIn: 1.5,
          inputToken: 'SOL',
          amountOut: 225,
          outputToken: 'USDC',
          price: 150,
          txSignature: 'abc123',
        }),
      };
      const result = await swapTool.execute(
        { inputToken: 'SOL', outputToken: 'USDC', amount: 1.5 },
        { flashClient: mockClient } as any,
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain('SWAP COMPLETE');
      expect(result.txSignature).toBe('abc123');
    });

    it('handles swap execution failure', async () => {
      const { swapTool } = await import('../src/tools/swap-tools.js');
      const mockClient = {
        swap: vi.fn().mockRejectedValue(new Error('Slippage exceeded')),
      };
      const result = await swapTool.execute(
        { inputToken: 'SOL', outputToken: 'USDC', amount: 1.5 },
        { flashClient: mockClient } as any,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('Slippage exceeded');
    });

    it('case-insensitive token comparison', async () => {
      const { swapTool } = await import('../src/tools/swap-tools.js');
      const result = await swapTool.execute(
        { inputToken: 'sol', outputToken: 'Sol', amount: 100 },
        { flashClient: {} } as any,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('different');
    });

    it('validates Zod schema accepts valid params', async () => {
      const { swapTool } = await import('../src/tools/swap-tools.js');
      const result = swapTool.parameters.safeParse({
        inputToken: 'SOL',
        outputToken: 'USDC',
        amount: 100,
      });
      expect(result.success).toBe(true);
    });

    it('validates Zod schema rejects negative amount', async () => {
      const { swapTool } = await import('../src/tools/swap-tools.js');
      const result = swapTool.parameters.safeParse({
        inputToken: 'SOL',
        outputToken: 'USDC',
        amount: -1,
      });
      expect(result.success).toBe(false);
    });
  });
});
