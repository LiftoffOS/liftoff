// The "AI Provider Keys" card on Settings → Workspace, directly below
// Workspace AI. Workspace AI chooses the provider; this chooses whose account
// the calls are billed to.
//
// It follows AuditLogsSection's expand-in-place shape rather than a modal, and
// WorkspaceAiSection's Cancel/Save pair. Styling comes from SettingsPage.css,
// which the page already imports; the component lives in its own file only so
// it can be rendered in a test without dragging the whole 2,700-line settings
// page (and Firebase, Stripe, and billing with it) into the suite.
//
// Redaction applies to what is read back, never to what is being typed. A key
// being pasted is plain text, because a field nobody can read is a field nobody
// can check for a truncated paste before saving it. Only once a key is stored
// does the field show it redacted, and by then the browser genuinely does not
// have the secret: a read returns the partial form and nothing else.
//
// A field still showing a stored key's redaction is untouched, so it submits
// nothing and the stored key survives. Focusing one clears the redaction so a
// replacement can be pasted into an empty field; leaving without typing puts it
// back, so a stray click never looks like it deleted the key.
//
// Removing a key is therefore its own gesture rather than "empty the field and
// save": emptying is what focusing already does, and it has to keep meaning
// "changed my mind". The clear button is that gesture. It marks the provider
// for removal, which arms Save, and the save sends an explicit null. Typing
// into a field marked for removal cancels the removal, because pasting a
// replacement is plainly not a request to end up with nothing.
//
// Switching workspace has to collapse the card and drop anything typed, or a
// half-pasted secret would be saved against whichever tenant is current when
// Save is next clicked. SettingsPage keys this component on the tenant id, so
// that reset is a remount rather than an effect racing the new tenant's read.

import { useState } from 'react'
import { Button, StatusBadge, Tooltip } from '../../components'
import XIcon from '../../assets/icons/x.svg?react'
import { useToast } from '../../contexts/ToastContext'
import { track } from '../../lib/analytics'
import { useAiProviderKeys, useUpdateAiProviderKeys } from '../../hooks/useAiProviderKeys'
import {
  AI_PROVIDER_KEY_VENDORS,
  type AiProviderKey,
  type AiProviderKeyUpdate,
  type AiProviderKeyVendor,
} from '../../services/aiProviderKeys'

// null means the field has not been touched: it shows whatever redaction the
// server holds for that provider and submits nothing. A string, empty included,
// means the user is editing it.
type Draft = Record<AiProviderKeyVendor, string | null>

const EMPTY_DRAFT: Draft = { anthropic: null, google: null, openai: null, xai: null }

/** Providers the user has cleared, pending Save. Kept beside the draft rather
 *  than inside it because "" already means "editing, currently empty", which is
 *  the state a focus produces and must stay non-destructive. */
type Removals = Partial<Record<AiProviderKeyVendor, true>>

// Written once and used twice, by the tooltip a mouse can reach and by the
// off-screen copy the field points at, so the two can never say different
// things about where the credential comes from.
const GOOGLE_KEY_HINT =
  'From Google Cloud: IAM & Admin, Service Accounts, Keys. Runs in the global region.'

interface AiProviderKeysSectionProps {
  tenantId: string | undefined
}

