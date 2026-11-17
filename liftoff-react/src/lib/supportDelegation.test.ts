import { describe, it, expect, beforeEach } from 'vitest'
import {
  getDelegation,
  setDelegation,
  clearDelegation,
  isDelegating,
  delegationHeader,
  selectedTenantKey,
  DELEGATION_HEADER,
} from './supportDelegation'

const session = () => ({
  ticket: 'ticket-abc',
  targetEmail: 'paul.drummond@northwind.com',
})

describe('supportDelegation', () => {
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
  })

  it('reports no session by default, which is the state of every ordinary tab', () => {
    expect(getDelegation()).toBeNull()
    expect(isDelegating()).toBe(false)
    expect(delegationHeader()).toEqual({})
  })

  it('round-trips a session and produces the request header', () => {
    setDelegation(session())
    expect(isDelegating()).toBe(true)
    expect(delegationHeader()).toEqual({ [DELEGATION_HEADER]: 'ticket-abc' })
  })

  it('clears on exit', () => {
    setDelegation(session())
    clearDelegation()
    expect(getDelegation()).toBeNull()
    expect(delegationHeader()).toEqual({})
  })

  it('does not expire on its own: the server is the only authority on that', () => {
    // Sessions end by revocation or by the tab closing. A clock in the browser
    // would only ever disagree with the server.
    setDelegation(session())
    expect(getDelegation()).not.toBeNull()
  })

  it('ignores corrupt or foreign values instead of throwing during render', () => {
    sessionStorage.setItem('liftoff_support_delegation', 'not json')
    expect(getDelegation()).toBeNull()

    sessionStorage.setItem('liftoff_support_delegation', JSON.stringify({ ticket: 42 }))
    expect(getDelegation()).toBeNull()
  })

  it('lives in sessionStorage so a second tab is still the operator', () => {
    setDelegation(session())
    // localStorage is the shared-across-tabs store. Nothing may land there, or
    // the whole browser would enter the customer's account at once.
    expect(localStorage.getItem('liftoff_support_delegation')).toBeNull()
    expect(sessionStorage.getItem('liftoff_support_delegation')).not.toBeNull()
  })

  it('namespaces the workspace key only while delegating', () => {
    expect(selectedTenantKey()).toBe('liftoff_selected_tenant')
    setDelegation(session())
    expect(selectedTenantKey()).toBe('liftoff_selected_tenant:paul.drummond@northwind.com')
  })
})
