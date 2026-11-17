// Signup approval API client — Approve/Waitlist a new signup.
//
// Typed wrappers for the backend admin pair behind /api/admin/signup-approvals.
// Uses the shared Firebase-authed api helper (service-layer rule). The caller
// must be a platform admin; the backend gates via adminAuthMiddleware. Those
// endpoints return the standard admin envelope ({ data, audit }), so both calls
// unwrap `.data`.

import { api } from './api'

export interface SignupApproval {
  firstName: string
  lastName: string
  email: string
  accessGranted: boolean
}

// Outcome of an approve/waitlist decision. `alreadyApproved` is true when the
// account was already approved: for approve it means the grant was a no-op (the
// welcome is still re-sent); for waitlist it means the request was a no-op (an
// approved account is NOT downgraded/revoked).
export interface SignupApprovalOutcome {
  approved?: boolean
  waitlisted?: boolean
  alreadyApproved?: boolean
}

interface AdminEnvelope<T> {
  data: T
}

export async function getSignupApproval(token: string): Promise<SignupApproval> {
  const res = await api.get<AdminEnvelope<SignupApproval>>(
    `/api/admin/signup-approvals/${encodeURIComponent(token)}`,
  )
  return res.data
}

export async function submitSignupApproval(
  token: string,
  action: 'approve' | 'waitlist',
): Promise<SignupApprovalOutcome> {
  const res = await api.post<AdminEnvelope<SignupApprovalOutcome>>(
    `/api/admin/signup-approvals/${action}`,
    { token },
  )
  return res.data
}
