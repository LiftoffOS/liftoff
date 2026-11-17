// §7.4: when the recovery LLM fires for a classified connector failure, the
// prompt must start from the taxonomy — the error class + the suggested
// recovery — instead of re-deriving it from prose.

import { buildRecoveryPrompt } from '../engine/recovery-prompts';
import type { AnomalyContext, WorkflowStep } from '../types';

const step: WorkflowStep = {
  stepId: 's1',
  description: 'Send the summary email',
  toolName: 'gmail__send',
  type: 'tool_call',
};
const anomaly: AnomalyContext = { kind: 'tool_error', step, error: 'auth_expired: reconnect' };

describe('buildRecoveryPrompt — tool-error contract injection', () => {
  it('injects the classified cause + recommended recovery when a contract is provided', () => {
    const prompt = buildRecoveryPrompt(anomaly, [step], {}, 's1', [], 0, 0, {
      code: 'auth_expired',
      recovery: 'Reconnect the connector on the Connections page, then retry.',
    });
    expect(prompt).toContain('Classified cause');
    expect(prompt).toContain('auth_expired');
    expect(prompt).toContain('Reconnect the connector');
  });

  it('omits the classified-cause block when no contract is provided (back-compat)', () => {
    const prompt = buildRecoveryPrompt(anomaly, [step], {}, 's1', [], 0, 0);
    expect(prompt).not.toContain('Classified cause');
  });
});
