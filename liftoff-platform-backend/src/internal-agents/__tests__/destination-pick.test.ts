// One question about where a team's work goes, answerable with a folder or a
// file, and prose that reads correctly either way.
//
// It used to be two questions on one tree — a folder pick ("where this team
// saves its work") and a file pick ("your positioning document") — and the tree
// routed a row by what it WAS. So the answer chose the question: someone naming
// a document as their save location was recorded against the read pick, hired a
// team with nowhere to work (both picks optional), and its next run wrote nine
// documents loose in their Drive while the document they HAD named stayed empty.

import { applyTemplatePicks } from '../distill-service';
import { resolveTemplatePlaceholders } from '../template-placeholders';

describe('what a destination renders inside an authored sentence', () => {
  // Every documents template says "in {{pick:...}}", authored when the only
  // possible answer was a folder.
  const sentence = 'Write the digest in {{pick:destination}}, creating it on the first run.';

  it('reads correctly when a folder was chosen', () => {
    const out = applyTemplatePicks(
      sentence,
      { destination: { id: 'fold-1', title: 'Competitive Intel', kind: 'folder' } },
      {},
    );
    expect(out).toBe('Write the digest in "Competitive Intel" (id fold-1), creating it on the first run.');
  });

  it('reads correctly when a FILE was chosen', () => {
    // "in "Weekly Digest"" is not a place. The file names the deliverable, so
    // the place it implies is a folder beside it.
    const out = applyTemplatePicks(
      sentence,
      { destination: { id: 'doc-9', title: 'Weekly Digest', kind: 'file' } },
      {},
    );
    // Not "a working folder beside": that read correctly and could not be done.
    // A documents connector cannot create a folder, and create_document_markdown
    // cannot choose a parent, so the only containment that survives contact is
    // the workspace itself. The sentence must also still read after "in".
    expect(out).toContain('in the same workspace as "Weekly Digest" (id doc-9)');
    expect(out).not.toMatch(/folder/i);
  });

  it('is unchanged for every pick that is not a destination', () => {
    // A channel, a table, a read-only file: the question already fixes what the
    // answer is, so nothing sends a kind and nothing re-phrases.
    const out = applyTemplatePicks(
      'Post to {{pick:alerts}}.',
      { alerts: { id: 'C01', title: '#eng-alerts' } },
      {},
    );
    expect(out).toBe('Post to "#eng-alerts" (id C01).');
  });

  it('still falls back to the authored phrase when nobody answered', () => {
    expect(applyTemplatePicks(sentence, {}, { destination: 'your working folder' }))
      .toContain('in your working folder');
  });
});

describe('what the team is told the named document is FOR', () => {
  const text = { responsibilities: 'Run the sweep.', additionalContext: '## Context\nWeekly.' };

  it('states the deliverable rule when a file was named', () => {
    // No authored sentence can say this: the templates were written when the
    // only answer was a folder.
    const out = resolveTemplatePlaceholders(
      'competitive-intelligence-analyst',
      text,
      { destination: { id: 'doc-9', title: 'Weekly Digest', kind: 'file' } },
    );
    expect(out.additionalContext).toContain('Where your work goes');
    expect(out.additionalContext).toContain('"Weekly Digest"');
    expect(out.additionalContext).toMatch(/UPDATE that document rather than creating a new one/);
    // Everything else is LINKED from the deliverable, not filed beside it.
    // The folder instruction this used to assert was unfollowable: Google Docs
    // exposes nine actions and not one creates a folder or moves a file, and
    // the model worked around it by leaving thirteen documents loose in a
    // customer's Drive.
    expect(out.additionalContext).toMatch(/LINK from that document/);
    expect(out.additionalContext).toMatch(/Do not try to file them into a folder/);
    expect(out.additionalContext).not.toMatch(/folder you create/i);
  });

  it('states the rule for a folder too', () => {
    // Both answers get a rule. The shape is the same either way — one place for
    // the deliverable, a folder for everything else, nothing loose — and saying
    // it only for one answer leaves the other to be inferred from prose that
    // was authored before the question could be answered that way.
    const out = resolveTemplatePlaceholders(
      'competitive-intelligence-analyst',
      text,
      { destination: { id: 'f1', title: 'Competitive Intel', kind: 'folder' } },
    );
    expect(out.additionalContext).toContain('Where your work goes');
    expect(out.additionalContext).toMatch(/Everything you produce goes in "Competitive Intel"/);
  });

  it('says nothing extra when nothing was named', () => {
    const out = resolveTemplatePlaceholders('competitive-intelligence-analyst', text, {});
    expect(out.additionalContext).not.toContain('Where your work goes');
  });

  it('leaves the responsibilities to the template', () => {
    // The rule is a fact about this hire's workspace, not a thing the team does.
    const out = resolveTemplatePlaceholders(
      'competitive-intelligence-analyst',
      text,
      { destination: { id: 'doc-9', title: 'Weekly Digest', kind: 'file' } },
    );
    expect(out.responsibilities).toBe('Run the sweep.');
  });
});

// The copy rules cover TEMPLATES. They do not cover the block this file appends
// to them, and that block reaches every agent hired with a file destination.
//
// Without this test the block could carry em dashes, which the catalog copy
// rule would fail instantly in any template: a check that covers one path and
// not the parallel one.
describe('the generated rule obeys the same copy rules as the prose it joins', () => {
  const rendered = () => {
    const out = resolveTemplatePlaceholders(
      'competitive-intelligence-analyst',
      { responsibilities: 'r', additionalContext: '## Context\nWeekly.' },
      { 'working-folder': { id: 'doc-9', title: 'Weekly Digest', kind: 'file' } },
      new Set(['google_docs']),
    );
    return `${out.responsibilities ?? ''}\n${out.additionalContext ?? ''}`;
  };

  it('uses no em dashes', () => {
    expect(rendered()).not.toContain('—');
  });

  it('never calls an agent an "agent"', () => {
    expect(rendered()).not.toMatch(/\bagents?\b/i);
  });

  it('leaves no placeholder braces in what the team is given', () => {
    expect(rendered()).not.toMatch(/\{\{/);
  });
});
