import { z } from 'zod';
import type { WalletManager } from '../wallet/walletManager.js';

// ─── Trading Enums ───────────────────────────────────────────────────────────

export enum TradeSide {
  Long = 'long',
  Short = 'short',
}

export enum ActionType {
  OpenPosition = 'open_position',
  ClosePosition = 'close_position',
  AddCollateral = 'add_collateral',
  RemoveCollateral = 'remove_collateral',
  GetPositions = 'get_positions',
  GetMarketData = 'get_market_data',
  GetPortfolio = 'get_portfolio',
  GetVolume = 'get_volume',
  GetOpenInterest = 'get_open_interest',
  GetLeaderboard = 'get_leaderboard',
  GetTraderProfile = 'get_trader_profile',
  GetFees = 'get_fees',
  WalletConnect = 'wallet_connect',
  WalletImport = 'wallet_import',
  WalletList = 'wallet_list',
  WalletUse = 'wallet_use',
  WalletRemove = 'wallet_remove',
  WalletDisconnect = 'wallet_disconnect',
  WalletStatus = 'wallet_status',
  WalletAddress = 'wallet_address',
  WalletBalance = 'wallet_balance',
  WalletTokens = 'wallet_tokens',
  Help = 'help',
  FlashMarkets = 'flash_markets',

  // AI Agent
  Analyze = 'analyze',
  RiskReport = 'risk_report',
  Dashboard = 'dashboard',
  WhaleActivity = 'whale_activity',


  // Portfolio Intelligence
  PortfolioState = 'portfolio_state',
  PortfolioExposure = 'portfolio_exposure',
  PortfolioRebalance = 'portfolio_rebalance',

  // Market Observability
  LiquidationMap = 'liquidation_map',
  FundingDashboard = 'funding_dashboard',
  LiquidityDepth = 'liquidity_depth',
  ProtocolHealth = 'protocol_health',

  // Protocol Inspector
  InspectProtocol = 'inspect_protocol',
  InspectPool = 'inspect_pool',
  InspectMarket = 'inspect_market',

  // System Diagnostics
  SystemStatus = 'system_status',
  SystemAudit = 'system_audit',
  RpcStatus = 'rpc_status',
  RpcTest = 'rpc_test',
  RpcSet = 'rpc_set',
  RpcAdd = 'rpc_add',
  RpcRemove = 'rpc_remove',
  RpcList = 'rpc_list',
  TxInspect = 'tx_inspect',

  // Transaction Debug
  TxDebug = 'tx_debug',

  // TX Engine
  TxMetrics = 'tx_metrics',

  // Trade Journal
  TradeHistory = 'trade_history',

  // Market Monitor
  MarketMonitor = 'market_monitor',

  // Protocol Status
  ProtocolStatus = 'protocol_status',

  // Dry Run
  DryRun = 'dry_run',

  // Source Verification
  SourceVerify = 'source_verify',

  // TP/SL Automation
  SetTpSl = 'set_tp_sl',
  RemoveTpSl = 'remove_tp_sl',
  TpSlStatus = 'tp_sl_status',

  // Limit Orders
  LimitOrder = 'limit_order',
  CancelOrder = 'cancel_order',
  ListOrders = 'list_orders',
  EditLimitOrder = 'edit_limit_order',

  // Close All
  CloseAll = 'close_all',

  // Swap
  Swap = 'swap',

  // Earn (LP & Staking)
  EarnAddLiquidity = 'earn_add_liquidity',
  EarnRemoveLiquidity = 'earn_remove_liquidity',
  EarnStake = 'earn_stake',
  EarnUnstake = 'earn_unstake',
  EarnClaimRewards = 'earn_claim_rewards',
  EarnStatus = 'earn_status',
  EarnInfo = 'earn_info',
  EarnPositions = 'earn_positions',
  EarnBest = 'earn_best',
  EarnSimulate = 'earn_simulate',
  EarnDashboard = 'earn_dashboard',
  EarnPnl = 'earn_pnl',
  EarnDemand = 'earn_demand',
  EarnRotate = 'earn_rotate',
  EarnIntegrations = 'earn_integrations',
  EarnHistory = 'earn_history',
  // FAF Token
  FafStatus = 'faf_status',
  FafStake = 'faf_stake',
  FafUnstake = 'faf_unstake',
  FafClaim = 'faf_claim',
  FafTier = 'faf_tier',
  FafRewards = 'faf_rewards',
  FafReferral = 'faf_referral',
  FafPoints = 'faf_points',
  FafUnstakeRequests = 'faf_unstake_requests',
  FafCancelUnstake = 'faf_cancel_unstake',

  EngineStatus = 'engine_status',
  EngineBenchmark = 'engine_benchmark',
}

