// The load-bearing assumption, tested against the real thing.
//
// The whole design rests on one claim: router state survives a reload without
// anything reaching the URL. The page-level tests mock react-router, so they
// prove the page's logic and not that claim. This file uses a real
// BrowserRouter over jsdom's real History, and a "reload" here is a fresh
// router reading the History the previous one left behind — which is exactly
// what a browser does.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BrowserRouter } from 'react-router'
import { useResumableThread, isThreadGone } from './useResumableThread'

const TENANT = 'tenant-1'

/** Stands in for a chat page: it is handed the open thread, and it reports
 *  whatever the hook says this history entry is holding. */
interface ProbeProps {
  threadId?: string | null
  scopeId?: string
  tenantId?: string
  /** A distinct flag rather than `tenantId: undefined`, which a default
   *  parameter would quietly fill back in. */
  withoutTenant?: boolean
}

function Probe({
  threadId = null,
  tenantId = TENANT,
  scopeId = 'liftoff',
  withoutTenant = false,
}: ProbeProps) {
  const resumed = useResumableThread(threadId, {
    tenantId: withoutTenant ? undefined : tenantId,
    scopeId,
  })
  return <span data-testid="resumed">{resumed ?? 'none'}</span>
}

/** Mount a page at `path`. `setThread` stands in for the page opening a
 *  conversation or leaving one; `unmount` is the first half of a reload. */
function renderAt(path: string, props: ProbeProps = {}) {
  window.history.replaceState(null, '', path)
  const view = render(
    <BrowserRouter>
      <Probe {...props} />
    </BrowserRouter>,
  )
  return {
    ...view,
    setThread(threadId: string | null) {
      view.rerender(
        <BrowserRouter>
          <Probe {...props} threadId={threadId} />
        </BrowserRouter>,
      )
    },
  }
}

/** A browser reload: the page is torn down, History is not. */
function reload(unmount: () => void, props: ProbeProps = {}) {
  unmount()
  return render(
    <BrowserRouter>
      <Probe {...props} />
    </BrowserRouter>,
  )
}

beforeEach(() => {
  window.history.replaceState(null, '', '/dashboard/liftoff')
})

describe('the open thread survives a reload', () => {
  it('reaches the browser History without touching the URL', () => {
    const { setThread } = renderAt('/dashboard/liftoff')
    setThread('thread-1')

    // Persisted where a reload can find it...
    expect((window.history.state as { usr?: { threadId?: string } })?.usr).toMatchObject({
      threadId: 'thread-1',
      threadScope: `${TENANT}:liftoff`,
    })
    // ...and nowhere a person can read it.
    expect(window.location.pathname).toBe('/dashboard/liftoff')
    expect(window.location.search).toBe('')
    expect(window.location.href).not.toContain('thread-1')
  })

  it('is handed back to the page that comes up after the reload', () => {
    const { unmount, setThread } = renderAt('/dashboard/liftoff')
    setThread('thread-1')

    reload(unmount)

    expect(screen.getByTestId('resumed')).toHaveTextContent('thread-1')
  })

  it('preserves the query string, which is where agent chat keeps its team', () => {
    // AgentChatPage carries ?agentId= and ?f=. Navigating to the bare pathname
    // would drop them, and on that page losing agentId redirects away.
    const { unmount, setThread } = renderAt('/dashboard/agents/chat?agentId=agent-1', { scopeId: 'agent-1' })
    setThread('thread-1')

    expect(window.location.search).toBe('?agentId=agent-1')

    reload(unmount, { scopeId: 'agent-1' })
    expect(screen.getByTestId('resumed')).toHaveTextContent('thread-1')
  })

  it('adds no history entries, so Back still leaves the page', () => {
    const { setThread } = renderAt('/dashboard/liftoff')
    const before = window.history.length
    setThread('thread-1')
    setThread('thread-2')

    expect(window.history.length).toBe(before)
  })
})

describe('New chat', () => {
  it('takes the thread back off the entry', () => {
    const { unmount, setThread } = renderAt('/dashboard/liftoff')
    setThread('thread-1')
    setThread(null)

    reload(unmount)
    expect(screen.getByTestId('resumed')).toHaveTextContent('none')
  })
})

describe('an entry that no longer applies', () => {
  it('is refused when the tenant has changed underneath it', () => {
    // switchTenant swaps in place without navigating, so an entry can outlive
    // the tenant it was written under.
    const { unmount, setThread } = renderAt('/dashboard/liftoff')
    setThread('thread-1')

    reload(unmount, { tenantId: 'tenant-2' })
    expect(screen.getByTestId('resumed')).toHaveTextContent('none')
  })

  it('is refused when it belongs to a different team', () => {
    const { unmount, setThread } = renderAt('/dashboard/agents/chat', { scopeId: 'agent-a' })
    setThread('thread-1')

    reload(unmount, { scopeId: 'agent-b' })
    expect(screen.getByTestId('resumed')).toHaveTextContent('none')
  })

  it('does not clear the entry before the page has had a chance to adopt it', () => {
    // The ordering trap. On the mount after a reload the entry holds a thread
    // and the page's own state is still null, because it adopts in an effect
    // that has not run yet. Clearing on that pass would destroy the thing
    // being restored.
    const { unmount, setThread } = renderAt('/dashboard/liftoff')
    setThread('thread-1')
    unmount()

    render(
      <BrowserRouter>
        <Probe />
      </BrowserRouter>,
    )

    expect((window.history.state as { usr?: { threadId?: string } })?.usr).toMatchObject({
      threadId: 'thread-1',
    })
  })

  it('waits for the tenant before stamping anything', () => {
    const { setThread } = renderAt('/dashboard/liftoff', { withoutTenant: true })
    setThread('thread-1')

    // No tenant means no scope to stamp with, and a wrong stamp is worse than
    // a late one.
    expect((window.history.state as { usr?: unknown })?.usr ?? null).toBeNull()
  })
})

describe('isThreadGone', () => {
  it('is true only for a thread that is really not there', () => {
    expect(isThreadGone({ status: 404 })).toBe(true)
    expect(isThreadGone({ status: 403 })).toBe(true)
  })

  it('is false for the failures this feature exists to survive', () => {
    // Losing connection and reloading is how people GET here. Dropping the
    // conversation on a transient failure would recreate the bug, worse.
    expect(isThreadGone(new TypeError('Failed to fetch'))).toBe(false)
    expect(isThreadGone({ status: 500 })).toBe(false)
    expect(isThreadGone({ status: 502 })).toBe(false)
    expect(isThreadGone(null)).toBe(false)
    expect(isThreadGone(undefined)).toBe(false)
  })
})
