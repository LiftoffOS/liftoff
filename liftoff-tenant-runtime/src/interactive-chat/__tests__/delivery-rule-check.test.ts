// The delivery rules the chat prompt states, measured.

import { deliveryRuleViolations } from '../delivery-rule-check';

const WORKSPACE = '/tmp/chat-threads/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222';

describe('deliveryRuleViolations', () => {
  it('flags a file: URL, which resolves against the READER machine', () => {
    expect(deliveryRuleViolations('Here it is: file:///tmp/report.pptx', WORKSPACE))
      .toEqual(['file_url']);
  });

  it('flags the run’s own container path', () => {
    expect(deliveryRuleViolations(`I saved it to ${WORKSPACE}/report.pptx`, WORKSPACE))
      .toEqual(['workspace_path']);
  });

  it('flags both when both appear', () => {
    expect(deliveryRuleViolations(`file://${WORKSPACE}/report.pptx`, WORKSPACE))
      .toEqual(['file_url', 'workspace_path']);
  });

  it('does not flag the workspace ROOT alone, which names no tenant or thread', () => {
    expect(deliveryRuleViolations('Files live under /tmp/chat-threads on the runner.', WORKSPACE))
      .toEqual([]);
  });

  it('does not flag an ordinary reply', () => {
    expect(deliveryRuleViolations('The deck is attached above.', WORKSPACE)).toEqual([]);
  });

  it('handles a missing workspace path and empty output', () => {
    expect(deliveryRuleViolations('file://x', undefined)).toEqual(['file_url']);
    expect(deliveryRuleViolations('', WORKSPACE)).toEqual([]);
    expect(deliveryRuleViolations(null, WORKSPACE)).toEqual([]);
    expect(deliveryRuleViolations(undefined, WORKSPACE)).toEqual([]);
  });
});
