import { useEffect, useRef, useState } from 'react'
import { getDepartmentSlug } from '../services/internalAgents'

/**
 * Debounced department-slug resolver for AI-team forms.
 *
 * Watches `role`, `responsibilities`, and `additionalContext`. When `role`
 * is non-empty (after .trim), 800ms after the last change it POSTs to
 * /api/internal-agents/department-slug for an LLM-extracted department
 * slug (e.g., "Sales Engineer" → "sales"). On failure, falls back to the
 * first word of the role.
 *
 * Empty-role guard: when role is empty or whitespace-only, no network
 * request is fired (backend correctly 400s on empty role; the guard
 * prevents the resulting console noise). The fallback slug is also reset
 * to '' in that case so callers can decide a UI-only suffix.
 *
 * Race-cancellation: each effect run installs a local `cancelled` flag
 * that the cleanup function flips. The in-flight LLM call checks the flag
 * after `await` returns; if cancelled, the result (or fallback) is
 * discarded. This prevents a slow resolution from a previous role value
 * from overwriting newer state — e.g., user types "Sales Engineer", call
 * starts, user clears the field; the late response cannot stomp the
 * intentionally-cleared slug.
 *
 * Returns the current slug string.
 */
export function useDeptSlug(
  role: string,
  responsibilities: string,
  additionalContext: string,
): string {
  const [deptSlug, setDeptSlug] = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!role.trim()) {
      return () => { cancelled = true }
    }
    timerRef.current = setTimeout(async () => {
      timerRef.current = null
      try {
        const slug = await getDepartmentSlug(role, responsibilities, additionalContext)
        if (cancelled) return
        setDeptSlug(slug)
      } catch {
        if (cancelled) return
        setDeptSlug(role.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9-]/g, ''))
      }
    }, 800)
    return () => {
      cancelled = true
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [role, responsibilities, additionalContext])

  // Derived rather than cleared. An empty role has no department, whatever the
  // last lookup left behind, so no effect has to remember to blank it.
  return role.trim() ? deptSlug : ''
}
