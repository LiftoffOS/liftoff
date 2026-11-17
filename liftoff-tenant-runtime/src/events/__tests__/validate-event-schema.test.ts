/**
 * validateEventSchema unit tests, focused on the tenant.feature_flag.*
 * exception added so global flag events (which carry no tenant_id) reach
 * the dispatch switch instead of being DLQ'd.
 */

import { validateEventSchema } from '../subscriber';

function base() {
  return {
    event_id: 'evt-1',
    entity_type: 'feature_flag',
    entity_id: 'flag-1',
    event_version: 1,
    entity_version: 1,
    occurred_at: '2026-06-01T04:13:21.899Z',
  } as Record<string, unknown>;
}

describe('validateEventSchema — tenant_id requirement', () => {
  it('rejects tenant.suspended without tenant_id (tenant-scoped event)', () => {
    expect(() =>
      validateEventSchema({ ...base(), event_type: 'tenant.suspended' }),
    ).toThrow(/Missing tenant_id/);
  });

  it('rejects connector.credentials_stored without tenant_id', () => {
    expect(() =>
      validateEventSchema({ ...base(), event_type: 'connector.credentials_stored' }),
    ).toThrow(/Missing tenant_id/);
  });

  it('accepts tenant.feature_flag.created without tenant_id (global flag exception)', () => {
    const ok = validateEventSchema({
      ...base(),
      event_type: 'tenant.feature_flag.created',
      payload: { key: 'web_fetch_vendor_webclaw', enabled: false },
    });
    expect(ok.event_type).toBe('tenant.feature_flag.created');
    expect(ok.tenant_id).toBeUndefined();
  });

  it('accepts tenant.feature_flag.updated without tenant_id', () => {
    expect(() =>
      validateEventSchema({
        ...base(),
        event_type: 'tenant.feature_flag.updated',
        payload: { key: 'web_fetch_vendor_webclaw', enabled: true },
      }),
    ).not.toThrow();
  });

  it('accepts tenant.feature_flag.deleted without tenant_id', () => {
    expect(() =>
      validateEventSchema({
        ...base(),
        event_type: 'tenant.feature_flag.deleted',
        payload: { key: 'web_fetch_vendor_webclaw' },
      }),
    ).not.toThrow();
  });

  it('still accepts tenant.feature_flag.updated with tenant_id (tenant override path)', () => {
    const ok = validateEventSchema({
      ...base(),
      event_type: 'tenant.feature_flag.updated',
      tenant_id: '11111111-1111-1111-1111-111111111111',
      payload: { key: 'some_flag', enabled: false },
    });
    expect(ok.tenant_id).toBe('11111111-1111-1111-1111-111111111111');
  });
});
