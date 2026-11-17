// computeTrust math + distinct_approvers + listActionClassesForReason mapping.

jest.mock('../../infrastructure/database', () => {
  const query = jest.fn();
  return {
    withTenantScope: (_t: string, fn: (c: unknown) => unknown) => fn({ query }),
    __query: query,
  };
});

import * as db from '../../infrastructure/database';
import { computeTrust, listActionClassesForReason } from '../repository';

const mockQuery = (db as unknown as { __query: jest.Mock }).__query;

describe('computeTrust', () => {
  beforeEach(() => mockQuery.mockReset());

  it('maps runs / passRate / distinctApprovers', async () => {
    mockQuery.mockResolvedValue({ rows: [{ runs: '10', approved: '8', approvers: '3' }] });
    const r = await computeTrust('t', 'a', 'send_email', 30);
    expect(r).toEqual({ runs: 10, passRate: 0.8, distinctApprovers: 3 });
  });

  it('zero runs → passRate 0 (window edge: no rows in window)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ runs: '0', approved: '0', approvers: '0' }] });
    const r = await computeTrust('t', 'a', 'x', 30);
    expect(r).toEqual({ runs: 0, passRate: 0, distinctApprovers: 0 });
  });
});

describe('listActionClassesForReason', () => {
  beforeEach(() => mockQuery.mockReset());

  it('maps rows to distinct action_class strings', async () => {
    mockQuery.mockResolvedValue({ rows: [{ action_class: 'send_email' }, { action_class: 'delete_file' }] });
    const r = await listActionClassesForReason('t', 'ag', 'sensitive_work', 30);
    expect(r).toEqual(['send_email', 'delete_file']);
  });
});
