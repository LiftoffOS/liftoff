export function formatTime(dateStr: string | Date): string {
  const date = typeof dateStr === 'string' ? new Date(dateStr) : dateStr
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function deriveThreadTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim()
  if (trimmed.length <= 50) return trimmed

  const slice = trimmed.slice(0, 50)
  const lastSpace = slice.lastIndexOf(' ')
  if (lastSpace > 20) {
    return `${slice.slice(0, lastSpace)}…`
  }
  return `${slice}…`
}

// The greeting used to be computed here, from the browser clock, and rendered
// as empty-state copy. It is a real message again: the team says it, streamed
// from the backend with no thread and nothing persisted, so there is one
// implementation of the sentence rather than a client copy drifting against a
// server one. See agent-chat/greeting.ts in platform-backend for the wording,
// and useChatStreaming's startGreeting for how it arrives.

export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'} ago`

  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`

  return date.toLocaleDateString()
}
