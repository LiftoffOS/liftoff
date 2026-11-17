// Kills, not flags. Each is the switch for a code defect in one item and
// defaults on; `0` is today's path exactly. See docs/agent-service-flags.md.
// Each read names its variable outright, so the lint that keeps secrets out
// of bare process.env reads can see every one of them.

const on = (value: string | undefined): boolean => value !== '0';

/** Phase 2: the Jev loop on every browser this runtime holds a CDP endpoint to. */
export function isJevBrowserLoopEnabled(): boolean { return on(process.env.TR_JEV_BROWSER_LOOP_ENABLED); }
/** The check that a step which reports work actually did it.
 *
 *  OPT IN, not opt out, unlike every flag beside it. The others gate a read
 *  or a refusal; this one can send real work back round, and a step that
 *  genuinely did send the message and merely failed to prove it must not be
 *  re-run because a default was on. It earns its default by being measured
 *  first. */
export function isWorkDoneCheckEnabled(): boolean { return process.env.TR_WORK_DONE_CHECK_ENABLED === '1'; }
/** Phase 5: the contract check in checkHitlGate. */
export function isContractCheckEnabled(): boolean { return on(process.env.TR_CONTRACT_CHECK_ENABLED); }
/** Phase 6, Change A: the ask check before a park or a customer-facing escalation. */
export function isAskCheckEnabled(): boolean { return on(process.env.TR_ASK_CHECK_ENABLED); }
/** Phase 6, Change B: the Escalation setting governs surfacing. */
export function isSurfacingPolicyEnabled(): boolean { return on(process.env.TR_SURFACING_POLICY_ENABLED); }
/** Phase 8, Change A: admission and kind at the agent's own save. */
export function isMemoryAdmitEnabled(): boolean { return on(process.env.TR_MEMORY_ADMIT_ENABLED); }
/** Phase 8, Change B: usefulness per injected memory at run end. */
export function isMemoryUsedEnabled(): boolean { return on(process.env.TR_MEMORY_USED_ENABLED); }
/** Phase 7: the Communication setting reads the message. */
export function isMessageCheckEnabled(): boolean { return on(process.env.TR_MESSAGE_CHECK_ENABLED); }
/** The semantic pass inside screenUntrustedText, and the Jev loop's own call
 *  to it. Off, the deterministic detector exactly as today. */
export function isContentScreenEnabled(): boolean { return on(process.env.TR_CONTENT_SCREEN_ENABLED); }