export default function AiProviderKeysSection({ tenantId }: AiProviderKeysSectionProps) {
  const { showToast } = useToast()
  const [isExpanded, setIsExpanded] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [removals, setRemovals] = useState<Removals>({})
  const { data: keys, isLoading } = useAiProviderKeys(tenantId)
  const { mutateAsync: doUpdateKeys, isPending } = useUpdateAiProviderKeys()

  const keyFor = (vendor: AiProviderKeyVendor): AiProviderKey | undefined =>
    keys?.find(key => key.vendor === vendor)

  // What the collapsed row reports. The count is of keys that are STORED, not
  // keys that work, which is why the word is "added": a key is verified on the
  // way in, but one that was fine last week can be revoked at the provider at
  // any time without telling us.
  //
  // No denominator. "2 of 4" invites reading four keys as a target to complete,
  // when most workspaces will only ever add the one provider they buy from.
  //
  // '—' covers both the in-flight read and a failed one, mirroring
  // WorkspaceAiSection. "None added" for an unread card would be a statement
  // about the workspace we have not earned.
  const storedCount = keys?.filter(key => key.hint).length ?? 0
  const storedSummary = !keys
    ? '—'
    : storedCount === 0
      ? 'None added'
      : `${storedCount} added`

  // A dead key is worse than no key: the agents routed to that provider are
  // failing while the count still reads reassuringly. The collapsed row is
  // where someone who is not already looking for the problem will see it, so it
  // takes the same StatusBadge pill every status column in the dashboard uses.
  //
  // The pill says what is wrong rather than just "Error", which next to a count
  // is unreadable without hovering. It carries no count of its own: a count
  // needs a noun to be grammatical ("2 need attention" reads as a typo), and
  // the noun is not worth the width when the tooltip names the providers and
  // the expanded card shows exactly which fields are affected.
  const revoked = keys?.filter(key => key.hint && key.status === 'revoked') ?? []
  const revokedLabels = AI_PROVIDER_KEY_VENDORS
    .filter(({ value }) => revoked.some(key => key.vendor === value))
    .map(({ label }) => label)
  const revokedTooltip =
    revokedLabels.length === 0
      ? null
      : revokedLabels.length === 1
        ? `${revokedLabels[0]} is no longer accepting its key`
        : `${revokedLabels.slice(0, -1).join(', ')} and ${revokedLabels[revokedLabels.length - 1]} are no longer accepting their keys`

  // Per-field problem note. Today the only source is a key the provider has
  // stopped accepting; a save rejected by the provider fills the same slot.
  //
  // It rides on the label line, so it is a fragment rather than a sentence: the
  // provider is named by the label beside it, and the remedy is the placeholder
  // the field shows the moment it is focused. Spelling both out again would not
  // fit the line and would push every field below it down the card.
  //
  // "Key declined" states only what we know, and borrows the word people
  // already know from a declined card. "Expired" or "Revoked" would name
  // a cause the 401 does not give us, and "Invalid" would suggest the key was
  // typed wrong when it worked fine until the provider stopped honouring it.
  const problemFor = (vendor: AiProviderKeyVendor): string | null => {
    const key = keyFor(vendor)
    if (!key?.hint || key.status !== 'revoked') return null
    return 'Key declined'
  }

  // Only fields the user typed into, plus the ones they cleared, are sent.
  // Everything else is omitted, which the endpoint reads as "leave the stored
  // key alone". A field still displaying its redaction is therefore
  // unsubmittable by construction, rather than relying on the mask being
  // filtered out further down.
  //
  // A typed value wins over a removal for the same provider: typing is how you
  // cancel a clear, so the two can never both apply.
  const pending: AiProviderKeyUpdate = {}
  for (const { value } of AI_PROVIDER_KEY_VENDORS) {
    const typed = draft[value]?.trim()
    if (typed) pending[value] = typed
    else if (removals[value]) pending[value] = null
  }
  const pendingVendors = Object.keys(pending) as AiProviderKeyVendor[]
  const removedVendors = pendingVendors.filter(v => pending[v] === null)
  const canSave = !!tenantId && pendingVendors.length > 0 && !isPending && !isLoading

  const close = () => {
    setDraft(EMPTY_DRAFT)
    setRemovals({})
    setIsExpanded(false)
  }

  // The clear button. What it means depends on what the field is showing, and
  // both readings are "empty this":
  //   typing      discard the draft, so a field over a stored key falls back to
  //               that key's redaction rather than to nothing
  //   a stored key mark it for removal, which arms Save
  // A field already marked for removal has nothing left to clear, so the button
  // is not rendered there.
  const handleClear = (vendor: AiProviderKeyVendor, hasStoredKey: boolean) => {
    const isTyping = draft[vendor] !== null
    setDraft(prev => ({ ...prev, [vendor]: null }))
    if (!isTyping && hasStoredKey) {
      setRemovals(prev => ({ ...prev, [vendor]: true }))
    }
  }

  const handleSave = async () => {
    if (!tenantId || !canSave) return
    try {
      await doUpdateKeys({ tenantId, keys: pending })
      track('settings_workspace_ai_keys_saved', {
        tenant_id: tenantId,
        providers: pendingVendors,
      })
      showToast(
        removedVendors.length > 0 && removedVendors.length === pendingVendors.length
          ? removedVendors.length === 1 ? 'AI provider key removed' : 'AI provider keys removed'
          : 'AI provider keys updated',
        'success',
      )
      close()
    } catch {
      showToast('Could not update AI provider keys. Please try again.', 'error')
    }
  }

  return (
    <section className="settings-section">
      {isExpanded ? (
        <div className="settings-section__edit-block" id="ai-provider-keys-form">
          <div className="settings-section__header">
            <h2 className="settings-section__title">AI Provider Keys</h2>
            <p className="settings-section__helper">
              Add your API keys from your existing AI providers for your agents to use
            </p>
            {/* Two things nobody would guess from the field labels, and both cost
                money when they surprise someone.

                The first is that funding follows the ROUTE, not the name of the
                provider you picked in Workspace AI. Liftoff Managed routes to
                Anthropic today, so a workspace on Liftoff Managed holding an
                Anthropic key has that key paying for its work. "Managed" reads
                like the opposite, which is exactly why it is written down.

                The second is what happens when a key stops working. The team
                keeps running on Liftoff rather than failing mid-task, and that
                usage is charged the ordinary way. Losing a running team's work
                because a key lapsed overnight is the worse failure, but an
                unexplained charge is a bad way to find that out. */}
            <p className="settings-section__helper">
              A key is used whenever your workspace routes to that provider, including
              Liftoff Managed. If a provider stops accepting a key, your agents keep
              working on Liftoff and that usage is billed as normal.
            </p>
          </div>
          <div className="settings-form">
            {AI_PROVIDER_KEY_VENDORS.map(({ value, label }) => {
              const isGoogle = value === 'google'
              const hint = keyFor(value)?.hint ?? null
              const typed = draft[value]
              const markedForRemoval = removals[value] === true
              // A cleared field shows nothing, so the stored key's redaction is
              // withheld until Save either commits the removal or Cancel puts
              // it back.
              const shownHint = markedForRemoval ? null : hint
              // Nothing to clear once the field is empty and no key is stored,
              // and nothing to clear from a removal already marked.
              const canClear = !isPending && ((typed !== null && typed !== '') || !!shownHint)
              // The problem is about the STORED key, so it clears the moment a
              // replacement is being typed rather than nagging through the fix.
              const problem = typed === null && !markedForRemoval ? problemFor(value) : null
              return (
                <div className="settings-form__row" key={value}>
                  <div className="settings-form__label-row">
                    <span className="settings-form__label-group">
                      <label className="settings-form__label" htmlFor={`ai-provider-key-${value}`}>
                        {label}
                      </label>
                      {/* Google is the only row that carries a note, because it
                          is the only credential the user has to go and create,
                          and the menu path is what nobody guesses. `location` is
                          not in that file and the platform reads `global`, so
                          the region is stated rather than discovered by a
                          rejected save.

                          It hangs off the label instead of sitting under the
                          field so one row's gloss no longer pushes the three
                          rows below it down the card. The icon is decoration:
                          the sentence itself stays in the field's description,
                          so it is still announced with the label and does not
                          depend on being able to hover. */}
                      {isGoogle && (
                        <>
                          <Tooltip text={GOOGLE_KEY_HINT} position="top">
                            <span className="settings-form__label-info" aria-hidden="true">
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <circle cx="12" cy="12" r="10" />
                                <path d="M12 16v-4" />
                                <path d="M12 8h.01" />
                              </svg>
                            </span>
                          </Tooltip>
                          <span className="sr-only" id={`ai-provider-key-${value}-hint`}>
                            {GOOGLE_KEY_HINT}
                          </span>
                        </>
                      )}
                    </span>
                    {problem && (
                      <span
                        className="settings-form__error"
                        id={`ai-provider-key-${value}-problem`}
                        role="alert"
                      >
                        {problem}
                      </span>
                    )}
                  </div>
                  <div className="settings-form__input-wrapper">
                  <input
                    id={`ai-provider-key-${value}`}
                    className={`settings-form__input${problem ? ' settings-form__input--error' : ''}`}
                    aria-invalid={problem ? true : undefined}
                    // The hint is part of the field's instructions, not
                    // decoration, so a screen reader gets it with the label.
                    aria-describedby={[
                      problem ? `ai-provider-key-${value}-problem` : null,
                      isGoogle ? `ai-provider-key-${value}-hint` : null,
                    ].filter(Boolean).join(' ') || undefined}
                    // Plain text on purpose. A pasted key has to be readable to
                    // be checked; the protection is that a saved one is never
                    // sent back here in full, not that it is hidden as it is
                    // typed.
                    type="text"
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    value={typed ?? shownHint ?? ''}
                    disabled={isPending}
                    // Same sentence for all four, with only the noun changing.
                    // Google's credential is a service account file rather than
                    // a key, and saying so is the whole of what that field needs
                    // to do differently.
                    placeholder={
                      markedForRemoval
                        ? 'Removed when you save'
                        : hint
                          ? `Paste a new ${isGoogle ? 'service account' : 'key'} to replace the saved one`
                          : isGoogle
                            ? 'Paste your Vertex AI service account JSON'
                            : `Paste your ${label} API key`
                    }
                    // Clear the redaction on the way in so a replacement is
                    // pasted into an empty field rather than appended to a mask.
                    onFocus={() => {
                      if (typed === null && shownHint) setDraft(prev => ({ ...prev, [value]: '' }))
                    }}
                    // Nothing typed after all, so hand the field back to the
                    // stored key rather than leaving it looking cleared.
                    onBlur={() => {
                      if (draft[value] === '') setDraft(prev => ({ ...prev, [value]: null }))
                    }}
                    onChange={(e) => {
                      setDraft(prev => ({ ...prev, [value]: e.target.value }))
                      // Pasting a replacement is not a request to end up with
                      // nothing, so it cancels a pending removal.
                      if (markedForRemoval) {
                        setRemovals(prev => {
                          const next = { ...prev }
                          delete next[value]
                          return next
                        })
                      }
                    }}
                  />
                  {canClear && (
                    <button
                      type="button"
                      className="settings-form__clear"
                      // Says what it will do, which differs by state: one
                      // discards a draft, the other takes a stored key away.
                      aria-label={
                        typed !== null && typed !== ''
                          ? `Clear the ${label} field`
                          : `Remove the saved ${label} key`
                      }
                      onClick={() => handleClear(value, !!shownHint)}
                    >
                      <XIcon width="14" height="14" aria-hidden="true" />
                    </button>
                  )}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="settings-section__actions">
            <Button variant="outline" size="sm" onClick={close} disabled={isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={!canSave}
              loading={isPending}
            >
              {isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="settings-section__row">
          <div className="settings-section__left">
            <h2 className="settings-section__title">AI Provider Keys</h2>
            <p className="settings-section__helper">
              Add your API keys from your existing AI providers for your agents to use
            </p>
          </div>
          <div className="settings-section__right">
            {/* Before the count, not after. The right column is anchored to the
                right edge, so a badge placed after the value would shove the
                count sideways whenever something is wrong; ahead of it, the
                count holds its position relative to Manage in both states. */}
            {revokedTooltip && (
              <Tooltip text={revokedTooltip} position="top">
                <span>
                  <StatusBadge variant="error">Needs attention</StatusBadge>
                </span>
              </Tooltip>
            )}
            <span className="settings-section__value">{storedSummary}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsExpanded(true)}
              aria-expanded={isExpanded}
              aria-controls="ai-provider-keys-form"
            >
              Manage
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