// ─── Zod Schemas for Intent Parsing ──────────────────────────────────────────

export const OpenPositionSchema = z.object({
  action: z.literal(ActionType.OpenPosition),
  market: z.string().max(20),
  side: z.nativeEnum(TradeSide),
  collateral: z.number().positive().max(10_000_000),
  leverage: z.number().min(1).max(100), // protocol max 100x; per-market limits enforced at tool level
  collateral_token: z.string().max(20).optional(),
  takeProfit: z.number().positive().optional(),
  stopLoss: z.number().positive().optional(),
});

export const ClosePositionSchema = z.object({
  action: z.literal(ActionType.ClosePosition),
  market: z.string().max(20),
  side: z.nativeEnum(TradeSide),
  closePercent: z.number().min(1).max(100).optional(),
  closeAmount: z.number().positive().optional(),
});

export const AddCollateralSchema = z.object({
  action: z.literal(ActionType.AddCollateral),
  market: z.string().max(20),
  side: z.nativeEnum(TradeSide),
  amount: z.number().positive().max(10_000_000),
});

export const RemoveCollateralSchema = z.object({
  action: z.literal(ActionType.RemoveCollateral),
  market: z.string().max(20),
  side: z.nativeEnum(TradeSide),
  amount: z.number().positive().max(10_000_000),
});

export const GetPositionsSchema = z.object({
  action: z.literal(ActionType.GetPositions),
});

export const GetMarketDataSchema = z.object({
  action: z.literal(ActionType.GetMarketData),
  market: z.string().max(20).optional(),
});

export const GetPortfolioSchema = z.object({
  action: z.literal(ActionType.GetPortfolio),
});

export const GetVolumeSchema = z.object({
  action: z.literal(ActionType.GetVolume),
  period: z.enum(['7d', '30d', 'all']).optional(),
});

export const GetOpenInterestSchema = z.object({
  action: z.literal(ActionType.GetOpenInterest),
});

export const GetLeaderboardSchema = z.object({
  action: z.literal(ActionType.GetLeaderboard),
  metric: z.enum(['pnl', 'volume']).optional(),
  period: z.number().min(1).max(365).optional(),
  limit: z.number().min(1).max(100).optional(),
});

export const GetTraderProfileSchema = z.object({
  action: z.literal(ActionType.GetTraderProfile),
  address: z.string().max(50),
});

export const GetFeesSchema = z.object({
  action: z.literal(ActionType.GetFees),
  period: z.number().min(1).max(365).optional(),
});

export const HelpSchema = z.object({
  action: z.literal(ActionType.Help),
});

export const WalletConnectSchema = z.object({
  action: z.literal(ActionType.WalletConnect),
  path: z.string().max(512),
});

export const WalletImportSchema = z.object({
  action: z.literal(ActionType.WalletImport),
  name: z.string().max(64),
  path: z.string().max(512),
});

export const WalletListSchema = z.object({
  action: z.literal(ActionType.WalletList),
});

export const WalletUseSchema = z.object({
  action: z.literal(ActionType.WalletUse),
  name: z.string().max(64),
});

export const WalletRemoveSchema = z.object({
  action: z.literal(ActionType.WalletRemove),
  name: z.string().max(64),
});

export const WalletDisconnectSchema = z.object({
  action: z.literal(ActionType.WalletDisconnect),
});

export const WalletStatusSchema = z.object({
  action: z.literal(ActionType.WalletStatus),
});

export const WalletAddressSchema = z.object({
  action: z.literal(ActionType.WalletAddress),
});

export const WalletBalanceSchema = z.object({
  action: z.literal(ActionType.WalletBalance),
});

export const WalletTokensSchema = z.object({
  action: z.literal(ActionType.WalletTokens),
});

export const FlashMarketsSchema = z.object({
  action: z.literal(ActionType.FlashMarkets),
});

// AI Agent Schemas
export const AnalyzeSchema = z.object({
  action: z.literal(ActionType.Analyze),
  market: z.string().max(20),
});

export const RiskReportSchema = z.object({
  action: z.literal(ActionType.RiskReport),
});

export const DashboardSchema = z.object({
  action: z.literal(ActionType.Dashboard),
});

export const WhaleActivitySchema = z.object({
  action: z.literal(ActionType.WhaleActivity),
  market: z.string().max(20).optional(),
});

// Market Scanner Schema
// Portfolio Intelligence Schemas
export const PortfolioStateSchema = z.object({
  action: z.literal(ActionType.PortfolioState),
});

export const PortfolioExposureSchema = z.object({
  action: z.literal(ActionType.PortfolioExposure),
});

export const PortfolioRebalanceSchema = z.object({
  action: z.literal(ActionType.PortfolioRebalance),
});

