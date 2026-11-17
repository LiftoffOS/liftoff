import { useMemo, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Cell,
  type RectangleProps,
} from 'recharts'
import type { BarChartBlock } from '../../types/insights'

interface InsightsBarChartProps {
  block: BarChartBlock
}

function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.6 + 8
}

const MAX_LABEL_CHARS = 20

function truncateLabel(text: string): { truncated: string; isTruncated: boolean } {
  if (text.length <= MAX_LABEL_CHARS) return { truncated: text, isTruncated: false }
  return { truncated: text.slice(0, MAX_LABEL_CHARS) + '...', isTruncated: true }
}

export default function InsightsBarChart({ block }: InsightsBarChartProps) {
  const maxValue = Math.max(...block.data.map(d => d.max ?? d.value), 1)
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null)

  const data = useMemo(
    () => block.data.map(item => ({ name: item.label, value: item.value })),
    [block.data],
  )

  const formatValue = useCallback((value: number) => {
    if (!block.valueSuffix) return value.toLocaleString()
    const suffix =
      value === 1 && block.valueSuffix.endsWith('s')
        ? block.valueSuffix.slice(0, -1)
        : block.valueSuffix
    return `${value.toLocaleString()} ${suffix}`
  }, [block.valueSuffix])

  const rightMargin = useMemo(() => {
    const longestLabel = data.reduce((longest, item) => {
      const formatted = formatValue(item.value)
      return formatted.length > longest.length ? formatted : longest
    }, '')
    return Math.max(60, estimateTextWidth(longestLabel, 14))
  }, [data, formatValue])

  const showTooltip = useCallback((text: string, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setTooltip({ text, x: rect.left + rect.width / 2, y: rect.top - 6 })
  }, [])

  const hideTooltip = useCallback(() => setTooltip(null), [])

  function renderBar(props: unknown) {
    const p = props as RectangleProps & { background?: RectangleProps; value?: unknown }
    const bx = Number(p.x) || 0
    const by = Number(p.y) || 0
    const bw = Number(p.width) || 0
    const bh = Number(p.height) || 0
    const bgW = Number(p.background?.width) || 0
    const value = Number(p.value) || 0

    return (
      <g>
        <rect x={bx} y={by} width={bgW} height={bh} rx={4} ry={4} fill="#f0f0f0" />
        {bw > 0 && (
          <rect x={bx} y={by} width={bw} height={bh} rx={4} ry={4} fill="#1e1e1e" />
        )}
        <text
          x={bx + bgW + 10}
          y={by + bh / 2 + 5}
          fontSize={14}
          fill="rgba(64,64,64,0.48)"
          textAnchor="start"
        >
          {formatValue(value)}
        </text>
      </g>
    )
  }

  return (
    <div className="insights-report__section">
      <h3 className="insights-report__section-title">{block.title}</h3>
      <div style={{ position: 'relative' }}>
        <ResponsiveContainer width="100%" height={data.length * 36 + 8}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 0, right: rightMargin, left: 0, bottom: 0 }}
            barSize={8}
          >
            <XAxis type="number" hide domain={[0, maxValue]} />
            <YAxis
              type="category"
              dataKey="name"
              width={160}
              tick={(props: Record<string, unknown>) => {
                const { x, y, payload } = props as { x: number; y: number; payload: { value: string } }
                const text = payload.value
                const { truncated, isTruncated } = truncateLabel(text)
                const width = 160
                return (
                  <foreignObject x={Number(x) - width} y={Number(y) - 10} width={width} height={20} style={{ overflow: 'visible' }}>
                    <div
                      onMouseEnter={isTruncated ? (e) => showTooltip(text, e) : undefined}
                      onMouseLeave={isTruncated ? hideTooltip : undefined}
                      style={{
                        fontSize: 14,
                        color: 'rgba(64,64,64,0.36)',
                        textAlign: 'right',
                        lineHeight: '20px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        cursor: isTruncated ? 'default' : undefined,
                      }}
                    >
                      {truncated}
                    </div>
                  </foreignObject>
                )
              }}
              axisLine={false}
              tickLine={false}
            />
            <Bar
              dataKey="value"
              background={{ fill: 'transparent' }}
              shape={renderBar}
            >
              {data.map((_, i) => (
                <Cell key={i} fill="#1e1e1e" />
              ))}
            </Bar>
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
