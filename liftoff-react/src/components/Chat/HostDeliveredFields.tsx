import type { JSX } from 'react'
import './HostDeliveredFields.css'

/**
 * Values a tool returned that were delivered to this surface and deliberately
 * kept out of the model's context.
 *
 * Some things a connector returns are for the person and not for the agent: a
 * signed download URL, a payment link, a one-time token. Today every byte a
 * tool returns enters model context, and the only alternative removes the
 * content entirely — so the choice has been between the model memorising a
 * signed URL and the person never getting it.
 *
 * The runtime now lifts declared fields onto a side channel and leaves
 * "[delivered to the surface]" in the model's copy. This is where they land.
 *
 * IT EXISTS BEFORE ANYTHING USER-FACING MOVES ONTO THE CHANNEL, and that
 * ordering is the point rather than an accident of scheduling: stripping a
 * download link before this could draw it would silently take the link away,
 * and the person would have no way to tell a missing link from a tool that
 * failed. Today the runtime only lifts secret-shaped and sensitive-categorised
 * fields, which nobody needed to see — so this renders rarely, on purpose,
 * until the values that DO matter are moved across.
 */
export interface HostDeliveredField {
  /** The result path the value came from, e.g. `data.downloadUrl`. */
  path: string
  value: unknown
}

export interface HostDeliveredFieldsProps {
  toolName: string
  fields: HostDeliveredField[]
}

/** A URL is offered as a link; everything else is shown as text.
 *
 *  Deliberately narrow. These values arrive from a connector, so treating an
 *  arbitrary string as markup would be rendering untrusted content — the same
 *  reason the transcript renders tool output as text everywhere else. */
function renderValue(value: unknown): JSX.Element {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const isHttpUrl = /^https:\/\/[^\s]+$/.test(text)
  if (isHttpUrl) {
    return (
      <a
        className="host-delivered__link"
        href={text}
        target="_blank"
        rel="noopener noreferrer"
      >
        {text}
      </a>
    )
  }
  return <span className="host-delivered__value">{text}</span>
}

export function HostDeliveredFields({
  toolName,
  fields,
}: HostDeliveredFieldsProps): JSX.Element | null {
  if (fields.length === 0) return null

  return (
    <div className="host-delivered" data-testid="host-delivered-fields">
      <div className="host-delivered__header">
        Delivered to you from {toolName}, and not shared with your agent
      </div>
      <ul className="host-delivered__list">
        {fields.map((field) => (
          <li className="host-delivered__item" key={field.path}>
            <span className="host-delivered__path">{field.path}</span>
            {renderValue(field.value)}
          </li>
        ))}
      </ul>
    </div>
  )
}