export const LiquidationMapSchema = z.object({
  action: z.literal(ActionType.LiquidationMap),
  market: z.string().max(20).optional(),
});

export const FundingDashboardSchema = z.object({
  action: z.literal(ActionType.FundingDashboard),
  market: z.string().max(20).optional(),
});

export const LiquidityDepthSchema = z.object({
  action: z.literal(ActionType.LiquidityDepth),
  market: z.string().max(20).optional(),
});

export const ProtocolHealthSchema = z.object({
  action: z.literal(ActionType.ProtocolHealth),
});

export const InspectProtocolSchema = z.object({
  action: z.literal(ActionType.InspectProtocol),
});

export const InspectPoolSchema = z.object({
  action: z.literal(ActionType.InspectPool),
  pool: z.string().max(20).optional(),
});

export const InspectMarketSchema = z.object({
  action: z.literal(ActionType.InspectMarket),
  market: z.string().max(20).optional(),
});

export const SystemStatusSchema = z.object({
  action: z.literal(ActionType.SystemStatus),
});

export const SystemAuditSchema = z.object({
  action: z.literal(ActionType.SystemAudit),
});

export const TxMetricsSchema = z.object({
  action: z.literal(ActionType.TxMetrics),
});

export const RpcStatusSchema = z.object({
  action: z.literal(ActionType.RpcStatus),
});

export const RpcTestSchema = z.object({
  action: z.literal(ActionType.RpcTest),
});

export const RpcSetSchema = z.object({
  action: z.literal(ActionType.RpcSet),
  url: z.string().max(500),
});

export const RpcAddSchema = z.object({
  action: z.literal(ActionType.RpcAdd),
  url: z.string().max(500),
});

export const RpcRemoveSchema = z.object({
  action: z.literal(ActionType.RpcRemove),
  url: z.string().max(500),
});

export const RpcListSchema = z.object({
  action: z.literal(ActionType.RpcList),
});

export const TxInspectSchema = z.object({
  action: z.literal(ActionType.TxInspect),
  signature: z.string().max(100).optional(),
});

export const TxDebugSchema = z.object({
  action: z.literal(ActionType.TxDebug),
  signature: z.string().max(100).optional(),
  showState: z.boolean().optional(),
});

export const TradeHistorySchema = z.object({
  action: z.literal(ActionType.TradeHistory),
});

export const MarketMonitorSchema = z.object({
  action: z.literal(ActionType.MarketMonitor),
});

export const ProtocolStatusSchema = z.object({
  action: z.literal(ActionType.ProtocolStatus),
});

export const DryRunSchema = z.object({
  action: z.literal(ActionType.DryRun),
  innerCommand: z.string().max(1000),
});

export const SourceVerifySchema = z.object({
  action: z.literal(ActionType.SourceVerify),
  market: z.string().max(20),
});

export const SetTpSlSchema = z.object({
  action: z.literal(ActionType.SetTpSl),
  market: z.string().max(20),
  side: z.nativeEnum(TradeSide),
  type: z.enum(['tp', 'sl']),
  price: z.number().positive(),
});

export const RemoveTpSlSchema = z.object({
  action: z.literal(ActionType.RemoveTpSl),
  market: z.string().max(20),
  side: z.nativeEnum(TradeSide),
  type: z.enum(['tp', 'sl']),
});

export const TpSlStatusSchema = z.object({
  action: z.literal(ActionType.TpSlStatus),
});

// Limit Order Schemas
export const LimitOrderSchema = z.object({
  action: z.literal(ActionType.LimitOrder),
  market: z.string().max(20),
  side: z.nativeEnum(TradeSide),
  leverage: z.number().min(1).max(100),
  collateral: z.number().positive().max(10_000_000),
  limitPrice: z.number().positive(),
});

export const CancelOrderSchema = z.object({
  action: z.literal(ActionType.CancelOrder),
  orderId: z.string().max(20),
  market: z.string().max(20).optional(),
  side: z.nativeEnum(TradeSide).optional(),
});

export const ListOrdersSchema = z.object({
  action: z.literal(ActionType.ListOrders),
});

export const EditLimitOrderSchema = z.object({
  action: z.literal(ActionType.EditLimitOrder),
  orderId: z.number().int().min(0),
  market: z.string().max(20),
  side: z.nativeEnum(TradeSide),
  limitPrice: z.number().positive().optional(),
});

// ─── Close All / Swap / Earn Schemas ────────────────────────────────────────

export const CloseAllSchema = z.object({
  action: z.literal(ActionType.CloseAll),
});

export const SwapSchema = z.object({
  action: z.literal(ActionType.Swap),
  inputToken: z.string().max(20),
  outputToken: z.string().max(20),
  amount: z.number().positive(),
});

