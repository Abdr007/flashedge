export { PortfolioManager } from './portfolio-manager.js';
export type { PortfolioState, PortfolioPosition } from './portfolio-manager.js';
export { computeAllocation, filterOpportunities, ALLOCATION_LIMITS } from './allocation-engine.js';
export { checkPortfolioRisk } from './portfolio-risk.js';
export { analyzeRebalance } from './rebalance.js';
export type { RebalanceResult, RebalanceAction } from './rebalance.js';
export { checkCorrelation, areCorrelated, getCorrelatedMarkets } from './correlation.js';
