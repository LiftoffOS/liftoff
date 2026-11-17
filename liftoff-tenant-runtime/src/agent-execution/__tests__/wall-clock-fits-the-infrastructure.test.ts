/**
 * The wall clock, the dispatch deadline and Cloud Run's timeout are ONE
 * decision expressed in three places.
 *
 * They had drifted. Cloud Run gives agent-service 900 seconds, the Cloud Tasks
 * dispatch deadline is set to 870 "deliberately below it so a real timeout is
 * reported by the service that ran the work" — and the run's own wall clock was
 * 600, which tracked neither. Every invocation stopped four and a half minutes
 * early, and a long run paid the difference in PARKS.
 *
 * That is the cost this test exists to prevent, and it is not caution: a park
 * is the one moment in a run where state has to survive an invocation
 * boundary, which is where this workflow engine has broken repeatedly. Unused
 * ceiling buys extra parks, not safety.
 *
 * `cloud-tasks.ts` says it already: "If agent-service's timeoutSeconds moves,
 * move this with it — they are one decision expressed in two places." It is
 * three, and nothing held them together.
 */
import {
  DEFAULT_MAX_WALL_CLOCK_MS,
  AGENT_TASK_DISPATCH_DEADLINE_SECONDS,
  AGENT_SERVICE_REQUEST_TIMEOUT_SECONDS,
  PARK_RESERVE_MS,
} from '../constants';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('the ceilings nest, outermost first', () => {
  it('the dispatch deadline sits under Cloud Run’s request timeout', () => {
    expect(AGENT_TASK_DISPATCH_DEADLINE_SECONDS).toBeLessThan(AGENT_SERVICE_REQUEST_TIMEOUT_SECONDS);
  });

  it('the wall clock plus the park’s own reserve sits under the dispatch deadline', () => {
    // The park happens AFTER the ceiling is reached — a row write and a task
    // enqueue — so the reserve is not slack, it is the work that still has to
    // happen for the run to continue at all.
    expect(DEFAULT_MAX_WALL_CLOCK_MS + PARK_RESERVE_MS)
      .toBeLessThanOrEqual(AGENT_TASK_DISPATCH_DEADLINE_SECONDS * 1_000);
  });

  it('leaves room for a STEP that is still running when the ceiling is reached', () => {
    // The ceiling is checked BETWEEN steps, so reaching it does not park the
    // run: the step in flight finishes first. Measured, the park landed 46
    // seconds after the ceiling — past the turn deadline, which had already
    // finished the response, so the park was never delivered and the person was
    // told the run had stopped on an error.
    //
    // This replaces an assertion that the ceiling must use ~80% of the window.
    // That was half right: unused ceiling does buy extra parks, but a park that
    // cannot be delivered is worse than one more park, and a continuation that
    // actually continues makes parks cheap.
    const { STEP_OVERSHOOT_RESERVE_MS, CHAT_TURN_HARD_TIMEOUT_MS } =
      jest.requireActual('../constants') as { STEP_OVERSHOOT_RESERVE_MS: number; CHAT_TURN_HARD_TIMEOUT_MS: number };
    expect(DEFAULT_MAX_WALL_CLOCK_MS + PARK_RESERVE_MS + STEP_OVERSHOOT_RESERVE_MS)
      .toBeLessThanOrEqual(CHAT_TURN_HARD_TIMEOUT_MS);
    // And the reserve has to cover the longest step the loop itself allows.
    const { STEP_TIMEOUT_MS_BY_TOOL } = jest.requireActual('../constants') as { STEP_TIMEOUT_MS_BY_TOOL: Record<string, number> };
    expect(STEP_OVERSHOOT_RESERVE_MS).toBeGreaterThanOrEqual(Math.max(...Object.values(STEP_TIMEOUT_MS_BY_TOOL)));
  });

  it('is overridable, so an environment can be tuned without a deploy of this constant', () => {
    const src = readFileSync(join(__dirname, '..', 'constants.ts'), 'utf8');
    expect(src).toMatch(/DEFAULT_MAX_WALL_CLOCK_MS = Number\(\s*\n?\s*process\.env\.DEFAULT_MAX_WALL_CLOCK_MS/);
  });
});

describe('the mirrored value matches the layer it mirrors', () => {
  it('cloud-tasks.ts uses the same dispatch-deadline default', () => {
    // Mirrored rather than imported to keep the task layer out of the agent
    // loop's dependency graph, so the two copies are held together here.
    const src = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'cloud-tasks.ts'), 'utf8');
    const m = src.match(/AGENT_TASK_DISPATCH_DEADLINE_SECONDS\);?\s*\n?\s*return Number\.isFinite\(raw\) && raw > 0 \? raw : (\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(AGENT_TASK_DISPATCH_DEADLINE_SECONDS);
  });

  it('names the same environment variable, so one override moves both', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'cloud-tasks.ts'), 'utf8');
    expect(src).toContain('process.env.AGENT_TASK_DISPATCH_DEADLINE_SECONDS');
  });
});

describe('what the wall clock is NOT', () => {
  it('is not the limit on how long a run may take', () => {
    // A run that reaches the ceiling at a resumable point continues in a fresh
    // invocation. Reading this constant as the product limit is what made ten
    // minutes look defensible.
    const { MAX_RUN_CONTINUATIONS } = jest.requireActual('../constants') as { MAX_RUN_CONTINUATIONS: number };
    expect(MAX_RUN_CONTINUATIONS).toBeGreaterThan(1);
  });
});