export const EarnAddLiquiditySchema = z.object({
  action: z.literal(ActionType.EarnAddLiquidity),
  amount: z.number().positive(),
  token: z.string().max(20).optional(),
  pool: z.string().max(30).optional(),
});

export const EarnRemoveLiquiditySchema = z.object({
  action: z.literal(ActionType.EarnRemoveLiquidity),
  percent: z.number().min(1).max(100),
  token: z.string().max(20).optional(),
  pool: z.string().max(30).optional(),
});

export const EarnStakeSchema = z.object({
  action: z.literal(ActionType.EarnStake),
  amount: z.number().positive(),
  pool: z.string().max(30).optional(),
});

export const EarnUnstakeSchema = z.object({
  action: z.literal(ActionType.EarnUnstake),
  percent: z.number().min(1).max(100),
  pool: z.string().max(30).optional(),
});

export const EarnClaimRewardsSchema = z.object({
  action: z.literal(ActionType.EarnClaimRewards),
  pool: z.string().max(30).optional(),
});

export const EarnStatusSchema = z.object({
  action: z.literal(ActionType.EarnStatus),
});

export const EarnInfoSchema = z.object({
  action: z.literal(ActionType.EarnInfo),
  pool: z.string().max(30).optional(),
});

export const EarnPositionsSchema = z.object({
  action: z.literal(ActionType.EarnPositions),
});

export const EarnBestSchema = z.object({
  action: z.literal(ActionType.EarnBest),
});

export const EarnSimulateSchema = z.object({
  action: z.literal(ActionType.EarnSimulate),
  pool: z.string().max(30).optional(),
  amount: z.number().positive(),
});

export const EarnDashboardSchema = z.object({
  action: z.literal(ActionType.EarnDashboard),
});

export const EarnPnlSchema = z.object({
  action: z.literal(ActionType.EarnPnl),
});

export const EarnDemandSchema = z.object({
  action: z.literal(ActionType.EarnDemand),
});

export const EarnRotateSchema = z.object({
  action: z.literal(ActionType.EarnRotate),
});

export const EngineStatusSchema = z.object({
  action: z.literal(ActionType.EngineStatus),
});

export const EngineBenchmarkSchema = z.object({
  action: z.literal(ActionType.EngineBenchmark),
});

export const ParsedIntentSchema = z.discriminatedUnion('action', [
  OpenPositionSchema,
  ClosePositionSchema,
  AddCollateralSchema,
  RemoveCollateralSchema,
  GetPositionsSchema,
  GetMarketDataSchema,
  GetPortfolioSchema,
  GetVolumeSchema,
  GetOpenInterestSchema,
  GetLeaderboardSchema,
  GetTraderProfileSchema,
  GetFeesSchema,
  WalletConnectSchema,
  WalletImportSchema,
  WalletListSchema,
  WalletUseSchema,
  WalletRemoveSchema,
  WalletDisconnectSchema,
  WalletStatusSchema,
  WalletAddressSchema,
  WalletBalanceSchema,
  WalletTokensSchema,
  HelpSchema,
  FlashMarketsSchema,
  AnalyzeSchema,
  RiskReportSchema,
  DashboardSchema,
  WhaleActivitySchema,
  PortfolioStateSchema,
  PortfolioExposureSchema,
  PortfolioRebalanceSchema,
  LiquidationMapSchema,
  FundingDashboardSchema,
  LiquidityDepthSchema,
  ProtocolHealthSchema,
  InspectProtocolSchema,
  InspectPoolSchema,
  InspectMarketSchema,
  SystemStatusSchema,
  SystemAuditSchema,
  TxMetricsSchema,
  RpcStatusSchema,
  RpcTestSchema,
  RpcSetSchema,
  RpcAddSchema,
  RpcRemoveSchema,
  RpcListSchema,
  TxInspectSchema,
  TxDebugSchema,
  TradeHistorySchema,
  MarketMonitorSchema,
  ProtocolStatusSchema,
  DryRunSchema,
  SourceVerifySchema,
  SetTpSlSchema,
  RemoveTpSlSchema,
  TpSlStatusSchema,
  LimitOrderSchema,
  CancelOrderSchema,
  ListOrdersSchema,
  EditLimitOrderSchema,
  CloseAllSchema,
  SwapSchema,
  EarnAddLiquiditySchema,
  EarnRemoveLiquiditySchema,
  EarnStakeSchema,
  EarnUnstakeSchema,
  EarnClaimRewardsSchema,
  EarnStatusSchema,
  EarnInfoSchema,
  EarnPositionsSchema,
  EarnBestSchema,
  EarnSimulateSchema,
  EarnDashboardSchema,
  EarnPnlSchema,
  EarnDemandSchema,
  EarnRotateSchema,
  z.object({ action: z.literal(ActionType.EarnIntegrations) }),
  z.object({ action: z.literal(ActionType.EarnHistory), pool: z.string().max(30).optional() }),
  z.object({ action: z.literal(ActionType.FafStatus) }),
  z.object({ action: z.literal(ActionType.FafStake), amount: z.number().positive() }),
  z.object({ action: z.literal(ActionType.FafUnstake), amount: z.number().positive() }),
  z.object({
    action: z.literal(ActionType.FafClaim),
    type: z.enum(['all', 'rewards', 'revenue', 'rebate']).optional(),
  }),
  z.object({ action: z.literal(ActionType.FafTier) }),
  z.object({ action: z.literal(ActionType.FafRewards) }),
  z.object({ action: z.literal(ActionType.FafReferral) }),
  z.object({ action: z.literal(ActionType.FafPoints) }),
  z.object({ action: z.literal(ActionType.FafUnstakeRequests) }),
  z.object({ action: z.literal(ActionType.FafCancelUnstake), requestId: z.number() }),
  EngineStatusSchema,
  EngineBenchmarkSchema,
]);

