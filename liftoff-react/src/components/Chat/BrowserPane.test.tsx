import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import BrowserPane from './BrowserPane'

const noop = () => {}
const baseProps = {
  // Viewer is somebody other than the session owner unless a case says otherwise.
  viewerAccountId: 'acc-2',
  lastUrlKey: null, wasNewlyCreated: false,
  ensureError: false,
  pausedFrameUrl: null,
  onClose: noop, onResizeStart: noop, onRetryEnsure: noop,
  onRestoreFromLastUrl: noop,
}

beforeEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('BrowserPane', () => {
  it('shows a spinner (no copy, no buttons) in the default no-session state', () => {
    // Default state covers: pane just opened (mid-ensure), initial active
    // query loading, the brief render between mount and ensure firing, etc.
    // Showing misleading "Browser session ended" copy or a "Start a new
    // browser session" button here was wrong — the user never closed
    // anything, they just opened the pane.
    const { container } = render(<BrowserPane {...baseProps} session={null} />)
    expect(container.querySelector('.loading-spinner')).toBeInTheDocument()
    expect(screen.queryByText(/browser session ended/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/start a new browser session/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/starting browser/i)).not.toBeInTheDocument()
  })

  it('renders the iframe with liveViewUrl when session exists', () => {
    render(<BrowserPane {...baseProps}
      session={{ id: 's1', liveViewUrl: 'https://live', ownerAccountId: 'acc-1' }} />)
    expect(screen.getByTitle('Browser')).toHaveAttribute('src', 'https://live')
  })

  describe('iframe load gating', () => {
    // The grey-flash bug: when session flips from null → set, the iframe
    // mounts but Anchor's live view takes time (HTML fetch + VNC handshake)
    // to render. Without gating the user saw spinner → grey iframe body →
    // browser. With gating: spinner stays on top of the iframe until onLoad
    // fires AND a post-load grace period elapses (covers the VNC handshake).
    afterEach(() => { vi.useRealTimers() })

    it('shows a spinner overlay on top of the iframe until onLoad + grace period', () => {
      vi.useFakeTimers()
      const { container } = render(<BrowserPane {...baseProps}
        session={{ id: 's1', liveViewUrl: 'https://live', ownerAccountId: null }} />)
      expect(screen.getByTitle('Browser')).toBeInTheDocument()
      expect(container.querySelector('.chat-page__browser-pane-iframe-overlay'))
        .toBeInTheDocument()
      expect(container.querySelector('.loading-spinner')).toBeInTheDocument()
    })

    it('keeps the overlay through the post-load grace period, then removes it', () => {
      vi.useFakeTimers()
      const { container } = render(<BrowserPane {...baseProps}
        session={{ id: 's1', liveViewUrl: 'https://live', ownerAccountId: null }} />)
      fireEvent.load(screen.getByTitle('Browser'))
      // Overlay still present immediately after onLoad (covers VNC handshake).
      expect(container.querySelector('.chat-page__browser-pane-iframe-overlay'))
        .toBeInTheDocument()
      // After grace period elapses, overlay is gone.
      act(() => { vi.advanceTimersByTime(1500) })
      expect(container.querySelector('.chat-page__browser-pane-iframe-overlay'))
        .not.toBeInTheDocument()
    })

    it('re-shows the overlay when session.id changes (new iframe, new load gap)', () => {
      vi.useFakeTimers()
      const { rerender, container } = render(<BrowserPane {...baseProps}
        session={{ id: 's1', liveViewUrl: 'https://live', ownerAccountId: null }} />)
      fireEvent.load(screen.getByTitle('Browser'))
      act(() => { vi.advanceTimersByTime(1500) })
      expect(container.querySelector('.chat-page__browser-pane-iframe-overlay'))
        .not.toBeInTheDocument()

      rerender(<BrowserPane {...baseProps}
        session={{ id: 's2', liveViewUrl: 'https://live-2', ownerAccountId: null }} />)
      expect(container.querySelector('.chat-page__browser-pane-iframe-overlay'))
        .toBeInTheDocument()
    })
  })

  it('does not render an End session affordance even for the session owner', () => {
    render(<BrowserPane {...baseProps}
      session={{ id: 's1', liveViewUrl: 'x', ownerAccountId: 'acc-1' }} />)
    expect(screen.queryByText('End session')).not.toBeInTheDocument()
  })

  it('shows a single "Unable to start the browser" message on ensure failure (no per-kind copy)', () => {
    // The pane intentionally does NOT vary copy by vendor failure kind. Real
    // kind information lives on the backend (logs/metrics) and the typed
    // EnsureSessionError on the wire — surfacing four different messages to
    // the user creates confusion without changing what they can do (Try
    // Again). This test pins that single-copy contract.
    const onRetryEnsure = vi.fn()
    render(<BrowserPane {...baseProps} session={null}
      ensureError onRetryEnsure={onRetryEnsure} />)
    expect(screen.getByText('Unable to start the browser')).toBeInTheDocument()
    const retry = screen.getByText('Try Again')
    expect(retry).toHaveClass('btn--outline')
    fireEvent.click(retry)
    expect(onRetryEnsure).toHaveBeenCalled()
  })

  describe('paused-frame state (idle-reaped prior session with cached screenshot)', () => {
    it('renders the cached frame + a "Session paused — Resume browsing" overlay', () => {
      render(<BrowserPane {...baseProps}
        session={null}
        pausedFrameUrl="https://signed-url/last.png" />)
      const img = screen.getByAltText(/last view of the paused browser session/i)
      expect(img).toHaveAttribute('src', 'https://signed-url/last.png')
      expect(screen.getByText('Session paused')).toBeInTheDocument()
      expect(screen.getByText(/period of inactivity/i)).toBeInTheDocument()
      expect(screen.getByText('Resume browsing')).toBeInTheDocument()
    })

    it('fires onRetryEnsure when the Resume browsing button is clicked', () => {
      const onRetryEnsure = vi.fn()
      render(<BrowserPane {...baseProps}
        session={null}
        pausedFrameUrl="https://signed-url/last.png"
        onRetryEnsure={onRetryEnsure} />)
      fireEvent.click(screen.getByText('Resume browsing'))
      expect(onRetryEnsure).toHaveBeenCalled()
    })

    it('takes precedence over ensureError — cached frame wins over the error message', () => {
      render(<BrowserPane {...baseProps}
        session={null}
        pausedFrameUrl="https://signed-url/last.png"
        ensureError />)
      expect(screen.queryByText('Unable to start the browser')).not.toBeInTheDocument()
      expect(screen.getByText('Session paused')).toBeInTheDocument()
    })

    it('is hidden once a live session exists', () => {
      render(<BrowserPane {...baseProps}
        session={{ id: 's1', liveViewUrl: 'https://live', ownerAccountId: null }}
        pausedFrameUrl="https://signed-url/last.png" />)
      expect(screen.queryByText('Session paused')).not.toBeInTheDocument()
      expect(screen.queryByAltText(/paused browser session/i)).not.toBeInTheDocument()
      expect(screen.getByTitle('Browser')).toBeInTheDocument()
    })
  })

  // One driver at a time: the agent unless a human took over, and only that
  // human may click. Anchor's documented mechanism for a non-interactive live
  // view is pointer-events: none, which this class applies.
  describe('control and observer mode', () => {
    const live = {
      id: 's1', liveViewUrl: 'https://live', ownerAccountId: 'acc-1',
    }
    const driverIsMe = {
      accountId: 'acc-2', firstName: 'Me', lastName: 'Here',
      email: 'me@example.com', avatarUrl: null,
      takenAt: '2026-07-28T00:00:00.000Z', present: true,
    }

    // Taking over is clicking into the browser. No button is offered for it:
    // the capture layer turns that first click into the takeover.
    it('takes over on a click into the browser while the agent drives', () => {
      const onTakeControl = vi.fn()
      const { container } = render(<BrowserPane {...baseProps}
        session={{ ...live, takeoverState: 'none', driver: null }}
        onTakeControl={onTakeControl} />)

      expect(screen.getByTitle('Browser'))
        .toHaveClass('chat-page__browser-pane-iframe--observing')
      expect(screen.queryByText('Take control')).not.toBeInTheDocument()
      fireEvent.click(container.querySelector('.chat-page__browser-pane-capture')!)
      expect(onTakeControl).toHaveBeenCalled()
    })

    it('says the click was taken while the takeover is in flight, and swallows further clicks meanwhile', () => {
      // The runtime attaches its recorder before it answers; until then the
      // capture layer is disabled. Without a word there, a second click
      // read as the first having done nothing.
      const onTakeControl = vi.fn()
      const { container } = render(<BrowserPane {...baseProps}
        session={{ ...live, takeoverState: 'none', driver: null }}
        onTakeControl={onTakeControl} controlPending />)
      expect(screen.getByRole('status')).toHaveTextContent('Taking control…')
      const capture = container.querySelector('.chat-page__browser-pane-capture') as HTMLButtonElement
      expect(capture).toBeDisabled()
      expect(capture).toHaveAttribute('aria-busy', 'true')
      fireEvent.click(capture)
      expect(onTakeControl).not.toHaveBeenCalled()
    })

    it('shows no pending state when nothing is in flight', () => {
      render(<BrowserPane {...baseProps}
        session={{ ...live, takeoverState: 'none', driver: null }}
        onTakeControl={vi.fn()} />)
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })

    it('lets the driver interact, with no capture layer in the way', () => {
      const onReleaseControl = vi.fn()
      const { container } = render(<BrowserPane {...baseProps}
        session={{ ...live, takeoverState: 'taken_over', driver: driverIsMe }}
        agentName="Ada" onReleaseControl={onReleaseControl} />)

      expect(screen.getByTitle('Browser'))
        .not.toHaveClass('chat-page__browser-pane-iframe--observing')
      expect(container.querySelector('.chat-page__browser-pane-capture')).not.toBeInTheDocument()
      fireEvent.click(screen.getByText('Hand back to Ada'))
      expect(onReleaseControl).toHaveBeenCalled()
    })

    it('observes, and can click to take over, when somebody else drives', () => {
      const { container } = render(<BrowserPane {...baseProps}
        session={{
          ...live, takeoverState: 'taken_over',
          driver: { ...driverIsMe, accountId: 'acc-9', firstName: 'Grace', lastName: 'Hopper' },
        }}
        onTakeControl={vi.fn()} />)

      expect(screen.getByTitle('Browser'))
        .toHaveClass('chat-page__browser-pane-iframe--observing')
      expect(container.querySelector('.chat-page__browser-pane-capture')).toBeInTheDocument()
      expect(screen.queryByText('Take control')).not.toBeInTheDocument()
    })

    // A driver row without takeover_state is stale bookkeeping — takeover_state
    // is the authority on whether anyone actually holds the wheel.
    it('ignores a driver when nobody has taken control', () => {
      const { container } = render(<BrowserPane {...baseProps}
        session={{ ...live, takeoverState: 'none', driver: driverIsMe }}
        onTakeControl={vi.fn()} />)

      expect(screen.getByTitle('Browser'))
        .toHaveClass('chat-page__browser-pane-iframe--observing')
      expect(container.querySelector('.chat-page__browser-pane-capture')).toBeInTheDocument()
    })

    it('offers nothing when the page wires no handlers', () => {
      const { container } = render(<BrowserPane {...baseProps}
        session={{ ...live, takeoverState: 'none', driver: null }} />)
      expect(container.querySelector('.chat-page__browser-pane-capture')).not.toBeInTheDocument()
      expect(container.querySelector('.chat-page__browser-pane-control')).not.toBeInTheDocument()
    })
  })


  // The ask belongs in the conversation, not on the pane. The assistant says
  // what it needs done and where, in its own reply, where the person can read
  // it properly and answer. The pane used to restate it as a status pill in
  // fewer words, which put the product's chrome between the person and what
  // they were actually asked.
  describe('the request for the person to take over', () => {
    const live = { id: 's1', liveViewUrl: 'https://live', ownerAccountId: 'acc-1', takeoverState: 'none' as const, driver: null }

    it('says nothing on the pane, whoever is looking at it', () => {
      const { rerender } = render(<BrowserPane {...baseProps} session={live} onTakeControl={vi.fn()} agentName="Ada" />)
      expect(screen.queryByText(/asked you to take over/)).not.toBeInTheDocument()
      const driverIsMe = {
        accountId: 'acc-2', firstName: 'Me', lastName: 'Here', email: 'me@example.com', avatarUrl: null,
        takenAt: '2026-07-28T00:00:00.000Z', present: true,
      }
      rerender(<BrowserPane {...baseProps}
        session={{ ...live, takeoverState: 'taken_over', driver: driverIsMe }}
        onReleaseControl={vi.fn()} />)
      expect(screen.queryByText(/asked you to take over/)).not.toBeInTheDocument()
    })
  })

  describe('the viewport follows the pane', () => {
    it('reports the live view\'s box once on mount and once per resize the observer sees', () => {
      const observers: Array<{ cb: ResizeObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = []
      class FakeResizeObserver {
        observe = vi.fn()
        disconnect = vi.fn()
        unobserve = vi.fn()
        constructor(cb: ResizeObserverCallback) { observers.push({ cb, observe: this.observe, disconnect: this.disconnect }) }
      }
      vi.stubGlobal('ResizeObserver', FakeResizeObserver)
      const onViewportChange = vi.fn()
      const { container, unmount } = render(<BrowserPane {...baseProps}
        session={{ id: 's1', liveViewUrl: 'https://live', ownerAccountId: 'acc-1' }} onViewportChange={onViewportChange} />)
      const wrap = container.querySelector('.chat-page__browser-pane-iframe-wrap') as HTMLDivElement
      const rect = (width: number, height: number) => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
      // The mount report read a zero box (jsdom lays nothing out) and said nothing.
      expect(onViewportChange).not.toHaveBeenCalled()
      expect(observers).toHaveLength(1)
      expect(observers[0].observe).toHaveBeenCalledWith(wrap)
      vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue(rect(900, 700))
      act(() => { observers[0].cb([], observers[0] as unknown as ResizeObserver) })
      expect(onViewportChange).toHaveBeenCalledTimes(1)
      expect(onViewportChange).toHaveBeenLastCalledWith({ width: 900, height: 700 })
      vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue(rect(1000, 700))
      act(() => { observers[0].cb([], observers[0] as unknown as ResizeObserver) })
      expect(onViewportChange).toHaveBeenLastCalledWith({ width: 1000, height: 700 })
      unmount()
      expect(observers[0].disconnect).toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it('a drag that began on the resizer reports its end once, on the mouseup wherever the pointer is by then', () => {
      const onResizeStart = vi.fn()
      const onResizeEnd = vi.fn()
      const { container } = render(<BrowserPane {...baseProps}
        session={{ id: 's1', liveViewUrl: 'https://live', ownerAccountId: 'acc-1' }}
        onResizeStart={onResizeStart} onResizeEnd={onResizeEnd} />)
      const resizer = container.querySelector('.chat-page__right-pane-resizer') as HTMLDivElement
      fireEvent.mouseDown(resizer)
      expect(onResizeStart).toHaveBeenCalledTimes(1)
      expect(onResizeEnd).not.toHaveBeenCalled()
      // The pointer ends the drag over the page body, not over the resizer.
      fireEvent.mouseUp(document.body)
      expect(onResizeEnd).toHaveBeenCalledTimes(1)
      // A later mouseup outside any drag is not an end.
      fireEvent.mouseUp(document.body)
      expect(onResizeEnd).toHaveBeenCalledTimes(1)
    })
  })

  it('restores last URL when the iframe loads a freshly-created session', () => {
    window.localStorage.setItem('thread-42', 'https://linkedin.com/feed')
    const onRestoreFromLastUrl = vi.fn()
    render(<BrowserPane {...baseProps}
      session={{ id: 's1', liveViewUrl: 'https://live', ownerAccountId: null }}
      wasNewlyCreated lastUrlKey="thread-42" onRestoreFromLastUrl={onRestoreFromLastUrl} />)
    fireEvent.load(screen.getByTitle('Browser'))
    expect(onRestoreFromLastUrl).toHaveBeenCalledWith('s1', 'https://linkedin.com/feed')
  })

  it('does NOT restore when the session was reused (not newly created)', () => {
    window.localStorage.setItem('thread-42', 'https://linkedin.com/feed')
    const onRestoreFromLastUrl = vi.fn()
    render(<BrowserPane {...baseProps}
      session={{ id: 's1', liveViewUrl: 'https://live', ownerAccountId: null }}
      wasNewlyCreated={false} lastUrlKey="thread-42" onRestoreFromLastUrl={onRestoreFromLastUrl} />)
    fireEvent.load(screen.getByTitle('Browser'))
    expect(onRestoreFromLastUrl).not.toHaveBeenCalled()
  })

  // Threads are shared, so more than one person can have the pane open on the
  // same session. The avatar answers "who else is driving this", so it is shown
  // only when the driver is somebody other than the viewer.
  describe('owner avatar', () => {
    const owner = {
      accountId: 'acc-1', firstName: 'Ada', lastName: 'Lovelace',
      email: 'ada@example.com', avatarUrl: null,
    }
    it('shows the owner initials above the live view', () => {
      const { container } = render(<BrowserPane {...baseProps}
        session={{ id: 's1', liveViewUrl: 'https://live', ownerAccountId: 'acc-1', owner }} />)
      const avatar = container.querySelector('.chat-page__browser-pane-owner-avatar')
      expect(avatar).toBeInTheDocument()
      expect(avatar).toHaveTextContent('AL')
    })

    it('names the owner for assistive tech and for the hover tooltip', () => {
      render(<BrowserPane {...baseProps}
        session={{ id: 's1', liveViewUrl: 'https://live', ownerAccountId: 'acc-1', owner }} />)
      expect(screen.getByLabelText('Ada Lovelace')).toBeInTheDocument()
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    })

    it('falls back to the email address when the owner has no name', () => {
      render(<BrowserPane {...baseProps}
        session={{
          id: 's1', liveViewUrl: 'https://live', ownerAccountId: 'acc-1',
          owner: { ...owner, firstName: null, lastName: null },
        }} />)
      expect(screen.getByLabelText('ada@example.com')).toBeInTheDocument()
    })

    it('renders the owner photo when there is one', () => {
      const { container } = render(<BrowserPane {...baseProps}
        session={{
          id: 's1', liveViewUrl: 'https://live', ownerAccountId: 'acc-1',
          owner: { ...owner, avatarUrl: 'https://cdn/ada.png' },
        }} />)
      expect(container.querySelector('.chat-page__browser-pane-owner-avatar.user-avatar--image'))
        .toHaveAttribute('src', 'https://cdn/ada.png')
    })

    it('shows no avatar on a session with no human owner (legacy / web_task)', () => {
      const { container } = render(<BrowserPane {...baseProps}
        session={{ id: 's1', liveViewUrl: 'https://live', ownerAccountId: null, owner: null }} />)
      expect(screen.getByTitle('Browser')).toBeInTheDocument()
      expect(container.querySelector('.chat-page__browser-pane-owner')).not.toBeInTheDocument()
    })

    it('shows the driver rather than the owner once a human takes control', () => {
      render(<BrowserPane {...baseProps}
        session={{
          id: 's1', liveViewUrl: 'https://live', ownerAccountId: 'acc-1', owner,
          takeoverState: 'taken_over',
          driver: {
            accountId: 'acc-3', firstName: 'Grace', lastName: 'Hopper',
            email: 'grace@example.com', avatarUrl: null,
            takenAt: '2026-07-28T00:00:00.000Z', present: true,
          },
        }} />)
      // The label says what they are doing, not just who they are.
      expect(screen.getByLabelText('Grace Hopper')).toBeInTheDocument()
      expect(screen.getByText('Grace Hopper is driving')).toBeInTheDocument()
    })

    it('shows no avatar when there is no session at all', () => {
      const { container } = render(<BrowserPane {...baseProps} session={null} />)
      expect(container.querySelector('.chat-page__browser-pane-owner')).not.toBeInTheDocument()
    })

    // You do not need an avatar telling you that you are yourself.
    it('shows no avatar when the viewer is the one driving', () => {
      const { container } = render(<BrowserPane {...baseProps} viewerAccountId="acc-1"
        session={{ id: 's1', liveViewUrl: 'https://live', ownerAccountId: 'acc-1', owner }} />)
      expect(screen.getByTitle('Browser')).toBeInTheDocument()
      expect(container.querySelector('.chat-page__browser-pane-owner')).not.toBeInTheDocument()
    })

  })
})
