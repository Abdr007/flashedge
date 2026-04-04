/**
 * FAF Token Registry
 *
 * Constants, VIP tier definitions, and on-chain addresses
 * for the Flash Trade FAF governance token system.
 */

import { PublicKey } from '@solana/web3.js';

// ─── Token Constants ────────────────────────────────────────────────────────

export const FAF_MINT = new PublicKey('FAFxVxnkzZHMCodkWyoccgUNgVScqMw2mhhQBYDFjFAF');
export const FAF_DECIMALS = 6;
export const FAF_TOKEN_VAULT = new PublicKey('DBh5a25KUsmbz62sxStp4PRu8WdJmdGUmuCJWvxse5YL');
export const FAF_REVENUE_ACCOUNT = new PublicKey('Aw9fQzvcRuSmAkjzB6BMZRvywmGrpWtCzYrD63HoguXr');
export const FAF_REBATE_VAULT = new PublicKey('F7kanenf6CRq38KpC3FYDtTHJ1j3c1G3xJoDtL4Xnzbm');
export const FAF_REWARD_PROGRAM = new PublicKey('FARNT7LL119pmy9vSkN9q1ApZESPaKHuuX5Acz1oBoME');

/** Linear unstake unlock period in days. */
export const UNSTAKE_UNLOCK_DAYS = 90;

/** Epoch duration in days. */
export const EPOCH_DURATION_DAYS = 30;

// ─── VIP Tier System ────────────────────────────────────────────────────────

export interface VipTier {
  level: number;
  name: string;
  fafRequired: number;
  feeDiscount: number; // percentage
  referralRebate: number; // percentage
  spotLoDiscount: number; // percentage
  dcaDiscount: number; // percentage
}

export const VIP_TIERS: VipTier[] = [
  { level: 0, name: 'None', fafRequired: 0, feeDiscount: 0, referralRebate: 2, spotLoDiscount: 10, dcaDiscount: 10 },
  {
    level: 1,
    name: 'Level 1',
    fafRequired: 20_000,
    feeDiscount: 2.5,
    referralRebate: 2.5,
    spotLoDiscount: 10,
    dcaDiscount: 10,
  },
  {
    level: 2,
    name: 'Level 2',
    fafRequired: 40_000,
    feeDiscount: 3.5,
    referralRebate: 3,
    spotLoDiscount: 15,
    dcaDiscount: 15,
  },
  {
    level: 3,
    name: 'Level 3',
    fafRequired: 100_000,
    feeDiscount: 5,
    referralRebate: 4,
    spotLoDiscount: 20,
    dcaDiscount: 20,
  },
  {
    level: 4,
    name: 'Level 4',
    fafRequired: 200_000,
    feeDiscount: 7,
    referralRebate: 5.5,
    spotLoDiscount: 25,
    dcaDiscount: 25,
  },
  {
    level: 5,
    name: 'Level 5',
    fafRequired: 1_000_000,
    feeDiscount: 9.5,
    referralRebate: 7.5,
    spotLoDiscount: 30,
    dcaDiscount: 30,
  },
  {
    level: 6,
    name: 'Level 6',
    fafRequired: 2_000_000,
    feeDiscount: 12,
    referralRebate: 10,
    spotLoDiscount: 35,
    dcaDiscount: 35,
  },
];

// ─── Voltage Point Tiers ────────────────────────────────────────────────────

export interface VoltageTier {
  name: string;
  multiplier: number;
}

export const VOLTAGE_TIERS: VoltageTier[] = [
  { name: 'Rookie', multiplier: 1.0 },
  { name: 'Degenerate', multiplier: 1.2 },
  { name: 'Flow Master', multiplier: 1.4 },
  { name: 'Ape Trade', multiplier: 1.6 },
  { name: 'Perp King', multiplier: 1.8 },
  { name: 'Giga Chad', multiplier: 2.0 },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Get VIP tier for a given staked FAF amount. */
export function getVipTier(stakedFaf: number): VipTier {
  for (let i = VIP_TIERS.length - 1; i >= 0; i--) {
    if (stakedFaf >= VIP_TIERS[i].fafRequired) return VIP_TIERS[i];
  }
  return VIP_TIERS[0];
}

/** Get the next VIP tier (or null if at max). */
export function getNextTier(currentLevel: number): VipTier | null {
  if (currentLevel >= VIP_TIERS.length - 1) return null;
  return VIP_TIERS[currentLevel + 1];
}

/** Format FAF amount with decimals. */
export function formatFaf(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M FAF`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K FAF`;
  return `${amount.toFixed(2)} FAF`;
}