export type ParsedIntent = z.infer<typeof ParsedIntentSchema>;
export type OpenPositionIntent = z.infer<typeof OpenPositionSchema>;
export type ClosePositionIntent = z.infer<typeof ClosePositionSchema>;
export type AddCollateralIntent = z.infer<typeof AddCollateralSchema>;
export type RemoveCollateralIntent = z.infer<typeof RemoveCollateralSchema>;

// ─── Trade Results ───────────────────────────────────────────────────────────

export interface OpenPositionResult {
  txSignature: string;
  entryPrice: number;
  liquidationPrice: number;
  sizeUsd: number;
  /** True if TP/SL were included in the same atomic transaction */
  triggerOrdersIncluded?: boolean;
}

export interface ClosePositionResult {
  txSignature: string;
  exitPrice: number;
  pnl: number;
  closedSizeUsd?: number;
  remainingSizeUsd?: number;
  isPartial?: boolean;
}

export interface CollateralResult {
  txSignature: string;
  newLeverage?: number;
}

// ─── Order Result Types ──────────────────────────────────────────────────────

export interface PlaceLimitOrderResult {
  txSignature: string;
  market: string;
  side: TradeSide;
  limitPrice: number;
  collateral: number;
  leverage: number;
  sizeUsd: number;
}

export interface PlaceTriggerOrderResult {
  txSignature: string;
  market: string;
  side: TradeSide;
  triggerPrice: number;
  isStopLoss: boolean;
}

export interface CancelOrderResult {
  txSignature: string;
}

export interface OnChainOrder {
  market: string;
  side: TradeSide;
  type: 'limit' | 'take_profit' | 'stop_loss';
  orderId: number;
  price: number;
  size?: number;
  collateral?: number;
}

// ─── Domain Types ────────────────────────────────────────────────────────────

export interface Position {
  pubkey: string;
  market: string;
  side: TradeSide;
  entryPrice: number;
  currentPrice: number;
  markPrice: number;
  sizeUsd: number;
  collateralUsd: number;
  leverage: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  liquidationPrice: number;
  openFee: number;
  totalFees: number;
  fundingRate: number;
  timestamp: number;
}

export interface MarketData {
  symbol: string;
  price: number;
  priceChange24h: number;
  openInterestLong: number;
  openInterestShort: number;
  maxLeverage: number;
  fundingRate: number;
}

export interface Portfolio {
  walletAddress: string;
  balance: number;
  balanceLabel: string;
  totalCollateralUsd: number;
  totalUnrealizedPnl: number;
  totalRealizedPnl: number;
  totalFees: number;
  positions: Position[];
  totalPositionValue: number;
  usdcBalance?: number;
}

export interface VolumeData {
  period: string;
  totalVolumeUsd: number;
  trades: number;
  uniqueTraders: number;
  dailyVolumes: DailyVolume[];
}

export interface DailyVolume {
  date: string;
  volumeUsd: number;
  trades: number;
  longVolume: number;
  shortVolume: number;
  liquidationVolume: number;
}

export interface OpenInterestData {
  markets: MarketOI[];
}

export interface MarketOI {
  market: string;
  longOi: number;
  shortOi: number;
  longPositions: number;
  shortPositions: number;
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  pnl: number;
  volume: number;
  trades: number;
  winRate: number;
}

export interface TraderProfile {
  address: string;
  totalTrades: number;
  totalVolume: number;
  totalPnl: number;
  winRate: number;
  markets: Record<string, { trades: number; volume: number; pnl: number }>;
}

