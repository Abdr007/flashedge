/**
 * Shadow Trading — parallel simulation and risk mirror exports.
 */

export { ShadowEngine, getShadowEngine, initShadowEngine } from './shadow-engine.js';
export type { ShadowTradeResult, ShadowState } from './shadow-engine.js';

export { RiskMirror, getRiskMirror, initRiskMirror } from './risk-mirror.js';
export type { RiskDivergence, RiskMirrorSnapshot, RiskMirrorConfig } from './risk-mirror.js';
