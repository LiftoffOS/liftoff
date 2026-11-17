// The pane opens when the agent starts driving the browser.
//
// This list is a hand-maintained mirror of the tenant runtime's browser tools
// and there is no import across the repo boundary to keep it honest, so the
// whole set is stated here explicitly. A tool added there and forgotten here
// does not fail visibly: the pane opens 90 seconds late, or not at all, while
// the agent reports that it navigated. That is exactly how
// navigate_browser_session went missing.

import { describe, it, expect } from 'vitest'
import { BROWSER_DRIVING_TOOLS, NON_PANE_BROWSER_TOOLS, isBrowserDrivingTool } from './browserDrivingTools'

describe('BROWSER_DRIVING_TOOLS', () => {
  it('covers every tool that puts a browser on the screen', () => {
    expect([...BROWSER_DRIVING_TOOLS].sort()).toEqual([
      'navigate_browser_session',
      'read_active_browser_session',
      'run_browser_task',
      'save_active_browser_page_as_pdf',
      'screenshot_browser_session',
      'start_browser_session',
      'web_task',
    ])
  })

  it('includes the tools that only READ the live session', () => {
    // These do not navigate, so it is tempting to leave them out. They still
    // belong: each one only makes sense when a session is already running, and
    // that session is the thing the pane shows. Leaving them out means an agent
    // that opens a page on one turn and is asked about it on the next shows
    // nothing the second time.
    expect(BROWSER_DRIVING_TOOLS).toContain('read_active_browser_session')
    expect(BROWSER_DRIVING_TOOLS).toContain('screenshot_browser_session')
    expect(BROWSER_DRIVING_TOOLS).toContain('save_active_browser_page_as_pdf')
  })

  it('excludes the browser-adjacent tools that should not open the pane', () => {
    // The other half of the ratchet. Stating only what IS in the list lets it
    // grow by accident: every runtime tool with "browser" in its name looks
    // like a candidate, and two of them would put an empty or irrelevant panel
    // in front of the person. Moving one of these into the driving list has to
    // fail here first, so the reasoning in the source gets revisited.
    for (const tool of NON_PANE_BROWSER_TOOLS) {
      expect(BROWSER_DRIVING_TOOLS).not.toContain(tool)
      expect(isBrowserDrivingTool(tool)).toBe(false)
      expect(isBrowserDrivingTool(`mcp__liftoff-tool-gateway__${tool}`)).toBe(false)
    }
  })

  it('includes the two session tools that open the pane', () => {
    // The regression. An agent asked to "navigate to <url>" calls
    // navigate_browser_session, which was absent, so the eager open never
    // fired and the person had to click the browser button themselves.
    expect(BROWSER_DRIVING_TOOLS).toContain('navigate_browser_session')
    expect(BROWSER_DRIVING_TOOLS).toContain('start_browser_session')
  })
})

describe('isBrowserDrivingTool', () => {
  it('matches the bare name', () => {
    expect(isBrowserDrivingTool('navigate_browser_session')).toBe(true)
    expect(isBrowserDrivingTool('run_browser_task')).toBe(true)
  })

  it('matches the MCP-prefixed name the SDK actually reports', () => {
    // This is the wire value on the engine that serves almost all traffic.
    expect(isBrowserDrivingTool('mcp__liftoff-tool-gateway__navigate_browser_session')).toBe(true)
    expect(isBrowserDrivingTool('mcp__liftoff-tools-abc123__run_browser_task')).toBe(true)
  })

  it('does not match a tool that leaves the pane blank', () => {
    // web_fetch_advanced is what an agent reaches for INSTEAD of the browser.
    // Opening the pane for it would show an empty panel.
    expect(isBrowserDrivingTool('web_fetch_advanced')).toBe(false)
    expect(isBrowserDrivingTool('mcp__liftoff-tool-gateway__web_fetch_advanced')).toBe(false)
    expect(isBrowserDrivingTool('web_research')).toBe(false)
  })

  it('does not match on a partial suffix', () => {
    // `__` is required, so a vendor tool merely ENDING in a browser tool's
    // name does not open the pane.
    expect(isBrowserDrivingTool('my_run_browser_task')).toBe(false)
  })
})
