import { useEffect, useRef } from 'react'
import VisualizationRenderer from '../../components/Insights/VisualizationRenderer'
import LiftoffScorePanel from '../../components/Insights/LiftoffScorePanel'
import type { VisualizationBlock } from '../../types/insights'
import type { LiftoffScoreResponse } from '../../types/liftoffScore'
import { track } from '../../lib/analytics'
import './InsightsReport.css'

interface InsightsReportProps {
  blocks: VisualizationBlock[]
  isLoading: boolean
  /** Owner/admin only, behind liftoff_score_enabled. Undefined means "do not render". */
  liftoffScore?: LiftoffScoreResponse
  liftoffScoreLoading?: boolean
  /** True while the LLM intro stream is still in flight. Renders a small
   *  shimmer above the metric cards until the intro arrives (or the
   *  stream finishes empty). */
  introLoading?: boolean
  /** Phase 7: true while the LLM observation stream is still in flight. */
  observationsLoading?: boolean
}

export default function InsightsReport({
  blocks,
  isLoading,
  liftoffScore,
  liftoffScoreLoading = false,
  introLoading = false,
  observationsLoading = false,
}: InsightsReportProps) {
  const viewedRef = useRef(false)
  useEffect(() => {
    if (viewedRef.current || isLoading) return
    viewedRef.current = true
    track('insights_report_viewed', { report_id: '' })
  }, [isLoading])

  if (isLoading) {
    return (
      <div className="insights-report">
        <div className="insights-report__loading">
          <div className="insights-report__stats">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="insights-report__skeleton insights-report__skeleton--card" />
            ))}
          </div>
          <div className="insights-report__skeleton insights-report__skeleton--chart" />
          <div className="insights-report__skeleton insights-report__skeleton--chart" />
        </div>
      </div>
    )
  }

  const hasLiftoffScore = !!liftoffScore || liftoffScoreLoading

  if (blocks.length === 0 && !hasLiftoffScore) {
    return null
  }

  // Show a subtle "Key Observations" skeleton at the bottom while the
  // LLM observation stream is in flight, but ONLY if no observation
  // blocks have arrived yet (otherwise the existing VisualizationRenderer
  // section already covers it).
  const hasObservations = blocks.some(b => b.type === 'observation')
  const showObservationsSkeleton = observationsLoading && !hasObservations

  // Show a placeholder shimmer for the insight intro paragraph above the
  // metric cards while the LLM intro stream is in flight. We only show
  // it when (a) loading is in progress, (b) no leading text block has
  // arrived yet (the renderer would render it), and (c) the report
  // actually has metric cards (skip in the empty-state path where the
  // only block is the "No data yet" text).
  const firstMetricIdx = blocks.findIndex(b => b.type === 'metric_card')
  const hasLeadingIntro =
    firstMetricIdx > 0 &&
    blocks.slice(0, firstMetricIdx).some(b => b.type === 'text')
  const showIntroSkeleton =
    introLoading && !hasLeadingIntro && firstMetricIdx >= 0

  return (
    <div className="insights-report">
      {showIntroSkeleton && (
        <div className="insights-report__intro-skeleton" aria-busy="true" aria-live="polite">
          <div className="insights-report__skeleton insights-report__skeleton--intro insights-report__skeleton--intro-line-1" />
          <div className="insights-report__skeleton insights-report__skeleton--intro insights-report__skeleton--intro-line-2" />
        </div>
      )}
      <VisualizationRenderer blocks={blocks} />
      {hasLiftoffScore && (
        <LiftoffScorePanel data={liftoffScore} isLoading={liftoffScoreLoading} />
      )}
      {showObservationsSkeleton && (
        <div className="insights-report__section" aria-busy="true" aria-live="polite">
          <h3 className="insights-report__section-title">Key Observations</h3>
          <div className="insights-report__observations">
            {[1, 2, 3].map(i => (
              <div
                key={i}
                className="insights-report__skeleton insights-report__skeleton--observation"
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
