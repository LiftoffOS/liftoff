// useDeptSlug — empty-role guard regression tests against the real hook.
//
// This tests the actual hook used by AgentUpdatePage (and any other AI-team
// form), not a copy of the pattern. A future refactor that drops the guard
// fails these tests. Replaces the earlier behavior-spec test which only
// verified a replica of the pattern.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup, waitFor } from '@testing-library/react'

vi.mock('../services/internalAgents', () => ({
  getDepartmentSlug: vi.fn(),
}))

import { getDepartmentSlug } from '../services/internalAgents'
import { useDeptSlug } from './useDeptSlug'

const mockedGetDeptSlug = getDepartmentSlug as ReturnType<typeof vi.fn>

describe('useDeptSlug — empty-role guard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockedGetDeptSlug.mockReset()
    mockedGetDeptSlug.mockResolvedValue('mock-slug')
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('does NOT call getDepartmentSlug when role is empty', () => {
    renderHook(() => useDeptSlug('', '', ''))
    vi.advanceTimersByTime(2000)
    expect(mockedGetDeptSlug).not.toHaveBeenCalled()
  })

  it('does NOT call getDepartmentSlug when role is whitespace-only', () => {
    renderHook(() => useDeptSlug('   \n  ', '', ''))
    vi.advanceTimersByTime(2000)
    expect(mockedGetDeptSlug).not.toHaveBeenCalled()
  })

  it('does NOT call getDepartmentSlug when responsibilities change but role stays empty', () => {
    const { rerender } = renderHook(
      ({ r, resp, ctx }) => useDeptSlug(r, resp, ctx),
      { initialProps: { r: '', resp: '', ctx: '' } },
    )
    rerender({ r: '', resp: 'new responsibilities', ctx: '' })
    vi.advanceTimersByTime(2000)
    expect(mockedGetDeptSlug).not.toHaveBeenCalled()
  })

  it('DOES call getDepartmentSlug after 800ms debounce when role is non-empty', async () => {
    renderHook(() => useDeptSlug('Sales Engineer', '', ''))
    // Below debounce window — not yet called
    vi.advanceTimersByTime(500)
    expect(mockedGetDeptSlug).not.toHaveBeenCalled()
    // Past debounce window — fires
    await vi.advanceTimersByTimeAsync(400)
    expect(mockedGetDeptSlug).toHaveBeenCalledWith('Sales Engineer', '', '')
  })

  it('clears prior timer when role transitions non-empty → empty before fire', () => {
    const { rerender } = renderHook(
      ({ r }) => useDeptSlug(r, '', ''),
      { initialProps: { r: 'Engineer' } },
    )
    // 100ms in — pending timer
    vi.advanceTimersByTime(100)
    // Role goes back to empty before debounce fires
    rerender({ r: '' })
    vi.advanceTimersByTime(2000)
    // Should NOT have fired for the prior non-empty value
    expect(mockedGetDeptSlug).not.toHaveBeenCalled()
  })

  it('returns the resolved slug after the LLM call completes', async () => {
    // Use real timers for state-flush tests: fake timers + React's
    // setState-after-promise-resolution doesn't flush cleanly without
    // a fully orchestrated act() dance.
    vi.useRealTimers()
    mockedGetDeptSlug.mockResolvedValueOnce('sales')
    const { result } = renderHook(() => useDeptSlug('Sales Engineer', '', ''))
    expect(result.current).toBe('')  // initial
    await waitFor(() => expect(result.current).toBe('sales'), { timeout: 2000 })
  })

  it('falls back to first-word slug if the LLM call throws', async () => {
    vi.useRealTimers()
    mockedGetDeptSlug.mockRejectedValueOnce(new Error('500'))
    const { result } = renderHook(() => useDeptSlug('Customer Support', '', ''))
    await waitFor(() => expect(result.current).toBe('customer'), { timeout: 2000 })
  })

  it('resets the slug to "" when role transitions from non-empty (resolved) to empty', async () => {
    // Matches the docstring contract: clearing role clears the displayed
    // slug so callers (e.g., AgentUpdatePage) don't show a stale resolved
    // suffix from the prior role.
    vi.useRealTimers()
    mockedGetDeptSlug.mockResolvedValueOnce('sales')
    const { result, rerender } = renderHook(
      ({ r }) => useDeptSlug(r, '', ''),
      { initialProps: { r: 'Sales Engineer' } },
    )
    await waitFor(() => expect(result.current).toBe('sales'), { timeout: 2000 })
    rerender({ r: '' })
    await waitFor(() => expect(result.current).toBe(''), { timeout: 2000 })
  })

  it('does NOT overwrite slug with stale in-flight resolution after role clears', async () => {
    // Race regression: user types "Sales Engineer", the 800ms timer fires
    // and the LLM call is in flight; before it resolves the user clears
    // the input. The late-arriving 'sales' must NOT clobber the empty
    // string the empty-role guard just installed.
    vi.useRealTimers()
    let resolveFn: (value: string) => void = () => {}
    const deferred = new Promise<string>((res) => { resolveFn = res })
    mockedGetDeptSlug.mockReturnValueOnce(deferred)

    const { result, rerender } = renderHook(
      ({ r }) => useDeptSlug(r, '', ''),
      { initialProps: { r: 'Sales Engineer' } },
    )
    // Wait for the 800ms debounce to fire the (now-pending) fetch.
    await waitFor(() => expect(mockedGetDeptSlug).toHaveBeenCalledTimes(1), { timeout: 2000 })
    expect(result.current).toBe('') // not yet resolved

    // Clear role — guard sets deptSlug to '' and cleanup flips cancelled.
    rerender({ r: '' })
    expect(result.current).toBe('')

    // Now resolve the stale promise. The cancelled flag must skip setState.
    resolveFn('sales')

    // Give microtasks + a beat of real time so any errant setState would land.
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current).toBe('')
  })
})
