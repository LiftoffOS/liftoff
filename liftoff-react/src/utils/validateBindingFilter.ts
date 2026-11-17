export type SupportedBindingConnector = 'google_mail' | 'microsoft_outlook_mail'

export interface FilterValidationResult {
  ok: boolean
  warning?: string
}

export function validateBindingFilter(
  connectorType: SupportedBindingConnector,
  value: string,
): FilterValidationResult {
  if (!value.trim()) return { ok: true }

  if (connectorType === 'google_mail') {
    const tokens = value.match(/\([^)]*\)|\S+/g) ?? []
    const supported = /^(label|to|from):/i
    const allOk = tokens.every(t => supported.test(t) || /^\(.+\)$/.test(t))
    if (allOk) return { ok: true }
    return {
      ok: false,
      warning:
        'Filter uses syntax outside the supported subset (label:, to:, from:). ' +
        'The agent\'s explicit list_messages calls will still work, but the ' +
        'event-routing predicate may skip matching messages.',
    }
  }

  // Outlook: AND-split, each clause matches one of three regexes.
  const clauses = value.split(/\s+and\s+/i).map(s => s.trim()).filter(Boolean)
  const supported = [
    /^from\/emailAddress\/address\s+eq\s+'[^']+'$/,
    /^toRecipients\/any\([a-z]+:[a-z]+\/emailAddress\/address\s+eq\s+'[^']+'\)$/,
    /^categories\/any\([a-z]+:[a-z]+\s+eq\s+'[^']+'\)$/,
  ]
  const allOk = clauses.every(c => supported.some(re => re.test(c)))
  if (allOk) return { ok: true }
  return {
    ok: false,
    warning:
      'Filter uses $filter syntax outside the supported subset (from/.../eq, ' +
      'toRecipients/any, categories/any). Same caveat as above.',
  }
}
