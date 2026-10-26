/**
 * proba-memory evaluation harness: golden sets, ranking metrics, time-split backtest, profile comparison,
 * regression gate and shadow-log analysis. Runs on in-process adapters (hash embedder, scripted LLM): no
 * network, no model, deterministic.
 */
export * from './golden.js';
export * from './metrics.js';
export * from './profiles.js';
export * from './backtest.js';
export * from './run.js';
export * from './compare.js';
export * from './report.js';
export * from './gate.js';
export * from './shadow.js';
export * from './config.js';
export * from './stack.js';
export { runCli } from './cli.js';