export interface FeeData {
  period: string;
  totalFees: number;
  lpShare: number;
  tokenShare: number;
  teamShare: number;
  dailyFees: { date: string; totalFees: number }[];
}

export interface OverviewStats {
  volumeUsd: number;
  volumeChangePct: number;
  trades: number;
  tradesChangePct: number;
  feesUsd: number;
  poolPnlUsd: number;
  poolRevenueUsd: number;
  uniqueTraders: number;
}

// ─── AI Agent Domain Types ───────────────────────────────────────────────────

export interface StrategySignal {
  name: string;
  signal: 'bullish' | 'bearish' | 'neutral';
  confidence: number; // 0-1
  reasoning: string;
}

export interface RiskAssessment {
  market: string;
  side: TradeSide;
  leverage: number;
  distanceToLiquidation: number; // percentage
  riskLevel: 'healthy' | 'warning' | 'critical';
  message: string;
}

export interface MarketAnalysis {
  market: string;
  price: number;
  priceChange24h: number;
  openInterestLong: number;
  openInterestShort: number;
  volume24h: number;
  signals: StrategySignal[];
  summary: string;
}

export interface ExposureSummary {
  totalLongExposure: number;
  totalShortExposure: number;
  netExposure: number;
  totalCollateral: number;
  collateralUtilization: number; // percentage
  concentrationRisk: { market: string; percentage: number }[];
}

// ─── Market Scanner Types ───────────────────────────────────────────────────

export interface Opportunity {
  market: string;
  direction: TradeSide;
  confidence: number;
  volumeScore: number;
  oiScore: number;
  whaleScore: number;
  totalScore: number;
  recommendedLeverage: number;
  recommendedCollateral: number;
  signals: StrategySignal[];
  reasoning: string;
  regime?: string;
}

// ─── Raw Data Types (from fstats API) ────────────────────────────────────────

export interface RawActivityRecord {
  market_symbol?: string;
  market?: string;
  side?: string;
  size_usd?: number;
  mark_price?: number;
  entry_price?: number;
  timestamp?: number;
  [key: string]: unknown;
}

// ─── Dry Run Preview ──────────────────────────────────────────────────────

export interface DryRunPreview {
  market: string;
  side: TradeSide;
  collateral: number;
  leverage: number;
  positionSize: number;
  entryPrice: number;
  liquidationPrice: number;
  estimatedFee: number;
  programId?: string;
  accountCount?: number;
  instructionCount?: number;
  estimatedComputeUnits?: number;
  transactionSize?: number;
  simulationSuccess?: boolean;
  simulationLogs?: string[];
  simulationError?: string;
  simulationUnitsConsumed?: number;
}

// ─── Client Interfaces ───────────────────────────────────────────────────────

export interface IFlashClient {
  readonly walletAddress: string;

  openPosition(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string,
  ): Promise<OpenPositionResult>;

  closePosition(
    market: string,
    side: TradeSide,
    receiveToken?: string,
    closePercent?: number,
    closeAmount?: number,
  ): Promise<ClosePositionResult>;

  addCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult>;

  removeCollateral(market: string, side: TradeSide, amount: number): Promise<CollateralResult>;

  getPositions(): Promise<Position[]>;
  getMarketData(market?: string): Promise<MarketData[]>;
  getPortfolio(): Promise<Portfolio>;
  getBalance(): number;

  /** Get recent trade history (simulation mode). */
  getTradeHistory?(): SimulatedTrade[];

  /** Open position with optional TP/SL in a single atomic transaction. */
  openPositionAtomic?(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string,
    takeProfit?: number,
    stopLoss?: number,
  ): Promise<OpenPositionResult>;

  /** Build a transaction preview without signing or sending. */
  previewOpenPosition?(
    market: string,
    side: TradeSide,
    collateralAmount: number,
    leverage: number,
    collateralToken?: string,
  ): Promise<DryRunPreview>;

  // ─── On-Chain Order Methods ─────────────────────────────────────────────

  /** Place an on-chain limit order via Flash SDK */
  placeLimitOrder?(
    market: string,
    side: TradeSide,
    collateral: number,
    leverage: number,
    limitPrice: number,
    stopLoss?: number,
    takeProfit?: number,
  ): Promise<PlaceLimitOrderResult>;

  /** Place an on-chain trigger order (TP or SL) via Flash SDK */
  placeTriggerOrder?(
    market: string,
    side: TradeSide,
    triggerPrice: number,
    isStopLoss: boolean,
  ): Promise<PlaceTriggerOrderResult>;

  /** Cancel an on-chain trigger order */
  cancelTriggerOrder?(
    market: string,
    side: TradeSide,
    orderId: number,
    isStopLoss: boolean,
  ): Promise<CancelOrderResult>;

