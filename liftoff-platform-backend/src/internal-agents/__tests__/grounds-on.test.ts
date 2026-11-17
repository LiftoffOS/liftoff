// C7 — grounding rules DERIVED from what is bound, never asked of the model.
//
// Asking a model to nominate its own grounding tool invites exactly the error
// the feature removes: it names a tool that reads well and answers the wrong
// question, and nothing downstream can tell. Deriving them means the rule is
// only ever as wrong as the catalog, which the connector-service boot validator
// already checks.

import { deriveGroundsOn } from '../grounds-on';
import type { ToolCatalog } from '../distill-service';

const catalog = (entries: Array<[string, Record<string, unknown>]>): ToolCatalog =>
  new Map(entries.map(([n, v]) => [n, { name: n, description: '', ...v }])) as unknown as ToolCatalog;

describe('deriveGroundsOn', () => {
  it('derives nothing when nothing suitable is bound', () => {
    // The common case, and correct: a rule naming a tool the agent does not
    // have costs a matcher pass per turn to produce nothing.
    expect(deriveGroundsOn(catalog([['slack__send_message', { categories: ['write'] }]]))).toEqual([]);
  });

  it('prefers the platform corpus for the policy shape', () => {
    // corpus_search is the one read whose corpus the workspace curates, so it
    // answers about THIS business rather than about a vendor's documentation.
    const rules = deriveGroundsOn(catalog([
      ['corpus_search', { categories: ['read'] }],
      ['zendesk__search_articles', { categories: ['read'] }],
    ]));
    expect(rules).toHaveLength(1);
    expect(rules[0].toolName).toBe('corpus_search');
  });

  it('falls back to a bound help-centre read', () => {
    const rules = deriveGroundsOn(catalog([['zendesk__search_articles', { categories: ['read'] }]]));
    expect(rules.map((r) => r.toolName)).toEqual(['zendesk__search_articles']);
  });

  it('derives the record-status shape from the work-inbox declaration', () => {
    // The same `workRole: 'inbox'` the W1 boot validator checks, so this cannot
    // drift from what the runtime treats as an inbox.
    const rules = deriveGroundsOn(catalog([
      ['gmail__list_messages', { categories: ['read'], workRole: 'inbox' }],
    ]));
    expect(rules.map((r) => r.label)).toEqual(['the work queue']);
  });

  it('derives both shapes when both are bound', () => {
    const rules = deriveGroundsOn(catalog([
      ['corpus_search', { categories: ['read'] }],
      ['gmail__list_messages', { categories: ['read'], workRole: 'inbox' }],
    ]));
    expect(rules).toHaveLength(2);
  });

  it('gives every rule both halves of a key and an enabled flag', () => {
    // Terms without cues fire on statements; cues without terms fire on every
    // question. `enabled` is first-class so a rule can be turned off without
    // being deleted, which would otherwise take a redistill.
    for (const r of deriveGroundsOn(catalog([['corpus_search', { categories: ['read'] }]]))) {
      expect(r.terms.length).toBeGreaterThan(0);
      expect(r.cues.length).toBeGreaterThan(0);
      expect(r.enabled).toBe(true);
      expect(r.label).toBeTruthy();
    }
  });

  it('never names a write tool', () => {
    // Grounding is a READ. A rule that prefetched a write would perform the
    // agent's action before it decided to.
    const rules = deriveGroundsOn(catalog([
      ['zendesk__search_articles', { categories: ['write'] }],
    ]));
    expect(rules).toEqual([]);
  });
});
