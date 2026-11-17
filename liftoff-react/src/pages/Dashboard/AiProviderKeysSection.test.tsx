// The AI provider keys card: collapsed row, the four fields Manage reveals,
// and what a reopened card is allowed to show.
//
// The last ones are the reason this file exists. "Readable while you paste it,
// redacted once it is stored" is a claim about a round trip, and the only way
// to be sure of it is to save through the real service and read the card back
// afterwards, which is what these do against the shared MSW server.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/mocks/server'
import AiProviderKeysSection from './AiProviderKeysSection'

const showToast = vi.fn()
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast }),
}))

const track = vi.fn()
vi.mock('../../lib/analytics', () => ({
  track: (...args: unknown[]) => track(...args),
}))

const ANTHROPIC_KEY = 'sk-ant-api03-not-a-real-key-3f2x'

function renderSection(tenantId = 'tenant-card-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AiProviderKeysSection tenantId={tenantId} />
    </QueryClientProvider>,
  )
}

const providerField = (label: string) => screen.getByLabelText(label) as HTMLInputElement

describe('AiProviderKeysSection', () => {
  beforeEach(() => {
    showToast.mockClear()
    track.mockClear()
  })

  it('shows the collapsed row with a Manage button', async () => {
    renderSection()
    expect(screen.getByRole('heading', { name: 'AI Provider Keys' })).toBeInTheDocument()
    expect(screen.getByText('Add your API keys from your existing AI providers for your agents to use')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Anthropic')).not.toBeInTheDocument()

    // Nothing is claimed about the workspace until the read lands.
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(await screen.findByText('None added')).toBeInTheDocument()
  })

  it('counts the stored keys in the collapsed row', async () => {
    const user = userEvent.setup()
    renderSection('tenant-card-count')
    expect(await screen.findByText('None added')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Manage' }))
    await user.type(providerField('Anthropic'), ANTHROPIC_KEY)
    await user.type(providerField('OpenAI'), 'sk-proj-not-a-real-key-9qLm')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // No denominator: four keys is not a target to complete.
    expect(await screen.findByText('2 added')).toBeInTheDocument()
    expect(screen.queryByText(/of 4/)).not.toBeInTheDocument()

    // The count is about what is STORED, so the row must not imply a working
    // connection.
    expect(screen.queryByText(/connected/i)).not.toBeInTheDocument()
  })

  it('expands to one field per provider, plus Cancel and Save', async () => {
    const user = userEvent.setup()
    renderSection('tenant-card-expand')
    await user.click(screen.getByRole('button', { name: 'Manage' }))

    for (const label of ['Anthropic', 'Google Gemini', 'OpenAI', 'Grok']) {
      const field = providerField(label)
      expect(field).toBeInTheDocument()
      // Readable while it is being pasted, so a truncated paste is visible
      // before it is saved. Every row is the same control: four fields that
      // look alike, differing only in what the placeholder asks for.
      expect(field.type).toBe('text')
      expect(field.value).toBe('')
    }
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('cannot save until something is typed', async () => {
    const user = userEvent.setup()
    renderSection('tenant-card-empty-save')
    await user.click(screen.getByRole('button', { name: 'Manage' }))

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.type(providerField('Anthropic'), ANTHROPIC_KEY)
    // The pasted key stays on screen; only a saved one is ever redacted.
    expect(providerField('Anthropic').value).toBe(ANTHROPIC_KEY)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
  })

  it('saves, confirms, and collapses', async () => {
    const user = userEvent.setup()
    renderSection('tenant-card-save')
    await user.click(screen.getByRole('button', { name: 'Manage' }))
    await user.type(providerField('Anthropic'), ANTHROPIC_KEY)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('AI provider keys updated', 'success'),
    )
    expect(track).toHaveBeenCalledWith('settings_workspace_ai_keys_saved', {
      tenant_id: 'tenant-card-save',
      providers: ['anthropic'],
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument())
  })

  it('shows the saved key redacted when the card is opened again', async () => {
    const user = userEvent.setup()
    renderSection('tenant-card-reopen')

    await user.click(screen.getByRole('button', { name: 'Manage' }))
    await user.type(providerField('Anthropic'), ANTHROPIC_KEY)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Manage' }))
    const anthropic = await waitFor(() => {
      const field = providerField('Anthropic')
      expect(field.value).toContain('•')
      return field
    })

    // The stored key is visible as a partial redaction: enough to recognise,
    // not enough to use, and the interior never arrived in the browser at all.
    expect(anthropic.value).toBe('sk-ant••••••••3f2x')
    expect(anthropic.value).not.toBe(ANTHROPIC_KEY)
    expect(document.body.textContent).not.toContain('api03')
    expect(document.body.textContent).not.toContain('not-a-real-key')

    // A field still showing its redaction is untouched, so reopening and
    // saving cannot write the mask back over the real key.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    // Providers with nothing stored are empty and prompt for a key rather than
    // implying one is there.
    expect(providerField('OpenAI').value).toBe('')
    expect(providerField('OpenAI').placeholder).toBe('Paste your OpenAI API key')
  })

  it('clears the redaction to take a replacement, and restores it if none is typed', async () => {
    const user = userEvent.setup()
    renderSection('tenant-card-replace')

    await user.click(screen.getByRole('button', { name: 'Manage' }))
    await user.type(providerField('Anthropic'), ANTHROPIC_KEY)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Manage' }))
    await waitFor(() => expect(providerField('Anthropic').value).toBe('sk-ant••••••••3f2x'))

    // Focusing empties the field so a new key is pasted in clean rather than
    // appended to the mask.
    await user.click(providerField('Anthropic'))
    expect(providerField('Anthropic').value).toBe('')
    expect(providerField('Anthropic').placeholder).toBe('Paste a new key to replace the saved one')

    // Clicking away without typing is not an edit, so the stored key comes back.
    await user.click(providerField('Google Gemini'))
    expect(providerField('Anthropic').value).toBe('sk-ant••••••••3f2x')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    // Typing a replacement does make it an edit.
    await user.type(providerField('Anthropic'), 'sk-ant-api03-replacement-8kQz')
    expect(providerField('Anthropic').value).toBe('sk-ant-api03-replacement-8kQz')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Manage' }))
    await waitFor(() => expect(providerField('Anthropic').value).toBe('sk-ant••••••••8kQz'))
  })

  // A key that was fine at save and has since been revoked at the provider.
  // The agents routed there are already failing, so the card has to say so
  // rather than keep reporting a reassuring count.
  it('flags a stored key the provider has stopped accepting', async () => {
    const user = userEvent.setup()
    renderSection('tenant-card-revoked')

    await user.click(screen.getByRole('button', { name: 'Manage' }))
    await user.type(providerField('Anthropic'), 'sk-ant-revoked-demo-key')
    await user.type(providerField('Google Gemini'), 'AIzaSy-working-demo-key')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // Collapsed: the count alone would be misleading, so the problem rides
    // alongside it in the same StatusBadge pill the teams table uses. The pill
    // says what is wrong, because next to a count a bare "Error" is unreadable
    // without a hover, and the noun is what makes the count grammatical.
    expect(await screen.findByText('2 added')).toBeInTheDocument()
    expect(screen.getByText('Needs attention')).toHaveClass('status-badge--error')

    // The pill carries no count; the tooltip names which provider, which is
    // what makes it actionable.
    await user.hover(screen.getByText('Needs attention'))
    expect(
      await screen.findByText('Anthropic is no longer accepting its key'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Manage' }))

    const anthropic = await screen.findByLabelText('Anthropic')
    // A fragment on the label line, not a paragraph under the input: the
    // provider is named by the label beside it and the remedy is the
    // placeholder the field shows once it is focused.
    const problem = screen.getByRole('alert')
    expect(problem).toHaveTextContent('Key declined')
    expect(anthropic).toHaveAttribute('aria-invalid', 'true')
    expect(anthropic).toHaveAttribute('aria-describedby', problem.id)
    expect(anthropic).toHaveClass('settings-form__input--error')

    // Only the dead key is flagged.
    expect(screen.getByLabelText('Google Gemini')).not.toHaveAttribute('aria-invalid')
    expect(screen.getAllByRole('alert')).toHaveLength(1)

    // Typing the replacement clears the complaint rather than nagging through
    // the fix.
    await user.click(anthropic)
    await user.type(anthropic, 'sk-ant-api03-fresh-key-4mNp')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('2 added')).toBeInTheDocument()
    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument()
  })

  it('names every dead provider without counting them in the pill', async () => {
    const user = userEvent.setup()
    renderSection('tenant-card-revoked-many')

    await user.click(screen.getByRole('button', { name: 'Manage' }))
    await user.type(providerField('Anthropic'), 'sk-ant-revoked-demo-key')
    await user.type(providerField('OpenAI'), 'sk-proj-revoked-demo-key')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // One pill regardless of how many keys died: a count needs a noun to read
    // grammatically, and the tooltip carries the detail instead.
    expect(await screen.findByText('Needs attention')).toBeInTheDocument()
    await user.hover(screen.getByText('Needs attention'))
    expect(
      await screen.findByText('Anthropic and OpenAI are no longer accepting their keys'),
    ).toBeInTheDocument()
  })

  // The clear button. Removal is the only destructive thing this card does, so
  // what arms it and what does NOT arm it both matter.
  describe('the clear button', () => {
    const clearFor = (label: string) =>
      screen.getByRole('button', { name: new RegExp(`(Clear the|Remove the saved) ${label}`) })

    it('is absent while there is nothing to clear', async () => {
      const user = userEvent.setup()
      renderSection('tenant-clear-empty')
      await user.click(screen.getByRole('button', { name: 'Manage' }))

      expect(screen.queryByRole('button', { name: /Clear the Anthropic/ })).not.toBeInTheDocument()
    })

    it('discards typed text without touching the stored key', async () => {
      const user = userEvent.setup()
      renderSection('tenant-clear-typed')

      await user.click(screen.getByRole('button', { name: 'Manage' }))
      await user.type(providerField('Anthropic'), ANTHROPIC_KEY)
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument())

      await user.click(screen.getByRole('button', { name: 'Manage' }))
      await waitFor(() => expect(providerField('Anthropic').value).toBe('sk-ant••••••••3f2x'))

      // Type a replacement, then think better of it.
      await user.click(providerField('Anthropic'))
      await user.type(providerField('Anthropic'), 'sk-ant-api03-half-typed')
      await user.click(clearFor('Anthropic'))

      // Back to the stored key, not to nothing, and nothing to save.
      expect(providerField('Anthropic').value).toBe('sk-ant••••••••3f2x')
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    })

    it('marks a stored key for removal and arms Save', async () => {
      const user = userEvent.setup()
      renderSection('tenant-clear-remove')

      await user.click(screen.getByRole('button', { name: 'Manage' }))
      await user.type(providerField('Anthropic'), ANTHROPIC_KEY)
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument())

      await user.click(screen.getByRole('button', { name: 'Manage' }))
      await waitFor(() => expect(providerField('Anthropic').value).toBe('sk-ant••••••••3f2x'))

      await user.click(clearFor('Anthropic'))

      // The redaction is withheld, the field says what will happen, and this
      // is the case the whole change exists for: Save is now enabled.
      expect(providerField('Anthropic').value).toBe('')
      expect(providerField('Anthropic').placeholder).toBe('Removed when you save')
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    })

    it('actually removes the key when saved', async () => {
      const user = userEvent.setup()
      renderSection('tenant-clear-commit')

      await user.click(screen.getByRole('button', { name: 'Manage' }))
      await user.type(providerField('Anthropic'), ANTHROPIC_KEY)
      await user.type(providerField('OpenAI'), 'sk-proj-not-a-real-key-9qLm')
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(screen.findByText('2 added')).toBeTruthy())

      await user.click(screen.getByRole('button', { name: 'Manage' }))
      await waitFor(() => expect(providerField('Anthropic').value).toBe('sk-ant••••••••3f2x'))
      await user.click(clearFor('Anthropic'))
      await user.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith('AI provider key removed', 'success'),
      )
      // Gone for good, and the other provider is untouched.
      expect(await screen.findByText('1 added')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Manage' }))
      await waitFor(() => expect(providerField('OpenAI').value).toBe('sk-pro••••••••9qLm'))
      expect(providerField('Anthropic').value).toBe('')
      expect(providerField('Anthropic').placeholder).toBe('Paste your Anthropic API key')
    })

    it('sends null, not an empty string', async () => {
      // The endpoint reads '' as "untouched" on purpose, so a removal that went
      // out as '' would silently do nothing.
      const user = userEvent.setup()
      renderSection('tenant-clear-payload')

      await user.click(screen.getByRole('button', { name: 'Manage' }))
      await user.type(providerField('Anthropic'), ANTHROPIC_KEY)
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument())

      let sent: unknown = null
      server.use(
        http.put('*/api/tenants/:tenantId/ai-provider-keys', async ({ request }) => {
          sent = await request.json()
          return HttpResponse.json({ keys: [] })
        }),
      )

      await user.click(screen.getByRole('button', { name: 'Manage' }))
      await waitFor(() => expect(providerField('Anthropic').value).toBe('sk-ant••••••••3f2x'))
      await user.click(clearFor('Anthropic'))
      await user.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(sent).toEqual({ keys: { anthropic: null } }))
    })

    it('typing a replacement cancels a pending removal', async () => {
      const user = userEvent.setup()
      renderSection('tenant-clear-undo')

      await user.click(screen.getByRole('button', { name: 'Manage' }))
      await user.type(providerField('Anthropic'), ANTHROPIC_KEY)
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument())

      await user.click(screen.getByRole('button', { name: 'Manage' }))
      await waitFor(() => expect(providerField('Anthropic').value).toBe('sk-ant••••••••3f2x'))
      await user.click(clearFor('Anthropic'))
      await user.type(providerField('Anthropic'), 'sk-ant-api03-fresh-key-4mNp')
      await user.click(screen.getByRole('button', { name: 'Save' }))

      // A replacement, not a removal: the key is still there afterwards.
      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith('AI provider keys updated', 'success'),
      )
      expect(await screen.findByText('1 added')).toBeInTheDocument()
    })

    it('forgets a pending removal on Cancel', async () => {
      const user = userEvent.setup()
      renderSection('tenant-clear-cancel')

      await user.click(screen.getByRole('button', { name: 'Manage' }))
      await user.type(providerField('Anthropic'), ANTHROPIC_KEY)
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument())

      await user.click(screen.getByRole('button', { name: 'Manage' }))
      await waitFor(() => expect(providerField('Anthropic').value).toBe('sk-ant••••••••3f2x'))
      await user.click(clearFor('Anthropic'))
      await user.click(screen.getByRole('button', { name: 'Cancel' }))

      await user.click(screen.getByRole('button', { name: 'Manage' }))
      expect(providerField('Anthropic').value).toBe('sk-ant••••••••3f2x')
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    })
  })

  it('drops a typed key and collapses on Cancel', async () => {
    const user = userEvent.setup()
    renderSection('tenant-card-cancel')
    await user.click(screen.getByRole('button', { name: 'Manage' }))
    await user.type(providerField('Google Gemini'), 'google-key-bbbb')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await user.click(screen.getByRole('button', { name: 'Manage' }))
    expect(providerField('Google Gemini').value).toBe('')
    expect(providerField('Google Gemini').placeholder)
      .toBe('Paste your Vertex AI service account JSON')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('asks Google for a service account, and everyone else for an API key', async () => {
    // Google is the one provider whose credential is not an API key: a
    // customer's Google AI capacity lives in their own Vertex AI project, and
    // what the backend needs is the service account JSON they download from
    // Google Cloud. A field that said "API key" would have every Google
    // customer paste one and get an error they cannot act on.
    const user = userEvent.setup()
    renderSection('tenant-card-placeholders')
    await user.click(screen.getByRole('button', { name: 'Manage' }))

    // The same sentence four times, with only the noun changing. Google's
    // credential is a file rather than a key, and that is the whole of what
    // its field does differently.
    expect(providerField('Google Gemini').placeholder)
      .toBe('Paste your Vertex AI service account JSON')
    expect(providerField('Anthropic').placeholder).toBe('Paste your Anthropic API key')
    expect(providerField('OpenAI').placeholder).toBe('Paste your OpenAI API key')
    // Labelled Grok, and it takes a bare key like the other two.
    expect(providerField('Grok').placeholder).toBe('Paste your Grok API key')
  })

  it('hangs Google\'s hint off its label as a tooltip, and gives the others none', async () => {
    // `location` is NOT in the downloaded service account file, and the
    // platform reads `global` unless told otherwise. A customer who needs a
    // different region has no way to guess that from a field that only says
    // "service account JSON", and finds out by having a save rejected.
    const user = userEvent.setup()
    const { container } = renderSection('tenant-card-google-hint')
    await user.click(screen.getByRole('button', { name: 'Manage' }))

    // The sentence is the field's own description, not decoration: it reaches
    // a screen reader with the label whether or not anything is hovered.
    const hint = document.getElementById('ai-provider-key-google-hint')
    expect(hint?.textContent).toContain('Service Accounts')
    // `location` is NOT in the downloaded file, so the region is stated rather
    // than discovered by having a save rejected.
    expect(hint?.textContent).toContain('global')
    expect(providerField('Google Gemini').getAttribute('aria-describedby'))
      .toContain('ai-provider-key-google-hint')

    // One row carries the icon, not four: the other three take a bare key and
    // need no gloss.
    const triggers = container.querySelectorAll('.settings-form__label-info')
    expect(triggers).toHaveLength(1)
    // Beside the label, so it reads as a note about Google Gemini rather than
    // about the card.
    expect(triggers[0].closest('.settings-form__label-group')?.textContent)
      .toContain('Google Gemini')

    // And hovering it is what puts the sentence on screen.
    const tooltip = document.querySelector('.tooltip-portal')
    expect(tooltip).not.toHaveClass('tooltip-portal--visible')
    await user.hover(triggers[0])
    expect(tooltip).toHaveClass('tooltip-portal--visible')
    expect(tooltip?.textContent).toContain('From Google Cloud')
  })
})