  /** Cancel all trigger orders for a position */
  cancelAllTriggerOrders?(market: string, side: TradeSide): Promise<CancelOrderResult>;

  /** Cancel an on-chain limit order */
  cancelLimitOrder?(market: string, side: TradeSide, orderId: number): Promise<CancelOrderResult>;

  /** Edit an on-chain limit order price */
  editLimitOrder?(market: string, side: TradeSide, orderId: number, newLimitPrice: number): Promise<CancelOrderResult>;

  /** Get all on-chain orders for the current wallet */
  getUserOrders?(): Promise<OnChainOrder[]>;

  // ─── Swap ───────────────────────────────────────────────────────────────

  /** Swap tokens via Flash Trade pool */
  swap?(inputToken: string, outputToken: string, amountIn: number, minAmountOut?: number): Promise<SwapResult>;

  // ─── Earn (LP & Staking) ──────────────────────────────────────────────

  /** Add liquidity to a pool */
  addLiquidity?(tokenSymbol: string, amountUsd: number, pool?: string): Promise<EarnResult>;

  /** Remove liquidity from a pool */
  removeLiquidity?(tokenSymbol: string, percent: number, pool?: string): Promise<EarnResult>;

  /** Stake FLP tokens */
  stakeFLP?(amountUsd: number, pool?: string): Promise<EarnResult>;

  /** Unstake FLP tokens */
  unstakeFLP?(percent: number, pool?: string): Promise<EarnResult>;

  /** Claim staking/LP rewards */
  claimRewards?(pool?: string): Promise<EarnResult>;
}

// ─── Swap & Earn Result Types ──────────────────────────────────────────────

export interface SwapResult {
  txSignature: string;
  inputToken: string;
  outputToken: string;
  amountIn: number;
  amountOut: number;
  price: number;
}

export interface EarnResult {
  txSignature: string;
  action: string;
  amount?: number;
  token?: string;
  message: string;
}

export interface IDataClient {
  getOverviewStats(period?: '7d' | '30d' | 'all'): Promise<OverviewStats>;
  getVolume(days?: number, pool?: string): Promise<VolumeData>;
  getOpenInterest(): Promise<OpenInterestData>;
  getLeaderboard(metric?: 'pnl' | 'volume', days?: number, limit?: number): Promise<LeaderboardEntry[]>;
  getTraderProfile(address: string): Promise<TraderProfile>;
  getFees(days?: number): Promise<FeeData>;
  getRecentActivity?(limit?: number): Promise<RawActivityRecord[]>;
  getOpenPositions?(): Promise<RawActivityRecord[]>;
}

// ─── Tool System Types ───────────────────────────────────────────────────────

export interface ToolExecutionData {
  executeAction?: () => Promise<ToolResult>;
  positions?: Position[];
  markets?: MarketData[];
  portfolio?: Portfolio;
  volume?: VolumeData;
  openInterest?: OpenInterestData;
  leaderboard?: LeaderboardEntry[];
  traderProfile?: TraderProfile;
  fees?: FeeData;
  analysis?: MarketAnalysis;
  riskAssessments?: RiskAssessment[];
  exposure?: ExposureSummary;
  opportunities?: Opportunity[];
  [key: string]: unknown;
}

export interface ToolResult {
  success: boolean;
  data?: ToolExecutionData;
  message: string;
  txSignature?: string;
  requiresConfirmation?: boolean;
  confirmationPrompt?: string;
}

export interface ToolContext {
  flashClient: IFlashClient;
  dataClient: IDataClient;
  simulationMode: boolean;
  degenMode: boolean;
  walletAddress: string;
  walletName: string;
  walletManager: WalletManager;
  /** Runtime config (for reading referrer address, etc.) */
  config?: FlashConfig;
  /** In-memory log of trades executed during this session (live + sim). */
  sessionTrades?: SessionTrade[];
}

/** A trade executed during the current terminal session. */
export interface SessionTrade {
  action: 'open' | 'close' | 'partial_close' | 'add_collateral' | 'remove_collateral';
  market: string;
  side: string;
  leverage?: number;
  collateral?: number;
  sizeUsd?: number;
  entryPrice?: number;
  exitPrice?: number;
  pnl?: number;
  /** Fee paid at position open (stored for visibility after protocol settles fees) */
  openFeePaid?: number;
  /** Reason for close (manual, TAKE_PROFIT, STOP_LOSS) */
  closeReason?: string;
  txSignature?: string;
  timestamp: number;
}

export interface ToolDefinition<TParams = Record<string, unknown>> {
  name: string;
  description: string;
  parameters?: import('zod').ZodType<TParams>;
  execute: (params: TParams, context: ToolContext) => Promise<ToolResult>;
}

