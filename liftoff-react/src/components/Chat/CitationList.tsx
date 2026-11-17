import { useState } from 'react'
import type { Citation } from './ChatMessages'

interface CitationListProps {
  citations: Citation[]
}

export function CitationList({ citations }: CitationListProps) {
  const [expanded, setExpanded] = useState(false)
  const [modalCitation, setModalCitation] = useState<Citation | null>(null)

  if (!citations.length) return null

  return (
    <div className="citation-list">
      <button
        className="citation-list__toggle"
        onClick={() => setExpanded(e => !e)}
      >
        {citations.length} source{citations.length !== 1 ? 's' : ''} {expanded ? '▲' : '▼'}
      </button>
      {expanded && (
        <ol className="citation-list__items">
          {citations.map(c => (
            <li key={c.ref} className="citation-list__item">
              <span className="citation-list__ref">[{c.ref}]</span>
              <span className="citation-list__filename">{c.filename}</span>
              {c.page && <span className="citation-list__page">p. {c.page}</span>}
              <button
                className="citation-list__quote-btn"
                onClick={() => setModalCitation(c)}
              >
                &ldquo;{c.quote.slice(0, 60)}{c.quote.length > 60 ? '…' : ''}&rdquo;
              </button>
            </li>
          ))}
        </ol>
      )}
      {modalCitation && (
        <div
          className="citation-modal"
          role="presentation"
          onClick={e => { if (e.target === e.currentTarget) setModalCitation(null) }}
        >
          <div className="citation-modal__content" role="dialog" aria-modal="true" tabIndex={-1}>
            <div className="citation-modal__header">
              <strong>{modalCitation.filename}</strong>
              {modalCitation.page && <span> &middot; p. {modalCitation.page}</span>}
            </div>
            <blockquote className="citation-modal__quote">
              {modalCitation.quote}
            </blockquote>
            <button onClick={() => setModalCitation(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
