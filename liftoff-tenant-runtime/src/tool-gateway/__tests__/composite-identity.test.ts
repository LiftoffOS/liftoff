// A pull request is `owner/repo#number`, and it is judged as one value.
//
// Checked as independent scalars, a read of #123 in one repository grounded a
// write to #123 in another, and the review-write tool carries no sha to check
// instead. So a connector may declare a composite identity, derived by the
// ledger's own `deriveTarget` rule so the read and the write agree on the value
// — the read establishing it from its RESPONSE, never from its arguments, and
// the write from the arguments it sends. The trigger's own event establishes
// it too, for the run woken by the pull request it then acts on.

import {
  checkWriteProvenance,
  recordProvenance,
  seedProvenanceFromEvent,
  _resetProvenanceForTesting,
} from '../record-provenance';
import { vendorDeclarationFor, _declaredVendorOperationsForTesting } from '../../connectors/vendor-declarations';

const T = '11111111-1111-1111-1111-111111111111';
const READ = vendorDeclarationFor('github', 'pull_request_read')!;
const WRITE = vendorDeclarationFor('github', 'pull_request_review_write')!;
const PR_123 = {
  number: 123, title: 'docs', html_url: 'https://github.com/acme/api/pull/123',
  base: { ref: 'main', sha: '71b98d8b', repo: { full_name: 'acme/api' } },
  head: { ref: 'eval-fixture/docs-only', sha: 'ed2f72d4bfd554d985e898ac81acc96cf062a9fa' },
};
const write = (inv: string, args: Record<string, unknown>) =>
  checkWriteProvenance({ tenantId: T, invocationId: inv, declaration: WRITE, actionType: 'pull_request_review_write', payload: args });
const read = (inv: string, result: unknown, args: Record<string, unknown> = { method: 'get', owner: 'acme', repo: 'api', pullNumber: 123 }) =>
  recordProvenance({ tenantId: T, invocationId: inv, declaration: READ, actionType: 'pull_request_read', payload: args, result, isWrite: false });

beforeEach(() => _resetProvenanceForTesting());

describe('the GitHub pilot operations', () => {
  it('are declared, and every declaration carries the identity it needs', () => {
    const ops = _declaredVendorOperationsForTesting();
    expect(ops.length).toBeGreaterThanOrEqual(3);
    for (const [, op, decl] of ops) {
      expect({ op, hasRef: !!decl.canonicalRef }).toEqual({ op, hasRef: true });
      const isWrite = /write|comment|create|update|delete/.test(op);
      if (isWrite) expect({ op, idArgs: decl.idArgs?.length ?? 0 }).not.toEqual({ op, idArgs: 0 });
      else expect({ op, from: decl.canonicalRef?.from }).not.toEqual({ op, from: undefined });
    }
  });
});

describe('a read establishes the pull request it RETURNED', () => {
  it('and a write to that pull request is grounded, judged on the ref', async () => {
    await read('inv-1', PR_123);
    const v = await write('inv-1', { method: 'create', owner: 'acme', repo: 'api', pullNumber: 123, body: 'LGTM' });
    expect(v).toEqual({ provenanced: true, basis: 'canonical_ref', unseen: [] });
  });

  it('a write to another pull request in the same repository is not', async () => {
    await read('inv-2', PR_123);
    const v = await write('inv-2', { method: 'create', owner: 'acme', repo: 'api', pullNumber: 124, body: 'x' });
    expect(v.provenanced).toBe(false);
    expect(v.basis).toBe('canonical_ref');
    expect(v.unseen).toEqual(['github:acme/api#124']);
  });

  it('a write to #123 in ANOTHER repository is not — the number alone grounds nothing', async () => {
    // The case the scalar check got wrong.
    await read('inv-3', PR_123);
    const v = await write('inv-3', { method: 'create', owner: 'acme', repo: 'billing', pullNumber: 123, body: 'x' });
    expect(v.provenanced).toBe(false);
    expect(v.unseen).toEqual(['github:acme/billing#123']);
  });

  it('is established from the response, never from what the read was asked for', async () => {
    // The read ASKED for #123 and got a diff back — no object naming the PR.
    // Nothing is established: a request must not establish identity without
    // the response proving it.
    await read('inv-4', 'diff --git a/README.md b/README.md\n+hello', { method: 'get_diff', owner: 'acme', repo: 'api', pullNumber: 123 });
    const v = await write('inv-4', { method: 'create', owner: 'acme', repo: 'api', pullNumber: 123, body: 'x' });
    expect(v.provenanced).toBe(false);
  });

  it('a write whose arguments yield no ref is not judged', async () => {
    await read('inv-5', PR_123);
    const v = await write('inv-5', { method: 'create', body: 'x' });
    expect(v).toEqual({ provenanced: true, basis: 'no_declaration', unseen: [] });
  });
});

describe('the event that woke the run establishes what it was about', () => {
  it('so a write to that pull request passes without a read first', async () => {
    await seedProvenanceFromEvent({
      tenantId: T, invocationId: 'inv-6',
      inputData: { eventSource: 'github', eventEntityType: 'PullRequest', eventData: { repository: 'acme/api', number: 123, head: 'ed2f72d4' } },
    });
    const v = await write('inv-6', { method: 'create', owner: 'acme', repo: 'api', pullNumber: 123, body: 'x' });
    expect(v).toEqual({ provenanced: true, basis: 'canonical_ref', unseen: [] });
  });

  it('and not to a different one', async () => {
    await seedProvenanceFromEvent({
      tenantId: T, invocationId: 'inv-7',
      inputData: { eventSource: 'github', eventEntityType: 'PullRequest', eventData: { repository: 'acme/api', number: 123 } },
    });
    const v = await write('inv-7', { method: 'create', owner: 'acme', repo: 'api', pullNumber: 125, body: 'x' });
    expect(v.provenanced).toBe(false);
  });
});
