// A tool_call step runs under a timeout the step declares or the default. The
// default is one minute, and a browser task — several page actions, each a
// model call — outlasts it while finishing correctly, so the step was marked
// failed with its result arriving afterwards. Known long tools get a default
// of their own.

import { DEFAULT_STEP_TIMEOUT_MS, STEP_TIMEOUT_MS_BY_TOOL, defaultStepTimeoutMs } from '../constants';

describe('defaultStepTimeoutMs', () => {
  it('gives a browser task longer than the tool bounds itself to', () => {
    expect(defaultStepTimeoutMs('run_browser_task')).toBe(STEP_TIMEOUT_MS_BY_TOOL.run_browser_task);
    expect(defaultStepTimeoutMs('run_browser_task')).toBeGreaterThan(180_000);
  });

  it('keeps the default for every other tool, and for a step with no tool', () => {
    expect(defaultStepTimeoutMs('zoho__list_accounts')).toBe(DEFAULT_STEP_TIMEOUT_MS);
    expect(defaultStepTimeoutMs(undefined)).toBe(DEFAULT_STEP_TIMEOUT_MS);
  });
});
