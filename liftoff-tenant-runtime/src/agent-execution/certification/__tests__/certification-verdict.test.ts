/**
 * An unfunded vendor account is an inconclusive certification, not a failed one.
 *
 * The fixtures are two failed-check shapes: Anthropic refusing an account out
 * of credit, and the OpenRouter wire failing as "Connection error." because our
 * own fetch wrapper broke every request. The first proves nothing about the engine; the second is exactly the
 * defect the gate exists to stop, so it must stay a failure.
 */

import { certificationVerdict, failedOnlyForFunding } from '../certify';
import type { EngineCertificationResult } from '../types';

function result(
  engine: EngineCertificationResult['engine'],
  failed: Array<[string, string | undefined]>,
): EngineCertificationResult {
  return {
    engine,
    provider: 'anthropic',
    runtimeVersion: 'test',
    imageRevision: 'test',
    contractVersion: '1.0.0',
    passed: failed.length === 0,
    checks: {},
    checkDetail: failed.map(([name, detail]) => ({
      category: 'invocation_and_termination',
      name,
      passed: false,
      ...(detail ? { detail } : {}),
    })),
  } as EngineCertificationResult;
}

const passed = result('openai-agents', []);

const unfundedAnthropic = result('claude-agent-sdk', [
  ['catalog_reaches_model', 'the model never called probe_tool: tools called=[]; terminal=success (success); said="Credit balance is too low"'],
  ['permission_decision_deny_prevents_execution_and_leak', 'Claude Code returned an error result: Credit balance is too low'],
  ['emits_usage_with_tokens', undefined],
]);

const brokenOpenRouter = result('openrouter-openai-wire', [
  ['catalog_reaches_model', 'the model never called probe_tool: tools called=[]; terminal=error (Connection error.); said=""'],
  ['clean_stream_completes_success_not_empty', 'terminal outcome=\'error\' reason="Connection error."'],
  ['emits_usage_with_tokens', undefined],
]);

describe('failedOnlyForFunding', () => {
  it('is true when every reason is the vendor refusing the account', () => {
    expect(failedOnlyForFunding(unfundedAnthropic)).toBe(true);
  });

  it.each([
    ['a 402', '402 Your organization has no available TypeSafe API credits.'],
    ['OpenAI quota', '429 You exceeded your current quota, please check your plan and billing details.'],
    ['an insufficient_quota code', 'insufficient_quota'],
  ])('recognises %s', (_name, detail) => {
    expect(failedOnlyForFunding(result('openai-agents', [['clean_stream_completes_success_not_empty', detail]]))).toBe(true);
  });

  it('is false for a connection error', () => {
    expect(failedOnlyForFunding(brokenOpenRouter)).toBe(false);
  });

  it('is false when a funding refusal sits beside any other reason', () => {
    const mixed = result('claude-agent-sdk', [
      ['catalog_reaches_model', 'Credit balance is too low'],
      ['hooks_fire_per_call_with_deny_isolation', 'the deny hook did not fire'],
    ]);
    expect(failedOnlyForFunding(mixed)).toBe(false);
  });

  it('is false when no failed check gives a reason', () => {
    expect(failedOnlyForFunding(result('claude-agent-sdk', [['emits_usage_with_tokens', undefined]]))).toBe(false);
  });

  it('is false for a run that passed', () => {
    expect(failedOnlyForFunding(passed)).toBe(false);
  });
});

describe('certificationVerdict', () => {
  it('passes when every engine passed', () => {
    expect(certificationVerdict([passed])).toBe('passed');
  });

  it('is inconclusive when the only failures are unfunded accounts', () => {
    expect(certificationVerdict([passed, unfundedAnthropic])).toBe('inconclusive');
  });

  it('fails when any failure is something else, whatever sits beside it', () => {
    expect(certificationVerdict([passed, unfundedAnthropic, brokenOpenRouter])).toBe('failed');
  });

  it('fails an empty run, which certified nothing', () => {
    expect(certificationVerdict([])).toBe('failed');
  });
});
