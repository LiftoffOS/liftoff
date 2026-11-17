// What a view-only seat is shown.
//
// Two controls were visible to every role while the API refused them: Correct on
// the Activity page, and Connect / Manage on the Connections page. Showing a
// control that cannot work is its own defect — the person reads the failure as
// the product being broken rather than as a permission they do not have — so
// these assert the table the gate reads, in both directions.

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TenantRole } from '../services/tenants'

const role = vi.hoisted(() => ({ current: 'viewer' as TenantRole }))
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ currentRole: role.current }),
}))

import { PermissionGate } from './PermissionGate'

function shownTo(r: TenantRole, permission: string): boolean {
  role.current = r
  const { unmount } = render(
    // @ts-expect-error — the permission is a string here on purpose, so a
    // renamed key fails this test rather than silently passing.
    <PermissionGate permission={permission} fallback={null}>
      <span>control</span>
    </PermissionGate>,
  )
  const seen = screen.queryByText('control') !== null
  unmount()
  return seen
}

describe('correcting an action an agent took', () => {
  it('is offered to a member, matching the API', () => {
    // The API gate is submitCorrections, which is member and above. It used to
    // borrow viewAuditLogs, which is owner/admin — so a member saw this control
    // and got a failure from it.
    for (const r of ['owner', 'admin', 'member'] as const) {
      expect(shownTo(r, 'submit_corrections')).toBe(true)
    }
  })

  it('is not offered to a viewer', () => {
    expect(shownTo('viewer', 'submit_corrections')).toBe(false)
  })
})

describe('connecting an app, and managing a connection', () => {
  it('is owner and admin only, matching manageConnectors on every write', () => {
    expect(shownTo('owner', 'manage_connections')).toBe(true)
    expect(shownTo('admin', 'manage_connections')).toBe(true)
    expect(shownTo('member', 'manage_connections')).toBe(false)
    expect(shownTo('viewer', 'manage_connections')).toBe(false)
  })
})
