// "Acted" is a claim about DISPATCH. On almost every connector it is the only
// claim this ledger can make, and it reads like a claim about the world.
//
// `acted_at_other_version` — "you did this and the thing has changed since, so
// do it again" — is the verdict a caller needs before deciding to skip work.
// Reaching it requires a recorded revision, and `deriveTarget` records one for
// GitHub and for nothing else: a Docs `update_document_markdown` payload
// carries a document id and markdown, a Slack post carries a channel, a Gmail
// send carries a thread. None carries an etag or a revision id.
//
// So on the other sixteen the guard answers `acted` or `acted_version_unknown`,
// both of which read as "you already did this". A competitive-intelligence
// digest whose deliverable has been emptied is refused on exactly that: the
// ledger still holds the write, so the sweep is skipped, even while a person
// says the document is blank. Reading the document would have settled
// it in one call — which is what the caveat now tells the caller to do.

const mockFind = jest.fn();

jest.mock('../repository', () => ({
  ActionRepository: jest.fn().mockImplementation(() => ({
    findPriorActionsOnTarget: (...a: unknown[]) => mockFind(...a),
  })),
  CompensationRepository: jest.fn(),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { ActionLedgerService } from '../service';
import { CONNECTOR_TYPES_DERIVING_VERSION, connectorRuleDerivesVersion } from '../target-ref';

const row = (targetVersion: string | null = null) => ({
  actionType: 'update_document_markdown',
  connector: 'google-docs-8fd9fc68',
  targetVersion,
  agentId: 'agent-1',
  createdAt: new Date('2026-09-08T04:42:00Z'),
});

const ask = (targetRef: string, over: Record<string, unknown> = {}) =>
  new ActionLedgerService().hasActedOn({
    tenantId: 'tenant-1', agentId: 'agent-1', targetRef, ...over,
  });

// The list is hand-maintained because a rule is a function and what it returns
// cannot be read off it statically. This is what keeps it honest.
describe('the declared list matches the rules themselves', () => {
  const SRC = readFileSync(join(__dirname, '..', 'target-ref.ts'), 'utf8');
  const rulesBlock = SRC.slice(SRC.indexOf('const RULES'), SRC.indexOf('\n};', SRC.indexOf('const RULES')));

  const derivingInSource = (): string[] => {
    const names: string[] = [];
    const entry = /^\s+'?([a-z0-9-]+)'?: \(/gm;
    const starts: Array<{ name: string; at: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = entry.exec(rulesBlock)) !== null) starts.push({ name: m[1], at: m.index + m[0].length });
    starts.forEach((s, i) => {
      const body = rulesBlock.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : rulesBlock.length);
      // A rule that never mentions `version:` cannot return one.
      if (/version:\s*[^,\n}]+/.test(body)) names.push(s.name);
    });
    return names.sort();
  };

  it('every rule that derives a version is declared, and no other', () => {
    expect(derivingInSource()).toEqual([...CONNECTOR_TYPES_DERIVING_VERSION].sort());
  });

  it('is one rule out of nineteen, which is the fact the caveat exists for', () => {
    // A rule is keyed by a literal name or, for the ledger-only capability
    // namespace, by a constant; both count.
    const ruleCount = (rulesBlock.match(/^\s+(?:'?[a-z0-9-]+'?|\[[A-Z_]+\]): \(/gm) ?? []).length;
    expect(ruleCount).toBe(19);
    expect(CONNECTOR_TYPES_DERIVING_VERSION.size).toBe(1);
  });
});

describe('connectorRuleDerivesVersion', () => {
  it.each(['github', 'github-7d07a896'])('is true for %s', (c) => {
    expect(connectorRuleDerivesVersion(c)).toBe(true);
  });

  it.each([
    'google-docs', 'google-docs-8fd9fc68', 'googledocs',
    'slack', 'google-mail', 'gmail', 'google-sheets', 'notion', 'microsoft-outlook-mail',
  ])('is false for %s', (c) => {
    expect(connectorRuleDerivesVersion(c)).toBe(false);
  });
});

describe('versionBasis says whether a revision comparison was possible', () => {
  beforeEach(() => jest.clearAllMocks());

  it('no_rows when the ledger holds nothing', async () => {
    mockFind.mockResolvedValueOnce([]);
    expect((await ask('google-docs:doc-1')).versionBasis).toBe('no_rows');
  });

  it('recorded when some prior action names a revision', async () => {
    mockFind.mockResolvedValueOnce([row('a450b99')]);
    expect((await ask('github:acme/x#1', { targetVersion: 'b0' })).versionBasis).toBe('recorded');
  });

  it('absent_on_these_rows when the connector CAN record one and did not', async () => {
    mockFind.mockResolvedValueOnce([row(null)]);
    expect((await ask('github:acme/x#1', { targetVersion: 'b0' })).versionBasis)
      .toBe('absent_on_these_rows');
  });

  it('unavailable_for_connector when no row here ever will carry one', async () => {
    mockFind.mockResolvedValueOnce([row(null)]);
    expect((await ask('google-docs:1ISydz', { targetVersion: 'r99' })).versionBasis)
      .toBe('unavailable_for_connector');
  });

  // The shape the sweep actually hit: no version passed, so the verdict is a
  // flat `acted`, and only the basis says the ledger cannot speak to whether
  // the document is still there.
  it('flags it even when the verdict is a confident "acted"', async () => {
    mockFind.mockResolvedValueOnce([row(null)]);
    const answer = await ask('google-docs:1ISydz');
    expect(answer.verdict).toBe('acted');
    expect(answer.versionBasis).toBe('unavailable_for_connector');
  });
});

describe('the caveat reaches the model, not just the type', () => {
  const HANDLER = readFileSync(join(__dirname, '..', '..', 'tools', 'standard-tool-handler.ts'), 'utf8');
  const TOOLS = readFileSync(join(__dirname, '..', '..', 'tools', 'standard-tools.ts'), 'utf8');

  it('the tool response tells the caller to read the artifact', () => {
    const block = HANDLER.slice(HANDLER.indexOf("answer.versionBasis === 'unavailable_for_connector'"));
    expect(block.slice(0, 700)).toContain('READ IT');
  });

  it('and only on the connectors where it applies', () => {
    expect(HANDLER).toContain("answer.versionBasis === 'unavailable_for_connector'");
  });

  it('the tool description explains the field before the call is made', () => {
    expect(TOOLS).toContain('unavailable_for_connector');
  });
});
