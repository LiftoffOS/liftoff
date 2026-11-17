// The consent page names and marks the tool that is asking from what the
// backend says it is: a slug (from the name the client registered under) and
// a product label. The page used to read the registered name itself and knew
// only Claude Code and Codex, so Gemini CLI, Grok, VS Code, OpenCode and
// Cursor all opened under a plug, and Gemini's header read "Connect Gemini
// CLI MCP Client". A client the backend does not know still opens under the
// plug, named as it registered: that name is the one thing the person can
// judge the request by.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { ConsentView } from './OAuthConsentPage'

vi.mock('../lib/analytics', () => ({ track: vi.fn() }))

vi.mock('../assets/icons/claude.svg?react', () => ({ default: () => <svg data-testid="claude-mark" /> }))
vi.mock('../assets/icons/openai.svg?react', () => ({ default: () => <svg data-testid="openai-mark" /> }))
vi.mock('../assets/icons/opencode.svg?react', () => ({ default: () => <svg data-testid="opencode-mark" /> }))
vi.mock('../assets/icons/gemini.svg?react', () => ({ default: () => <svg data-testid="gemini-mark" /> }))
vi.mock('../assets/icons/grok.svg?react', () => ({ default: () => <svg data-testid="grok-mark" /> }))
vi.mock('../assets/icons/vscode.svg?react', () => ({ default: () => <svg data-testid="vscode-mark" /> }))
vi.mock('../assets/icons/cursor.svg?react', () => ({ default: () => <svg data-testid="cursor-mark" /> }))
vi.mock('../assets/icons/plug.svg?react', () => ({ default: () => <svg data-testid="plug-mark" /> }))

const workspaces = [{ id: 't1', name: 'Northwind Labs', role: 'owner', setupRequired: false }]

function renderReady(props: { clientName?: string; clientSlug?: string | null; clientLabel?: string }) {
  return render(
    <MemoryRouter>
      <ConsentView
        pageState="ready"
        redirectHost="localhost"
        workspaces={workspaces}
        selectedTenantId="t1"
        error={null}
        onSelect={() => {}}
        onDecide={() => {}}
        {...props}
      />
    </MemoryRouter>,
  )
}

describe('OAuth consent page client identity', () => {
  it.each([
    ['Gemini CLI MCP Client', 'gemini-cli', 'Gemini CLI', 'gemini-mark'],
    ['Codex', 'codex', 'Codex', 'openai-mark'],
    ['OpenCode', 'opencode', 'OpenCode', 'opencode-mark'],
    ['Grok', 'grok', 'Grok', 'grok-mark'],
    ['Visual Studio Code', 'vscode', 'VS Code', 'vscode-mark'],
    ['Cursor', 'cursor', 'Cursor', 'cursor-mark'],
    ['Claude Code', 'claude-code', 'Claude Code', 'claude-mark'],
  ])('%s opens under its own mark, named by its product label', (clientName, clientSlug, clientLabel, testId) => {
    renderReady({ clientName, clientSlug, clientLabel })

    expect(screen.getByTestId(testId)).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(`Connect ${clientLabel}`)
    expect(screen.getByText(new RegExp(`^${clientLabel} wants to connect`))).toBeInTheDocument()
  })

  it('an unknown client opens under the generic mark, named as it registered', () => {
    renderReady({ clientName: 'Muse personal agent', clientSlug: null, clientLabel: 'Muse personal agent' })

    expect(screen.getByTestId('plug-mark')).toBeInTheDocument()
    expect(screen.queryByTestId('claude-mark')).toBeNull()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Connect Muse personal agent')
  })

  it('a platform-backend that predates the slug still tells Claude Code and Codex apart by name', () => {
    const { unmount } = renderReady({ clientName: 'Claude Code' })
    expect(screen.getByTestId('claude-mark')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Connect Claude Code')
    unmount()

    renderReady({ clientName: 'Codex' })
    expect(screen.getByTestId('openai-mark')).toBeInTheDocument()
  })
})
