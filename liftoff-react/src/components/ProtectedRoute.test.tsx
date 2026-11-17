import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import ProtectedRoute from './ProtectedRoute'
import { setDelegation } from '../lib/supportDelegation'

// Mock useAuth with configurable return values
const mockUseAuth = vi.fn()
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

function renderWithRouter(initialPath = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/dashboard" element={
          <ProtectedRoute>
            <div data-testid="dashboard-content">Dashboard</div>
          </ProtectedRoute>
        } />
        <Route path="/login" element={<div data-testid="login-page">Login</div>} />
        <Route path="/verify-email" element={<div data-testid="verify-email-page">Verify Email</div>} />
        <Route path="/" element={<div data-testid="home-page">Home</div>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    // Every other case in this file is an ordinary tab, which is the state a
    // cleared store represents.
    sessionStorage.clear()
  })

  it('shows spinner when loading', () => {
    mockUseAuth.mockReturnValue({ loading: true, user: null, account: null, backendConnected: true })
    renderWithRouter()
    expect(screen.queryByTestId('dashboard-content')).not.toBeInTheDocument()
  })

  it('redirects to /login when no user', () => {
    mockUseAuth.mockReturnValue({ loading: false, user: null, account: null, backendConnected: true })
    renderWithRouter()
    expect(screen.getByTestId('login-page')).toBeInTheDocument()
  })

  it('shows error state when backend is not connected', () => {
    mockUseAuth.mockReturnValue({ loading: false, user: { uid: 'test', emailVerified: true }, account: null, backendConnected: false })
    renderWithRouter()
    expect(screen.queryByTestId('dashboard-content')).not.toBeInTheDocument()
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument()
  })

  it('shows spinner when account is null (sync in progress)', () => {
    mockUseAuth.mockReturnValue({ loading: false, user: { uid: 'test', emailVerified: true }, account: null, backendConnected: true })
    renderWithRouter()
    expect(screen.queryByTestId('dashboard-content')).not.toBeInTheDocument()
  })

  it('redirects to /verify-email when the user email is not verified', () => {
    mockUseAuth.mockReturnValue({
      loading: false,
      user: { uid: 'test', emailVerified: false },
      account: null,
      backendConnected: true,
    })
    renderWithRouter()
    expect(screen.getByTestId('verify-email-page')).toBeInTheDocument()
    expect(screen.queryByTestId('dashboard-content')).not.toBeInTheDocument()
  })

  it('does not apply the operator\'s own verification state to a support session', () => {
    // `user` stays the operator for the whole session, because their Firebase
    // credential is never swapped. Sending them to /verify-email over THEIR
    // email would strand a support session on a screen about the wrong person.
    setDelegation({ ticket: 'ticket-abc', targetEmail: 'paul.drummond@northwind.com' })
    mockUseAuth.mockReturnValue({
      loading: false,
      user: { uid: 'operator', emailVerified: false },
      account: { id: 'a1', accessGranted: true },
      backendConnected: true,
    })
    renderWithRouter()
    expect(screen.queryByTestId('verify-email-page')).not.toBeInTheDocument()
    expect(screen.getByTestId('dashboard-content')).toBeInTheDocument()
  })

  it('sends a denied account to the home page (the invite-request page is retired)', () => {
    mockUseAuth.mockReturnValue({
      loading: false,
      user: { uid: 'test', emailVerified: true },
      account: { accessGranted: false },
      backendConnected: true,
    })
    renderWithRouter()
    expect(screen.getByTestId('home-page')).toBeInTheDocument()
  })

  it('renders children when accessGranted is true', () => {
    mockUseAuth.mockReturnValue({
      loading: false,
      user: { uid: 'test', emailVerified: true },
      account: { accessGranted: true },
      backendConnected: true,
    })
    renderWithRouter()
    expect(screen.getByTestId('dashboard-content')).toBeInTheDocument()
  })

  it('renders children when accessGranted is undefined (backward compat)', () => {
    mockUseAuth.mockReturnValue({
      loading: false,
      user: { uid: 'test', emailVerified: true },
      account: { /* accessGranted not present */ },
      backendConnected: true,
    })
    renderWithRouter()
    expect(screen.getByTestId('dashboard-content')).toBeInTheDocument()
  })
})
