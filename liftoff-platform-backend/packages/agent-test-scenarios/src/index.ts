/**
 * @liftoffos/agent-test-scenarios
 *
 * Shared test-harness scenarios + assertion helpers. Consumed by two
 * runners that probe different surfaces of the same agent stack:
 *
 *   1. TR-side runner — hits tenant-runtime's
 *      POST /api/internal/test-harness/run-agent. Drives executeTask
 *      directly. EXECUTION-LAYER probe (fast, full args/result detail).
 *
 *   2. PB-side runner — hits platform-backend's
 *      POST /api/internal/test-harness/run-chat. Drives runAgentChatTurn
 *      (which forwards to TR via Connect-RPC). END-TO-END probe through
 *      the full PB→TR contract.
 *
 * Both runners produce AgentHarnessRunResult and call the same
 * assertScenario(). Adding a scenario = one append to scenarios.ts;
 * both surfaces start running it on the next CLI invocation.
 */

export * from './types.js';
export { SCENARIOS } from './scenarios.js';
// Per-agent scenario sets for the diagnostics harness's non-user-created
// runtimes (workforce-service CAIO/HRBP, platform-backend Insights). These run
// through the diagnostics active driver / canary smoke variants, not the
// user-created TR/PB harness.
export { CAIO_SCENARIOS } from './scenarios-caio.js';
export { HRBP_SCENARIOS } from './scenarios-hrbp.js';
export { INSIGHTS_SCENARIOS } from './scenarios-insights.js';
export { ADVERSARIAL_SCENARIOS } from './scenarios-adversarial.js';
export { SWE_SCENARIOS } from './scenarios-swe.js';
export { assertScenario, matchBareName } from './assert.js';
export { NO_INNER_WORKINGS, withNoInnerWorkings } from './inner-workings.js';
