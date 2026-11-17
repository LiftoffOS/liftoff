import MetricCard from '../Dashboard/MetricCard'
import type { MetricCardBlock } from '../../types/insights'

interface InsightsMetricCardsProps {
  blocks: MetricCardBlock[]
}

export default function InsightsMetricCards({ blocks }: InsightsMetricCardsProps) {
  return (
    <div className="insights-report__stats">
      {blocks.map((block, index) => (
        <MetricCard
          key={index}
          label={block.label}
          value={block.value}
          trend={block.trend}
          trendText={block.trendText}
          lowerIsBetter={block.lowerIsBetter}
        />
      ))}
    </div>
  )
}
