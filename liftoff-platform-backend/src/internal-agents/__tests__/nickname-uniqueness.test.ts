// Nickname uniqueness is case-INSENSITIVE.
//
// Nicknames are how a person addresses a teammate in Slack ("Sarah: take a
// look"), and that lookup lowercases both sides. If "Sarah" and "sarah" could
// both exist, addressing would match two agents and silently answer as one of
// them, with nothing telling the sender which. Both the save path and the
// availability endpoint the UI debounces against must use the same comparison,
// or the UI reports available for a name that then 409s.

import { jest } from '@jest/globals';

const queryMock = jest.fn<(...a: unknown[]) => Promise<{ rows: unknown[] }>>();
jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...a: unknown[]) => queryMock(...a) },
  withTenantScope: (_t: unknown, fn: (c: { query: typeof queryMock }) => Promise<unknown>) =>
    fn({ query: queryMock }),
}));

describe('nickname uniqueness comparison', () => {
  beforeEach(() => jest.clearAllMocks());

  it('the save path compares case-insensitively', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../service.ts'), 'utf8',
    ) as string;
    const check = src.slice(src.indexOf('const nicknameConflict'), src.indexOf('NICKNAME_CONFLICT'));
    expect(check).toContain('LOWER(messaging_nickname) = LOWER($2)');
    expect(check).not.toMatch(/WHERE tenant_id = \$1 AND messaging_nickname = \$2/);
  });

  it('the availability endpoint compares the same way (no available-then-409 gap)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../router.ts'), 'utf8',
    ) as string;
    const idx = src.indexOf("'/check-nickname'");
    expect(idx).toBeGreaterThan(-1);
    const handler = src.slice(idx, idx + 1600);
    expect(handler).toContain('LOWER(messaging_nickname) = LOWER($2)');
  });
});
