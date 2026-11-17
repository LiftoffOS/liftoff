import { Suspense, lazy } from 'react'
import type { VisualizationBlock, ObservationBlock } from '../../types/insights'
import InsightsMetricCards from './InsightsMetricCards'
import InsightsBarChart from './InsightsBarChart'
import InsightsTrendChart from './InsightsTrendChart'
import InsightsTable from './InsightsTable'
import InsightsObservation from './InsightsObservation'
import InsightsText from './InsightsText'

// Split out because it pulls in the graph library, and only the Chief AI
// Officer emits org charts. Loading it eagerly would put ~300 kB of diagram
// code in front of every Insights reply, none of which can contain one.
const InsightsOrgChart = lazy(() => import('./InsightsOrgChart'))

interface VisualizationRendererProps {
  blocks: VisualizationBlock[]
}

function UnknownBlockFallback({ block }: { block: { type: string } }) {
  return (
    <div className="insights-report__section">
      <p style={{ color: 'var(--color-gray-400)', fontSize: 'var(--text-sm)' }}>
        Unsupported visualization type: {block.type}
      </p>
    </div>
  )
}

function renderBlock(block: VisualizationBlock, index: number) {
  switch (block.type) {
    case 'bar_chart':
      return <InsightsBarChart key={index} block={block} />
    case 'trend_chart':
      return <InsightsTrendChart key={index} block={block} />
    case 'table':
      return <InsightsTable key={index} block={block} />
    case 'text':
      return <InsightsText key={index} content={block.content} />
    case 'org_chart':
      return (
        // No fallback: the chart arrives at the end of a reply the reader is
        // still reading, so a spinner would be a flash of nothing in the middle
        // of the text rather than something worth waiting on.
        <Suspense key={index} fallback={null}>
          <InsightsOrgChart block={block} />
        </Suspense>
      )
    case 'observation':
      return null
    case 'metric_card':
      // Metric cards are rendered separately in the grid below
      return null
    default: {
      const _exhaustive: never = block
      return <UnknownBlockFallback key={index} block={_exhaustive as { type: string }} />
    }
  }
}

export default function VisualizationRenderer({ blocks }: VisualizationRendererProps) {
  const metricCards = blocks.filter(b => b.type === 'metric_card')
  const observations = blocks.filter((b): b is ObservationBlock => b.type === 'observation')

  // Preserve source order: blocks before the first metric_card render first,
  // then the metric_card grid, then everything after.
  const firstMetricIdx = blocks.findIndex(b => b.type === 'metric_card')
  let lastMetricIdx = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'metric_card') { lastMetricIdx = i; break }
  }

  const leadingBlocks = firstMetricIdx > 0
    ? blocks.slice(0, firstMetricIdx).filter(b => b.type !== 'observation')
    : []
  const trailingBlocks = blocks
    .slice(lastMetricIdx >= 0 ? lastMetricIdx + 1 : 0)
    .filter(b => b.type !== 'metric_card' && b.type !== 'observation')

  return (
    <>
      {leadingBlocks.map((block, index) => renderBlock(block, index))}
      {metricCards.length > 0 && (
        <InsightsMetricCards blocks={metricCards} />
      )}
      {trailingBlocks.map((block, index) => renderBlock(block, index))}
      {observations.length > 0 && (
        <div className="insights-report__section">
          <h3 className="insights-report__section-title">Key Observations</h3>
          <div className="insights-report__observations">
            {observations.map((block, index) => (
              <InsightsObservation key={index} block={block} />
            ))}
          </div>
        </div>
      )}
    </>
  )
}
