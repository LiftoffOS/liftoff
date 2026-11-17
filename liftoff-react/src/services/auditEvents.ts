import { api } from './api'

// Phase 3 — best-effort, debounced reporter for activity-page reads and
// Firebase-managed security events. All failures are swallowed (logged to
// console) so the UI never breaks because of audit reporting.

const pendingTimers: Record<string, ReturnType<typeof setTimeout>> = {}

export function reportAuditEvent(
  type: string,
  payload: { resourceId?: string; params?: Record<string, unknown> },
  debounceMs?: number,
): void {
  const key = `${type}:${payload.resourceId ?? ''}`
  if (debounceMs) {
    if (pendingTimers[key]) clearTimeout(pendingTimers[key])
    pendingTimers[key] = setTimeout(() => {
      void send(type, payload)
      delete pendingTimers[key]
    }, debounceMs)
    return
  }
  void send(type, payload)
}

async function send(
  type: string,
  payload: { resourceId?: string; params?: Record<string, unknown> },
): Promise<void> {
  try {
    await api.post('/api/audit/activity-events', { type, ...payload })
  } catch (e) {
    console.warn('audit-event report failed', type, e)
  }
}

export async function reportSecurityEvent(
  type: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  // Only include `metadata` in the JSON payload when actually provided —
  // sending `metadata: undefined` would either be dropped by JSON.stringify
  // (correct) or, depending on serialization path, surface as `metadata: null`
  // on the wire which the backend would treat as an empty audit row. Keeping
  // the shape clean here makes the wire contract match the in-memory call.
  const body: { type: string; metadata?: Record<string, unknown> } = { type }
  if (metadata !== undefined) body.metadata = metadata
  try {
    await api.post('/api/audit/security-events', body)
  } catch (e) {
    console.warn('audit security-event report failed', type, e)
  }
}
