// Who may correct an action an agent took.
//
// This was gated on `viewAuditLogs`, which is owner/admin because that is who
// may open the Audit Logs section — a different question from who owns the work.
// The effect was that a member saw a Correct button on the Activity page and got
// a failure from it. Correcting now has its own permission, and the two must not
// be tied back together.

import { ROLE_PERMISSIONS } from '../types';

it('a member may correct; a viewer may not', () => {
  expect(ROLE_PERMISSIONS.owner.submitCorrections).toBe(true);
  expect(ROLE_PERMISSIONS.admin.submitCorrections).toBe(true);
  expect(ROLE_PERMISSIONS.member.submitCorrections).toBe(true);
  // The read-only seat. This is the whole restriction.
  expect(ROLE_PERMISSIONS.viewer.submitCorrections).toBe(false);
});

it('is its own permission, not a synonym for reading the audit log', () => {
  // The regression, stated as a property: these two disagree for a member, which
  // is precisely why borrowing one for the other was wrong.
  expect(ROLE_PERMISSIONS.member.submitCorrections).not
    .toBe(ROLE_PERMISSIONS.member.viewAuditLogs);
});
