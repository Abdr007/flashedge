/**
 * Market Registry — public exports.
 */

export {
  MarketType,
  getMarketMeta,
  getAllMarketMeta,
  getRegisteredSymbols,
  getPythFeedIdFromRegistry,
  getAllPythFeedIds,
  resolveAlias,
  getAllAliases,
  getMarketCluster,
  getAllClusters,
  getMarketGroup,
  getAllGroups,
  getDefaultSlippageBps,
  getSizingMultiplier,
  getMarketType,
  getMarketsByType,
  getMarketsByCluster,
  getRegistryStats,
  refreshRegistry,
} from './market-registry.js';

export type { MarketMeta, RegistryStats } from './market-registry.js';

export {
  MarketTier,
  QualificationStatus,
  getQualificationTracker,
  initQualificationTracker,
} from './market-qualification.js';

export type {
  MarketQualification,
  MarketSignal,
  QualificationStats,
} from './market-qualification.js';

export {
  getMarketPerfMonitor,
  initMarketPerfMonitor,
} from './market-perf-monitor.js';

export type {
  MarketPerf,
  TickBudgetStatus,
  SafeModeState,
  EdgeBreakdown,
  TypeEdge,
  ClusterEdge,
} from './market-perf-monitor.js';
