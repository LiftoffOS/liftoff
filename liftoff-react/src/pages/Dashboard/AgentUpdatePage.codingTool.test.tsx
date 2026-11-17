// The update page for a coding-tool connection: the same shell as the other
// two forms, with the name and description a person can write. The page used
// to show three disabled fields with no Save, and for an MCP row it errored,
// because it fetched a proxy credential by an id that is not one.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { CodingToolForm } from './AgentUpdatePage'
import type { WorkforceClaudeCodeKey } from '../../hooks/useWorkforce'

const mockUpdate = vi.fn()
vi.mock('../../hooks/useClaudeCodeProxy', () => ({
  useUpdateCodingToolConnection: () => ({ mutateAsync: mockUpdate, isPending: false }),
}))
const mockShowToast = vi.fn()
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ showToast: mockShowToast }) }))
vi.mock('../../components/PermissionGate', () => ({
  PermissionGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))
// The rest of AgentUpdatePage's imports pull in hooks the form never calls;
// keep the module graph from reaching Firebase.
vi.mock('../../hooks/useInternalAgents', () => ({}))
vi.mock('../../hooks/useExternalAgents', () => ({}))
vi.mock('../../hooks/useWorkforce', () => ({}))
vi.mock('../../hooks/useKnowledge', () => ({}))

const connection: WorkforceClaudeCodeKey = {
  id: 'conn-1',
  tenantId: 't1',
  accountId: 'a1',
  keyPrefix: 'liftoff_sk_abcd1234',
  keyHint: 'wxyz',
  name: 'Alex Rivera (Codex)',
  description: 'AI Coding Tool for Alex',
  planType: null,
  costPerMonth: null,
  status: 'active',
  lastUsedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  keyType: 'developer_proxy',
  vendor: 'openai',
}

function renderForm(onSave = vi.fn(), onCancel = vi.fn()) {
  render(
    <MemoryRouter>
      <CodingToolForm connection={connection} onSave={onSave} onCancel={onCancel} />
    </MemoryRouter>,
  )
  return { onSave, onCancel }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUpdate.mockResolvedValue({ id: 'conn-1', name: 'x', description: 'y' })
})

describe('CodingToolForm', () => {
  it('shows the name and description, and nothing about the key or the status', () => {
    renderForm()
    expect(screen.getByDisplayValue('Alex Rivera (Codex)')).toBeInTheDocument()
    expect(screen.getByDisplayValue('AI Coding Tool for Alex')).toBeInTheDocument()
    expect(screen.queryByText('Key prefix')).toBeNull()
    expect(screen.queryByText('Status')).toBeNull()
    expect(screen.queryByDisplayValue('liftoff_sk_abcd1234')).toBeNull()
  })

  it('keeps Save disabled until something changes, and while the name is blank', () => {
    renderForm()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()

    const name = screen.getByDisplayValue('Alex Rivera (Codex)')
    fireEvent.change(name, { target: { value: 'Release reviewer' } })
    expect(save).toBeEnabled()

    fireEvent.change(name, { target: { value: '   ' } })
    expect(save).toBeDisabled()
  })

  it('writes the trimmed name and description and hands back to the route on success', async () => {
    const { onSave } = renderForm()
    fireEvent.change(screen.getByDisplayValue('Alex Rivera (Codex)'), { target: { value: '  Release reviewer  ' } })
    fireEvent.change(screen.getByDisplayValue('AI Coding Tool for Alex'), { target: { value: 'Reviews every release branch' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(mockUpdate).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      name: 'Release reviewer',
      description: 'Reviews every release branch',
    })
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('reports a failed save and stays on the page', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('boom'))
    const { onSave } = renderForm()
    fireEvent.change(screen.getByDisplayValue('Alex Rivera (Codex)'), { target: { value: 'Release reviewer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Failed to save changes', 'error'))
    expect(onSave).not.toHaveBeenCalled()
  })
})
