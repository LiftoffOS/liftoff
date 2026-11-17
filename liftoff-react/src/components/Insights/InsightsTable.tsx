import { useState } from 'react'
import ChevronDownIcon from '../../assets/icons/chevron-down.svg?react'
import type { TableBlock } from '../../types/insights'

interface InsightsTableProps {
  block: TableBlock
}

export default function InsightsTable({ block }: InsightsTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (label: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  // Per-column widths — first column flexes, known columns get tailored widths
  const COLUMN_WIDTHS: Record<string, string> = {
    ous:     '190px',
    amount:  '130px',
    percent: '100px',
  }
  const gridColumns = block.columns
    .map((col, i) => (i === 0 ? '1fr' : (COLUMN_WIDTHS[col.key] ?? '150px')))
    .join(' ')

  const useGroups = block.groups && block.groups.length > 0

  return (
    <div className="insights-report__section">
      <h3 className="insights-report__section-title">{block.title}</h3>
      <div className="insights-report__table">
        <div className="insights-report__table-header" style={{ gridTemplateColumns: gridColumns }}>
          {block.columns.map(col => (
            <span key={col.key}>{col.label}</span>
          ))}
        </div>

        {useGroups
          ? block.groups!.map(group => {
              const isOpen = expanded.has(group.label)
              const hasSubRows = group.rows.length > 0
              return (
                <div key={group.label}>
                  <div
                    className="insights-report__table-row insights-report__table-row--group"
                    style={{
                      gridTemplateColumns: gridColumns,
                      cursor: hasSubRows ? 'pointer' : 'default',
                    }}
                    role={hasSubRows ? 'button' : undefined}
                    tabIndex={hasSubRows ? 0 : undefined}
                    aria-expanded={hasSubRows ? isOpen : undefined}
                    onClick={hasSubRows ? () => toggle(group.label) : undefined}
                    onKeyDown={hasSubRows ? (e => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(group.label) }
                    }) : undefined}
                  >
                    {block.columns.map((col, i) => (
                      <span key={col.key}>
                        {i === 0 ? (
                          <span className="insights-report__table-cell--first">
                            <span>{group.summary[col.key]}</span>
                            {hasSubRows && (
                              <ChevronDownIcon
                                className={`insights-report__table-chevron ${isOpen ? 'insights-report__table-chevron--open' : ''}`}
                                width="16"
                                height="16"
                              />
                            )}
                          </span>
                        ) : (
                          group.summary[col.key]
                        )}
                      </span>
                    ))}
                  </div>
                  {isOpen &&
                    group.rows.map((row, idx) => (
                      <div
                        key={idx}
                        className="insights-report__table-row insights-report__table-row--sub"
                        style={{ gridTemplateColumns: gridColumns }}
                      >
                        {block.columns.map((col, i) => (
                          <span key={col.key}>
                            {i === 0 && <span className="insights-report__table-sub-indent" />}
                            {row[col.key]}
                          </span>
                        ))}
                      </div>
                    ))}
                </div>
              )
            })
          : block.rows.map((row, index) => (
              <div key={index} className="insights-report__table-row" style={{ gridTemplateColumns: gridColumns }}>
                {block.columns.map(col => (
                  <span key={col.key}>{row[col.key]}</span>
                ))}
              </div>
            ))}
      </div>
    </div>
  )
}
