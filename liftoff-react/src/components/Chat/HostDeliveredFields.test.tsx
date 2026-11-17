import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { HostDeliveredFields } from './HostDeliveredFields'

// The renderer for values a tool delivered to this surface and kept out of the
// model's context.
//
// It ships BEFORE anything user-facing moves onto the side channel, which is
// the whole point of the ordering: stripping a download link before this could
// draw it would silently take the link away, and the person would have no way
// to tell a missing link from a tool that failed.

describe('HostDeliveredFields', () => {
  it('renders nothing when there is nothing to show', () => {
    // The common case today, deliberately: the runtime currently only lifts
    // secret-shaped and sensitive fields, which nobody needed to see.
    const { container } = render(<HostDeliveredFields toolName="drive__get_file" fields={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('says the value was not shared with the agent', () => {
    // The person has to be able to tell this apart from something the team
    // said, or a signed URL reads as the agent having quoted it.
    render(
      <HostDeliveredFields
        toolName="drive__get_file"
        fields={[{ path: 'data.downloadUrl', value: 'https://example.com/f/abc' }]}
      />,
    )
    expect(screen.getByText(/not shared with your agent/i)).toBeInTheDocument()
  })

  it('offers an https URL as a link', () => {
    render(
      <HostDeliveredFields
        toolName="drive__get_file"
        fields={[{ path: 'data.downloadUrl', value: 'https://example.com/f/abc' }]}
      />,
    )
    const link = screen.getByRole('link', { name: 'https://example.com/f/abc' })
    expect(link).toHaveAttribute('href', 'https://example.com/f/abc')
    // A connector-supplied URL opened in this tab would hand the opener a
    // reference to the app.
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('renders a non-URL value as text, never as markup', () => {
    // These arrive from a connector. Treating an arbitrary string as markup
    // would be rendering untrusted content.
    render(
      <HostDeliveredFields
        toolName="x__y"
        fields={[{ path: 'data.token', value: '<img src=x onerror=alert(1)>' }]}
      />,
    )
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })

  it('does not linkify a non-https scheme', () => {
    render(
      <HostDeliveredFields toolName="x__y" fields={[{ path: 'p', value: 'javascript:alert(1)' }]} />,
    )
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('names the path each value came from', () => {
    render(
      <HostDeliveredFields
        toolName="x__y"
        fields={[{ path: 'data.items[].url', value: 'plain' }]}
      />,
    )
    expect(screen.getByText('data.items[].url')).toBeInTheDocument()
  })
})
