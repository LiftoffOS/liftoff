// What the observed-shape store is FOR.
//
// The store learns response shapes from traffic because `returnsIds` cannot be
// generated from an input schema. Learning it and keeping it in a process
// nobody asks is the same as not learning it, so this is the consumer: observed
// paths minus the ones the catalog already declares, which is the set somebody
// can act on.
//
// The join is what is asserted here rather than the log line. A report tested
// only through its output is a report whose logic is untested, and the logic —
// which paths are missing, and whether there is a row to put them on — is the
// whole content.

jest.mock('../../connectors/tool-schema-cache', () => ({
  getToolSchema: jest.fn(),
}));

jest.mock('../../observability/scrub-logger', () => ({
  scrubLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { shapeProposals } from '../shape-proposals';
import { observeReadShape, _resetObservedShapesForTesting } from '../observed-shapes';
import { getToolSchema } from '../../connectors/tool-schema-cache';

const getToolSchemaMock = getToolSchema as jest.Mock;

beforeEach(() => {
  _resetObservedShapesForTesting();
  getToolSchemaMock.mockReset();
  getToolSchemaMock.mockReturnValue(null);
});

describe('shapeProposals', () => {
  it('proposes the paths a declaration does not already name', () => {
    getToolSchemaMock.mockReturnValue({ returnsIds: [{ entityType: 'message', path: 'messages[].id' }] });
    observeReadShape('google_mail.list_messages', {
      messages: [{ id: 'm1', threadId: 't1' }],
    });

    expect(shapeProposals()).toEqual([{
      tool: 'google_mail.list_messages',
      connectorType: 'google_mail',
      actionType: 'list_messages',
      undeclaredPaths: ['messages[].threadId'],
      undeclaredCount: 1,
      declarable: true,
    }]);
  });

  it('says nothing about a tool whose declaration already covers its traffic', () => {
    // Silence is the useful signal. A report that lists the covered tools
    // beside the uncovered ones teaches the reader to skim past both.
    getToolSchemaMock.mockReturnValue({
      returnsIds: [
        { entityType: 'message', path: 'messages[].id' },
        { entityType: 'thread', path: 'messages[].threadId' },
      ],
    });
    observeReadShape('google_mail.list_messages', { messages: [{ id: 'm1', threadId: 't1' }] });

    expect(shapeProposals()).toEqual([]);
  });

  it('marks a tool with no catalog row as undeclarable rather than as a missing declaration', () => {
    // A vendor-hosted MCP tool is enumerated at runtime and has no registry row
    // to hang `returnsIds` on. Asking for a declaration there is asking for
    // something nobody can write; the heuristic floor is that tool's coverage.
    getToolSchemaMock.mockReturnValue(null);
    observeReadShape('github.pull_request_read', { pull_request: { id: 7, head_sha: 'abc' } });

    const [proposal] = shapeProposals();
    expect(proposal.tool).toBe('github.pull_request_read');
    expect(proposal.declarable).toBe(false);
    expect(proposal.undeclaredPaths.length).toBeGreaterThan(0);
  });

  it('splits the store key on the FIRST separator, so a dotted action survives', () => {
    getToolSchemaMock.mockReturnValue(null);
    observeReadShape('custom_mcp.repo.get_file', { file: { sha: 'deadbeef' } });

    const [proposal] = shapeProposals();
    expect(proposal.connectorType).toBe('custom_mcp');
    expect(proposal.actionType).toBe('repo.get_file');
  });

  it('puts the largest gap first', () => {
    getToolSchemaMock.mockReturnValue(null);
    observeReadShape('a.one', { id: 'x' });
    observeReadShape('b.many', { id: 'x', threadId: 't', messageId: 'm', fileId: 'f' });

    expect(shapeProposals().map((p) => p.tool)).toEqual(['b.many', 'a.one']);
  });

  it('reports a count that survives the per-line cap', () => {
    getToolSchemaMock.mockReturnValue(null);
    const wide: Record<string, string> = {};
    for (let i = 0; i < 30; i++) wide[`field${i}_id`] = `v${i}`;
    observeReadShape('vendor.wide_read', wide);

    const [proposal] = shapeProposals();
    expect(proposal.undeclaredPaths).toHaveLength(20);
    expect(proposal.undeclaredCount).toBe(30);
  });
});
