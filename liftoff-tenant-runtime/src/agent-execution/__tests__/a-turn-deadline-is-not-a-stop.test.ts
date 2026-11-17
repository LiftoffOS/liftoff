/**
 * A bound closing is not a person stopping.
 *
 * Two things write an `abort` signal row and they mean opposite things.
 * `POST /stop` is someone asking for an end. The chat turn's hard deadline is
 * the TURN ending while the work carries on in the background — which is what
 * a continuation is for. The handler that writes it already knows the
 * difference: it tracks `hardTimedOut` so it can tell "a turn a BOUND closed"
 * from "a turn a person stopped". The distinction stopped at the row.
 *
 * A continuation runs under the SAME invocation id, so it can read its own
 * turn's deadline as a stop request: the run parks correctly with its loop
 * position carried, then the continuation consumes the abort and ends at once
 * with zero tool calls and `terminal_state: stopped`. Long research, parked
 * properly, stopped by its own turn's clock.
 *
 * It is reachable whenever the run's ceiling equals the turn's deadline, so the
 * two fire together. Both halves are guarded: the ceilings nest, AND the reason
 * is read — because nesting alone would leave this one clock-skew away from
 * happening.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_MAX_WALL_CLOCK_MS,
  CHAT_TURN_HARD_TIMEOUT_MS,
  CHAT_TURN_DEADLINE_ABORT_REASON,
  AGENT_TASK_DISPATCH_DEADLINE_SECONDS,
  PARK_RESERVE_MS,
} from '../constants';

const SERVICE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
const HANDLER = readFileSync(join(__dirname, '..', '..', 'interactive-chat', 'chat-turn-handler.ts'), 'utf8');

describe('the ceilings nest: the run parks before the turn aborts', () => {
  it('the run ceiling is strictly below the chat turn deadline', () => {
    // Equal is not below. Equal is what lets the two clocks fire together.
    expect(DEFAULT_MAX_WALL_CLOCK_MS).toBeLessThan(CHAT_TURN_HARD_TIMEOUT_MS);
  });

  it('leaves the park its own room under that deadline', () => {
    expect(DEFAULT_MAX_WALL_CLOCK_MS + PARK_RESERVE_MS)
      .toBeLessThanOrEqual(CHAT_TURN_HARD_TIMEOUT_MS);
  });

  it('still fits the dispatch deadline, which bounds it independently', () => {
    expect(DEFAULT_MAX_WALL_CLOCK_MS + PARK_RESERVE_MS)
      .toBeLessThanOrEqual(AGENT_TASK_DISPATCH_DEADLINE_SECONDS * 1_000);
  });

  it('derives from the TIGHTEST bound rather than one of them', () => {
    const src = readFileSync(join(__dirname, '..', 'constants.ts'), 'utf8');
    expect(src).toMatch(/Math\.min\(\s*\n?\s*AGENT_TASK_DISPATCH_DEADLINE_SECONDS \* 1_000,\s*\n?\s*CHAT_TURN_HARD_TIMEOUT_MS,/);
  });

  it('the handler uses the shared constant, so the two cannot drift apart', () => {
    expect(HANDLER).toContain('const HARD_TIMEOUT_MS = CHAT_TURN_HARD_TIMEOUT_MS;');
  });
});

describe('the reason travels, and the loop reads it', () => {
  it('the writer stamps the shared constant', () => {
    expect(HANDLER).toContain('reason: CHAT_TURN_DEADLINE_ABORT_REASON');
  });

  it('the value is the one already in the database, so old rows still match', () => {
    // Rows written before this constant existed carry the literal string.
    expect(CHAT_TURN_DEADLINE_ABORT_REASON).toBe('chat_turn_hard_timeout');
  });

  it('checkAbortSignal selects the reason out of the payload', () => {
    expect(SERVICE).toMatch(/RETURNING id, payload->>'reason' AS reason/);
  });

  it('a turn-deadline abort does NOT stop the run', () => {
    const at = SERVICE.indexOf('private async checkAbortSignal(');
    const fn = SERVICE.slice(at, at + 2_600);
    expect(fn).toMatch(/if \(row\.reason === CHAT_TURN_DEADLINE_ABORT_REASON\) \{[\s\S]{0,400}?return false;/);
  });

  it('a stop request still does', () => {
    const at = SERVICE.indexOf('private async checkAbortSignal(');
    const fn = SERVICE.slice(at, at + 2_600);
    // Anything that is NOT the turn deadline ends the run, and that answer is
    // given after the deadline case has had its chance. Asserted as order
    // rather than as the function's last bytes, which said nothing about which
    // branch reached them.
    const deadlineReturn = fn.indexOf('return false;');
    const stopReturn = fn.lastIndexOf('return true;');
    expect(deadlineReturn).toBeGreaterThan(-1);
    expect(stopReturn).toBeGreaterThan(deadlineReturn);
    // And "no row at all" is still not a stop.
    expect(fn).toMatch(/if \(!row\) return false;/);
  });

  it('consumes the row either way, so the next boundary does not re-ask', () => {
    const at = SERVICE.indexOf('private async checkAbortSignal(');
    const fn = SERVICE.slice(at, at + 2_600);
    // The UPDATE consumes before the reason is read; the early return is after.
    expect(fn.indexOf('SET consumed_at = NOW()')).toBeLessThan(fn.indexOf('row.reason ==='));
  });
});
