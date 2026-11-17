// The rubric judge: one narrow question, the answer constrained by the parse.
//
// The judge is the one check in the harness that costs a model call, and it
// fails closed — a reply that is not PASS or FAIL is a failed case, because a
// judge that cannot be parsed knows nothing. That makes the request shape
// load-bearing: the medium tier thinks before it answers when it decides to,
// and thinking spends the token budget before the first word of text. A
// budget sized to the word alone starves the answer and every rubric the model
// pauses over reads as a failure.

const mockComplete = jest.fn();
jest.mock('../../llm', () => ({ llmClient: { complete: (...a: unknown[]) => mockComplete(...a) } }));

import { LLMRefusalError } from '../../llm/types';
import { gradeRubric, type CaseRecording } from '../template-eval-harness';

const rec: CaseRecording = {
  caseId: 'c', templateId: 't', recordedAt: '', skillLoads: [], outcome: 'success', toolNames: [],
  finalText: 'The document is a purchase order, not a non-disclosure agreement.',
};

beforeEach(() => jest.clearAllMocks());

describe('gradeRubric', () => {
  it('reads PASS and FAIL off the first word, case-insensitively', async () => {
    mockComplete.mockResolvedValueOnce({ content: ' pass\n' });
    expect(await gradeRubric('says it is not an NDA', rec, 't1')).toEqual([]);
    mockComplete.mockResolvedValueOnce({ content: 'FAIL — the grid is missing' });
    expect(await gradeRubric('fills the grid', rec, 't1')).toEqual(['rubric not met: fills the grid']);
  });

  it('fails closed on an answer it cannot parse, naming why the reply ended', async () => {
    mockComplete.mockResolvedValueOnce({ content: '', stopReason: 'max_tokens' });
    const failures = await gradeRubric('fills the grid', rec, 't1');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/neither PASS nor FAIL/);
    expect(failures[0]).toContain('stop: max_tokens');
  });

  // The judge declining one reply is that case failing, not the suite
  // breaking: the cases after it are still graded.
  it('fails the case on a refusal and lets the suite continue', async () => {
    mockComplete.mockRejectedValueOnce(new LLMRefusalError({ provider: 'anthropic', model: 'claude-sonnet-5', category: 'refusal' }));
    const failures = await gradeRubric('fills the grid', rec, 't1');
    expect(failures).toEqual([expect.stringMatching(/refused to grade this reply \(refusal\)/)]);
  });

  it('lets any other judge failure propagate — a suite with no judge is broken, not failing', async () => {
    mockComplete.mockRejectedValueOnce(new Error('No LLM providers available'));
    await expect(gradeRubric('fills the grid', rec, 't1')).rejects.toThrow('No LLM providers available');
  });

  it('gives the model room to think before the one word it is asked for', async () => {
    mockComplete.mockResolvedValueOnce({ content: 'PASS' });
    await gradeRubric('says it is not an NDA', rec, 't1');
    const [request, , meta] = mockComplete.mock.calls[0];
    expect(request.maxTokens).toBeGreaterThanOrEqual(4096);
    expect(request.messages[1].content).toContain(rec.finalText);
    expect(meta).toEqual({ tenantId: 't1', purpose: 'template_eval_rubric' });
  });
});
