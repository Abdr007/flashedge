/**
 * Flash SDK — Public API
 *
 * Usage:
 *   import { FlashSDK } from 'bolt-terminal/sdk';
 *   const flash = new FlashSDK();
 *   const positions = await flash.positions();
 */

// Core SDK
export { FlashSDK } from './flash-sdk.js';

// Types
export type {
  FlashSDKOptions,
  FlashResponse,
  FlashErrorInfo,
  Position,
  PositionsData,
  Portfolio,
  TradeResult,
  OpenParams,
  CloseParams,
  AddCollateralParams,
  RemoveCollateralParams,
  LimitOrderParams,
  EarnData,
  EarnPool,
  EarnActionParams,
  FafStatus,
  FafStakeParams,
  WalletBalance,
  WalletTokens,
  MarketInfo,
  MarketsData,
  VolumeData,
  OpenInterestData,
  HealthData,
  MetricsData,
  WatchOptions,
  WatchHandle,
  TradeSide,
} from './types.js';

// Errors
export { FlashError, FlashTimeoutError, FlashParseError, FlashProcessError } from './errors.js';
