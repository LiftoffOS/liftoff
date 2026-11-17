import {
  buildAgentPickerCard,
  buildAgentMessageCard,
  buildReviewCard,
  buildSearchResponse,
} from '../cards';

interface AdaptiveContent {
  type: string;
  body: Array<Record<string, unknown>>;
  actions?: Array<Record<string, unknown>>;
}

function content(att: { content: unknown }): AdaptiveContent {
  return att.content as AdaptiveContent;
}

describe('teams cards', () => {
  it('agent picker has a filtered static ChoiceSet + pick_agent submit', () => {
    const att = buildAgentPickerCard([{ agentId: 'a1', label: 'Aria' }]);
    const card = content(att);
    const choiceSet = card.body.find((b) => b.type === 'Input.ChoiceSet') as Record<string, unknown>;
    expect(choiceSet).toBeDefined();
    expect(choiceSet.style).toBe('compact');
    expect(choiceSet['choices.data']).toBeUndefined();
    expect((choiceSet.choices as Array<{ value: string }>)[0].value).toBe('a1');
    const submit = card.actions?.[0] as Record<string, unknown>;
    expect((submit.data as Record<string, unknown>).action).toBe('pick_agent');
  });

  it('agent message card renders name + markdown, no avatar', () => {
    const card = content(buildAgentMessageCard({ agentName: 'Aria', markdown: 'hello' }));
    const texts = card.body.map((b) => b.text);
    expect(texts).toContain('Aria');
    expect(texts).toContain('hello');
    expect(JSON.stringify(card)).not.toContain('Image');
  });

  it('review card carries reviewId on approve + reject submits', () => {
    const card = content(buildReviewCard({ agentName: 'Aria', reviewId: 'r1', draftText: 'draft' }));
    const actions = (card.actions ?? []).map((a) => a.data as Record<string, unknown>);
    expect(actions).toEqual([
      { action: 'review_approve', reviewId: 'r1' },
      { action: 'review_reject', reviewId: 'r1' },
    ]);
  });

  it('review card renders the generic Action / Why / Details (no draftText) with approve/reject submits', () => {
    const card = content(buildReviewCard({
      agentName: 'Aria', reviewId: 'r2',
      action: 'Merge pull request #7 in acme/site',
      why: 'Both reviews approved',
      detail: 'github · merge_pull_request',
    }));
    const texts = card.body.map((b) => b.text);
    expect(texts).toContain('Approval needed');
    expect(texts).toContain('Agent: Aria');
    expect(texts).toContain('Action: Merge pull request #7 in acme/site');
    expect(texts).toContain('Why: Both reviews approved');
    expect(texts).toContain('github · merge_pull_request');
    const actions = (card.actions ?? []).map((a) => a.data as Record<string, unknown>);
    expect(actions).toEqual([
      { action: 'review_approve', reviewId: 'r2' },
      { action: 'review_reject', reviewId: 'r2' },
    ]);
  });

  it('review card omits the Why line when absent', () => {
    const card = content(buildReviewCard({ agentName: 'Aria', reviewId: 'r3', action: 'Delete a record' }));
    const texts = card.body.map((b) => b.text);
    expect(texts).toContain('Action: Delete a record');
    expect(texts.some((t) => typeof t === 'string' && t.startsWith('Why:'))).toBe(false);
  });

  it('search response uses the Teams searchResponse envelope', () => {
    const r = buildSearchResponse([{ agentId: 'a1', label: 'Aria' }]);
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('application/vnd.microsoft.search.searchResponse');
    expect(r.body.value.results).toEqual([{ title: 'Aria', value: 'a1' }]);
  });
});

