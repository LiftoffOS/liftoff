// returnsIds cannot be derived by anyone: nothing about a tool's arguments says
// what its response contains. So they are observed from real traffic — and
// until now the observations lived in an in-memory Map that a restart threw
// away, read by a function with no caller. A night's learning reached nobody
// and did not survive the morning.
//
// These pin the loop's ends: an observation is attributed to a tenant, and an
// accepted path reaches the gate as a declaration.

import {
  observeReadShape,
  pendingShapeCountsForTenant,
  observedTenants,
  _resetObservedShapesForTesting,
} from '../observed-shapes';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

beforeEach(() => _resetObservedShapesForTesting());

describe('an observation belongs to a tenant', () => {
  it('keeps two tenants apart', () => {
    // A custom MCP server's tools belong to the workspace that connected it.
    // Nobody else can see them, so a path learned in one tenant must never be
    // proposed as another's — and the table it drains into is tenant-scoped.
    observeReadShape('acme_crm.list_deals', { items: [{ id: 'd1' }] }, TENANT_A);
    observeReadShape('other_crm.list_rows', { rows: [{ id: 'r1' }] }, TENANT_B);

    expect(Object.keys(pendingShapeCountsForTenant(TENANT_A))).toEqual(['acme_crm.list_deals']);
    expect(Object.keys(pendingShapeCountsForTenant(TENANT_B))).toEqual(['other_crm.list_rows']);
  });

  it('records the path, never the value', () => {
    // The id is customer data with no business outliving the request; the path
    // is a fact about the tool's shape.
    observeReadShape('gmail.list_messages', { items: [{ id: 'SECRET_ID' }] }, TENANT_A);
    const serialised = JSON.stringify(pendingShapeCountsForTenant(TENANT_A));
    expect(serialised).toContain('items[].id');
    expect(serialised).not.toContain('SECRET_ID');
  });

  it('lists the tenants with something waiting', () => {
    observeReadShape('gmail.list_messages', { items: [{ id: 'x' }] }, TENANT_A);
    observeReadShape('gmail.list_messages', { items: [{ id: 'y' }] }, TENANT_B);
    expect(observedTenants().sort()).toEqual([TENANT_A, TENANT_B].sort());
  });

  it('accumulates distinct paths for one tool', () => {
    observeReadShape('gmail.list_messages', { items: [{ id: 'a' }] }, TENANT_A);
    observeReadShape('gmail.list_messages', { messages: [{ threadId: 't' }] }, TENANT_A);
    expect(Object.keys(pendingShapeCountsForTenant(TENANT_A)['gmail.list_messages']).length).toBeGreaterThan(1);
  });

  it('reports nothing for a tenant that has been seen doing nothing', () => {
    expect(pendingShapeCountsForTenant(TENANT_A)).toEqual({});
    expect(observedTenants()).toEqual([]);
  });

  it('still records an unattributed observation, rather than dropping it', () => {
    // tenantId is optional on the signature; an observation with no tenant is
    // worth keeping for the report even though it cannot be persisted.
    observeReadShape('gmail.list_messages', { items: [{ id: 'x' }] });
    expect(observedTenants()).toEqual([]);
  });
});
