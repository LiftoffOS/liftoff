// useExternalAgents — tests that the queryKey threads currentTenant.id
// through so React Query maintains a distinct cache slot per tenant.
// Regression test for cross-tenant cache pollution.

import { describe, it, expect } from 'vitest'
import { externalAgentKeys } from './useExternalAgents'

describe('externalAgentKeys', () => {
  describe('lists', () => {
    it('produces a different key when tenantId differs', () => {
      const keyA = externalAgentKeys.lists('tenant-a')
      const keyB = externalAgentKeys.lists('tenant-b')
      expect(keyA).not.toEqual(keyB)
    })

    it('produces the same key for the same tenant', () => {
      const keyA = externalAgentKeys.lists('tenant-a')
      const keyB = externalAgentKeys.lists('tenant-a')
      expect(keyA).toEqual(keyB)
    })

    it('handles undefined tenantId distinctly from a tenant id', () => {
      const keyUndef = externalAgentKeys.lists(undefined)
      const keyDefined = externalAgentKeys.lists('tenant-a')
      expect(keyUndef).not.toEqual(keyDefined)
    })
  })

  describe('list', () => {
    it('produces a different key when tenantId differs (even with same filters)', () => {
      const keyA = externalAgentKeys.list('tenant-a', { status: 'active' })
      const keyB = externalAgentKeys.list('tenant-b', { status: 'active' })
      expect(keyA).not.toEqual(keyB)
    })

    it('produces a different key when filters differ (same tenant)', () => {
      const keyA = externalAgentKeys.list('tenant-a', { status: 'active' })
      const keyB = externalAgentKeys.list('tenant-a', {})
      expect(keyA).not.toEqual(keyB)
    })
  })

  describe('detail', () => {
    it('produces a different key when tenantId differs (same agent id)', () => {
      const keyA = externalAgentKeys.detail('tenant-a', 'agent-1')
      const keyB = externalAgentKeys.detail('tenant-b', 'agent-1')
      expect(keyA).not.toEqual(keyB)
    })

    it('produces a different key when agent id differs (same tenant)', () => {
      const keyA = externalAgentKeys.detail('tenant-a', 'agent-1')
      const keyB = externalAgentKeys.detail('tenant-a', 'agent-2')
      expect(keyA).not.toEqual(keyB)
    })
  })

  describe('versions', () => {
    it('produces a different key when tenantId differs (same agent id)', () => {
      const keyA = externalAgentKeys.versions('tenant-a', 'agent-1')
      const keyB = externalAgentKeys.versions('tenant-b', 'agent-1')
      expect(keyA).not.toEqual(keyB)
    })

    it('nests under detail key', () => {
      const detailKey = externalAgentKeys.detail('tenant-a', 'agent-1')
      const versionsKey = externalAgentKeys.versions('tenant-a', 'agent-1')
      // versions key contains the detail key as a prefix
      expect(versionsKey.slice(0, detailKey.length)).toEqual(detailKey)
    })
  })

  describe('cross-tenant isolation regression', () => {
    // The bug this hook fix is preventing: before PR 4, externalAgentKeys
    // omitted tenantId, so React Query would return cached data from a
    // previously-selected tenant when the user switched workspaces.
    it('every key function rejects cross-tenant cache collisions', () => {
      const a1 = externalAgentKeys.lists('tenant-a')
      const b1 = externalAgentKeys.lists('tenant-b')
      const a2 = externalAgentKeys.list('tenant-a', { status: 'active' })
      const b2 = externalAgentKeys.list('tenant-b', { status: 'active' })
      const a3 = externalAgentKeys.detail('tenant-a', 'shared-agent-id')
      const b3 = externalAgentKeys.detail('tenant-b', 'shared-agent-id')
      const a4 = externalAgentKeys.versions('tenant-a', 'shared-agent-id')
      const b4 = externalAgentKeys.versions('tenant-b', 'shared-agent-id')

      // React Query compares keys by deep equality. If any of these collide,
      // the cache slot is shared across tenants.
      expect(JSON.stringify(a1)).not.toBe(JSON.stringify(b1))
      expect(JSON.stringify(a2)).not.toBe(JSON.stringify(b2))
      expect(JSON.stringify(a3)).not.toBe(JSON.stringify(b3))
      expect(JSON.stringify(a4)).not.toBe(JSON.stringify(b4))
    })
  })
})
