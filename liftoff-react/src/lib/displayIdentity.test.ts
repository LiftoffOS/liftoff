// The sidebar described two people at once during a support session: the name
// resolved to the customer while the email under it stayed the operator's and
// the avatar fell back to the operator's photo. These tests pin the rule that
// fixes it — under delegation there is no fallback to the operator, ever.

import { describe, it, expect, beforeEach } from 'vitest'
import { displayIdentity } from './displayIdentity'
import { setDelegation } from './supportDelegation'

const OPERATOR = {
  displayName: 'Alex Rivera',
  email: 'alex.rivera@example.com',
  photoURL: 'https://example.test/operator.jpg',
}

const delegate = () =>
  setDelegation({ ticket: 't', targetEmail: 'paul.drummond@northwind.com' })

describe('displayIdentity', () => {
  beforeEach(() => sessionStorage.clear())

  it('falls back to the Firebase user in an ordinary session', () => {
    const id = displayIdentity(null, OPERATOR)
    expect(id.name).toBe('Alex Rivera')
    expect(id.email).toBe('alex.rivera@example.com')
    expect(id.avatarUrl).toBe('https://example.test/operator.jpg')
  })

  it('prefers the account when there is one', () => {
    const id = displayIdentity(
      { firstName: 'Paul', lastName: 'Drummond', email: 'paul.drummond@northwind.com', avatarUrl: null },
      OPERATOR,
    )
    expect(id.name).toBe('Paul')
    expect(id.email).toBe('paul.drummond@northwind.com')
  })

  it('never shows the operator email under the customer name', () => {
    // The exact defect: account had a first name, so the NAME was the
    // customer's, but the email fell through to the operator's.
    delegate()
    const id = displayIdentity(
      { firstName: 'Paul', lastName: 'Drummond', email: 'paul.drummond@northwind.com', avatarUrl: null },
      OPERATOR,
    )
    expect(id.name).toBe('Paul')
    expect(id.email).toBe('paul.drummond@northwind.com')
    expect(id.email).not.toBe(OPERATOR.email)
  })

  it('shows no face rather than the operator face when the customer has no avatar', () => {
    delegate()
    const id = displayIdentity(
      { firstName: 'Paul', lastName: 'Drummond', email: 'paul.drummond@northwind.com', avatarUrl: null },
      OPERATOR,
    )
    expect(id.avatarUrl).toBeNull()
  })

  it('leaks nothing when the customer account is missing every field', () => {
    delegate()
    const id = displayIdentity({}, OPERATOR)
    expect(id.email).toBeNull()
    expect(id.avatarUrl).toBeNull()
    expect(id.fullName).toBeNull()
    expect(id.name).toBe('User')
    expect(JSON.stringify(id)).not.toContain('alex.rivera')
  })

  it('uses the customer avatar when they have one', () => {
    delegate()
    const id = displayIdentity(
      { firstName: 'Paul', email: 'paul.drummond@northwind.com', avatarUrl: 'https://example.test/paul.jpg' },
      OPERATOR,
    )
    expect(id.avatarUrl).toBe('https://example.test/paul.jpg')
  })
})
