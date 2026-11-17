// An announcement must be conditional on the work having happened.
//
// Without that, a reviewer agent can post many "Review ready" messages about
// one pull request while producing only one actual review. Take this graph:
//
//   s8  llm_reason  outputField: inlineResult   -> s9
//   s9  llm_reason  outputField: summaryPosted  -> s10
//   s10 tool_call   slack send                  (no condition)
//
// s9 ALREADY declared `summaryPosted`. Nothing read it.
//
// The part that makes this a distiller rule rather than one bad graph: s8 and
// s9 are llm_reason steps, so they succeed when the MODEL finishes reasoning,
// not when their tool calls land. The GitHub write failed inside them (an
// out-of-diff line position), the step still succeeded, and s10 announced work
// that had not happened. "Gate s10 on s8/s9 succeeding" would have changed
// nothing — they did succeed.
import { findUngatedAnnouncements, isAnnounceTool } from '../announce-gating';
import type { WorkflowStep } from '../types';

const step = (s: Partial<WorkflowStep> & { stepId: string }) => s as WorkflowStep;

describe('isAnnounceTool', () => {
  it('recognises the platform Slack senders', () => {
    expect(isAnnounceTool('slack_send_message')).toBe(true);
    expect(isAnnounceTool('slack_reply_in_thread')).toBe(true);
    expect(isAnnounceTool('notifications_send')).toBe(true);
  });

  it('recognises connector-aliased senders', () => {
    expect(isAnnounceTool('slack-d77db9a0__send_message')).toBe(true);
    expect(isAnnounceTool('gmail-abc12345__send_email')).toBe(true);
  });

  it('is not tripped by reads or unrelated tools', () => {
    expect(isAnnounceTool('slack_list_channels')).toBe(false);
    expect(isAnnounceTool('git_clone')).toBe(false);
    expect(isAnnounceTool(undefined)).toBe(false);
  });
});

describe('findUngatedAnnouncements', () => {
  it('catches a post step fed by an ungated summary', () => {
    const problems = findUngatedAnnouncements([
      step({ stepId: 's9', type: 'llm_reason', outputField: 'summaryPosted', onSuccess: 's10' }),
      step({ stepId: 's10', type: 'tool_call', toolName: 'slack_send_message', onSuccess: 's11' }),
      step({ stepId: 's11', type: 'llm_reason' }),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0].stepId).toBe('s10');
    expect(problems[0].actingStepId).toBe('s9');
    expect(problems[0].outputField).toBe('summaryPosted');
  });

  it('explains WHY a succeeding llm_reason step is not proof the work landed', () => {
    // The feedback has to say this, or the model "fixes" it by gating on step
    // success — which is exactly what already passed.
    const [p] = findUngatedAnnouncements([
      step({ stepId: 's9', type: 'llm_reason', outputField: 'summaryPosted', onSuccess: 's10' }),
      step({ stepId: 's10', type: 'tool_call', toolName: 'slack_send_message' }),
    ]);
    expect(p.message).toContain('SUCCEEDS when the model finishes reasoning');
    expect(p.message).toContain('$.steps.s9.summaryPosted');
  });

  it('accepts an announcement that carries its own condition', () => {
    expect(findUngatedAnnouncements([
      step({ stepId: 's9', type: 'llm_reason', outputField: 'summaryPosted', onSuccess: 's10' }),
      step({
        stepId: 's10', type: 'tool_call', toolName: 'slack_send_message',
        condition: '$.steps.s9.summaryPosted == true',
      }),
    ])).toHaveLength(0);
  });

  it('accepts a separate gate step that reads the field', () => {
    // The shape the same agent already uses at s3 for PR selection.
    expect(findUngatedAnnouncements([
      step({ stepId: 's9', type: 'llm_reason', outputField: 'summaryPosted', onSuccess: 's10' }),
      step({ stepId: 's10', type: 'tool_call', toolName: 'slack_send_message' }),
      step({ stepId: 'sGate', type: 'llm_reason', condition: '$.steps.s9.summaryPosted == true' }),
    ])).toHaveLength(0);
  });

  it('stays silent when the acting step records nothing to gate on', () => {
    // No outputField means no fact to test. Demanding a condition the author
    // cannot write would be noise, and a step that records nothing is a
    // different defect — not smuggled in here.
    expect(findUngatedAnnouncements([
      step({ stepId: 's9', type: 'llm_reason', onSuccess: 's10' }),
      step({ stepId: 's10', type: 'tool_call', toolName: 'slack_send_message' }),
    ])).toHaveLength(0);
  });

  it('does not fire on a non-announcing tool step', () => {
    expect(findUngatedAnnouncements([
      step({ stepId: 's3', type: 'llm_reason', outputField: 'selected', onSuccess: 's4' }),
      step({ stepId: 's4', type: 'tool_call', toolName: 'git_clone' }),
    ])).toHaveLength(0);
  });

  it('reports each ungated announcement once', () => {
    const problems = findUngatedAnnouncements([
      step({ stepId: 'a1', type: 'llm_reason', outputField: 'posted', onSuccess: 'a2' }),
      step({ stepId: 'a2', type: 'tool_call', toolName: 'slack_send_message', onSuccess: 'b1' }),
      step({ stepId: 'b1', type: 'llm_reason', outputField: 'emailed', onSuccess: 'b2' }),
      step({ stepId: 'b2', type: 'tool_call', toolName: 'notifications_send' }),
    ]);
    expect(problems.map((p) => p.stepId).sort()).toEqual(['a2', 'b2']);
  });
});
