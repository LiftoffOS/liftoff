import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer } from 'recharts'
import type { TrendChartBlock } from '../../types/insights'

interface InsightsTrendChartProps {
  block: TrendChartBlock
}

const SEGMENT_COLORS: Record<string, string> = {
  'AI Workforce': '#1e1e1e',
  'Human Workforce': '#c4c4c4',
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'rgba(64,64,64,0.48)' }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
      {label}
    </span>
  )
}

function EmptyState() {
  return (
    <div style={{
      height: 160,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'rgba(64,64,64,0.36)',
      fontSize: 14,
      background: '#f7f7f7',
      borderRadius: 8,
    }}>
      No data for this period
    </div>
  )
}

export default function InsightsTrendChart({ block }: InsightsTrendChartProps) {
  const hasSegments = block.data.some(bar => bar.segments && bar.segments.length > 0)
  const isEmpty = block.data.length === 0
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null)

  const showTooltip = useCallback((text: string, e: { clientX: number; clientY: number }) => {
    setTooltip({ text, x: e.clientX, y: e.clientY - 6 })
  }, [])

  const hideTooltip = useCallback(() => setTooltip(null), [])

  if (hasSegments && !isEmpty) {
    const segments = block.data[0].segments!
    const data = block.data.map(item => {
      const row: Record<string, string | number> = { name: item.label }
      for (const seg of item.segments || []) {
        row[seg.label] = seg.value
      }
      return row
    })

    return (
      <div className="insights-report__section">
        <h3 className="insights-report__section-title">{block.title}</h3>
        <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
          {segments.map(seg => (
            <LegendDot key={seg.label} color={SEGMENT_COLORS[seg.label] || '#1e1e1e'} label={seg.label} />
          ))}
        </div>
        <div style={{ position: 'relative' }} onMouseLeave={hideTooltip}>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }} barGap={0} barCategoryGap="25%">
              <XAxis
                dataKey="name"
                tick={{ fontSize: 12, fill: 'rgba(64,64,64,0.48)' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis hide />
              {[...segments].reverse().map(seg => (
                <Bar
                  key={seg.label}
                  dataKey={seg.label}
                  stackId="stack"
                  fill={SEGMENT_COLORS[seg.label] || '#1e1e1e'}
                  radius={[4, 4, 4, 4]}
                  onMouseEnter={(payload, _index, e) => {
                    const value = Number((payload as unknown as Record<string, unknown>)[seg.label]) || 0
                    showTooltip(`${seg.label}: ${value.toLocaleString()}`, e as unknown as { clientX: number; clientY: number })
                  }}
                  onMouseMove={(payload, _index, e) => {
                    const value = Number((payload as unknown as Record<string, unknown>)[seg.label]) || 0
                    showTooltip(`${seg.label}: ${value.toLocaleString()}`, e as unknown as { clientX: number; clientY: number })
                  }}
                  onMouseLeave={hideTooltip}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
          {tooltip && createPortal(
            <span
              className="tooltip-portal tooltip-portal--visible"
              style={{ top: tooltip.y, left: tooltip.x, transform: 'translate(-50%, -100%)' }}
            >
              {tooltip.text}
            </span>,
            document.body,
          )}
        </div>
      </div>
    )
  }

  // Empty or simple (no segments)
  return (
    <div className="insights-report__section">
      <h3 className="insights-report__section-title">{block.title}</h3>
      {isEmpty ? (
        <EmptyState />
      ) : (
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={block.data.map(d => ({ name: d.label, value: d.value }))} margin={{ top: 0, right: 0, left: 0, bottom: 0 }} barCategoryGap="25%">
            <XAxis
              dataKey="name"
              tick={{ fontSize: 12, fill: 'rgba(64,64,64,0.48)' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis hide />
            <Bar dataKey="value" fill="#1e1e1e" radius={[4, 4, 4, 4]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
