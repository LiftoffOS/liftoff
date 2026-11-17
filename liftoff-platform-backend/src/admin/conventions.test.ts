// Tests for the admin response-envelope helpers.

import {
  adminError,
  wrapAdminResponse,
  type AdminAuditRecord,
} from './conventions';

const audit: AdminAuditRecord = {
  actionId: 'audit_1',
  action: 'tenant.kill_switch.disable',
  actor: { accountId: 'admin_1', email: 'admin@example.com' },
  timestamp: '2026-05-17T00:00:00.000Z',
};

describe('wrapAdminResponse', () => {
  it('produces canonical envelope shape with data + audit', () => {
    const env = wrapAdminResponse({ status: 'disabled', tenantId: 't_1' }, audit);
    expect(env).toEqual({
      data: { status: 'disabled', tenantId: 't_1' },
      audit,
    });
  });

  it('includes healthCheck only when provided', () => {
    const withoutHc = wrapAdminResponse({ ok: true }, audit);
    expect('healthCheck' in withoutHc).toBe(false);

    const withHc = wrapAdminResponse({ ok: true }, audit, { ok: false, issues: ['x'] });
    expect(withHc.healthCheck).toEqual({ ok: false, issues: ['x'] });
  });

  it('omits the audit key entirely when null is passed (public endpoints)', () => {
    const env = wrapAdminResponse({ platform: 'state' }, null);
    expect('audit' in env).toBe(false);
    expect(env).toEqual({ data: { platform: 'state' } });
  });

  it('allows arbitrary data shapes (no constraint)', () => {
    expect(wrapAdminResponse(null, audit).data).toBeNull();
    expect(wrapAdminResponse([1, 2, 3], audit).data).toEqual([1, 2, 3]);
    expect(wrapAdminResponse('string-data', audit).data).toBe('string-data');
  });
});

describe('adminError', () => {
  it('produces standard error envelope with code only', () => {
    expect(adminError('not_found')).toEqual({ error: 'not_found' });
  });

  it('includes detail when provided', () => {
    expect(adminError('invalid_request', 'must be UUID')).toEqual({
      error: 'invalid_request',
      detail: 'must be UUID',
    });
  });

  it('includes field when provided', () => {
    expect(adminError('invalid_request', 'must be UUID', 'accountId')).toEqual({
      error: 'invalid_request',
      detail: 'must be UUID',
      field: 'accountId',
    });
  });

  it('omits keys for undefined parameters (no `detail: undefined` noise)', () => {
    const env = adminError('not_found');
    expect(Object.keys(env)).toEqual(['error']);
  });
});