// ─── Config Types ────────────────────────────────────────────────────────────

export const VALID_NETWORKS = ['mainnet-beta', 'devnet'] as const;
export type Network = (typeof VALID_NETWORKS)[number];

export interface FlashConfig {
  rpcUrl: string;
  backupRpcUrls: string[];
  pythnetUrl: string;
  walletPath: string;
  defaultPool: string;
  network: Network;
  simulationMode: boolean;
  defaultSlippageBps: number;
  computeUnitLimit: number;
  computeUnitPrice: number;
  logFile: string | null;
  // Signing guard limits (0 = unlimited / use market defaults)
  maxCollateralPerTrade: number;
  maxPositionSize: number;
  maxLeverage: number;
  maxTradesPerMinute: number;
  minDelayBetweenTradesMs: number;
  defaultLeverage: number;
  /** Enable dynamic compute unit limit based on simulation (default: true) */
  dynamicCompute: boolean;
  /** Safety buffer percent for dynamic CU limit (default: 20) */
  computeBufferPercent: number;
  /** Enable leader-aware routing and TPU forwarding (default: true) */
  leaderRouting: boolean;
  /** Rebroadcast interval in ms when awaiting confirmation (default: 800) */
  rebroadcastIntervalMs: number;
  /** Disable plugin loading (--no-plugins flag) */
  noPlugins?: boolean;
  /** Referrer wallet address for referral rebates (defaults to CLI owner) */
  referrerAddress?: string;
}

// ─── Simulation Types ────────────────────────────────────────────────────────

export interface SimulatedPosition {
  id: string;
  market: string;
  side: TradeSide;
  entryPrice: number;
  sizeUsd: number;
  collateralUsd: number;
  leverage: number;
  openFee: number;
  openedAt: number;
  /** Maintenance margin rate from protocol (1/maxLeverage). Stored at open time. */
  maintenanceMarginRate: number;
  /** Close fee rate from protocol. Stored at open time. */
  closeFeeRate: number;
  /** Take-profit price (simulation TP/SL) */
  takeProfit?: number;
  /** Stop-loss price (simulation TP/SL) */
  stopLoss?: number;
}

export interface SimulationState {
  balance: number;
  positions: SimulatedPosition[];
  tradeHistory: SimulatedTrade[];
  totalRealizedPnl: number;
  totalFeesPaid: number;
}

export interface SimulatedTrade {
  id: string;
  action: string;
  market: string;
  side: TradeSide;
  sizeUsd: number;
  collateralUsd: number;
  leverage: number;
  price: number;
  entryPrice?: number;
  pnl?: number;
  timestamp: number;
}

// ─── Validation ──────────────────────────────────────────────────────────────

// Per-market leverage limits — delegates to config which reads from Flash SDK.
// The tool layer enforces normal vs degen mode; this uses degenMaxLev as absolute ceiling.
// Injected at startup by config module to avoid circular import.

let _leverageFn: ((market: string, degen?: boolean) => number) | null = null;

/** Called by config module at load time to inject SDK-based leverage lookup. */
export function injectLeverageFn(fn: (market: string, degen?: boolean) => number): void {
  _leverageFn = fn;
}

export function getLeverageLimits(market: string): { min: number; max: number } {
  const max = _leverageFn ? _leverageFn(market, true) : 100;
  return { min: 1.1, max: max || 100 };
}

export interface TradeValidation {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

export function validateTrade(
  market: string,
  side: TradeSide,
  collateral: number,
  leverage: number,
  balance: number,
): TradeValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const limits = getLeverageLimits(market);

  if (collateral <= 0) errors.push('Collateral must be positive');
  if (collateral > balance) errors.push(`Insufficient balance: $${balance.toFixed(2)} available`);
  if (leverage < limits.min) errors.push(`Minimum leverage for ${market}: ${limits.min}x`);
  if (leverage > limits.max) errors.push(`Maximum leverage for ${market}: ${limits.max}x`);

  // Warnings
  if (leverage >= 20) warnings.push(`High leverage (${leverage}x) — liquidation risk is significant`);
  if (leverage >= 50) warnings.push('Extreme leverage — small price moves can liquidate');

  // Rough pre-trade estimate — actual liq distance computed by SDK post-trade
  const liqDistance = (1 / leverage) * 100;
  if (liqDistance < 5) {
    warnings.push(`~${liqDistance.toFixed(1)}% estimated distance to liquidation`);
  }

  if (collateral > balance * 0.5) {
    warnings.push(`Using ${((collateral / balance) * 100).toFixed(0)}% of available balance`);
  }

  return { valid: errors.length === 0, warnings, errors };
}
