import './InsightsText.css'

interface InsightsTextProps {
  content: string
}

export default function InsightsText({ content }: InsightsTextProps) {
  return (
    <div className="insights-text">
      <p className="insights-text__content">{content}</p>
    </div>
  )
}
