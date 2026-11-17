import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MediaRef } from '../../types/media'
import { _resetMediaUrlCache } from '../../services/mediaUrl'

// The URL is minted on mount, so the card is defined by what it does around
// that one request: before it, when it fails, and when the workspace it needs
// in order to make it is not there yet.

const get = vi.fn()
vi.mock('../../services/api', () => ({ api: { get: (...args: unknown[]) => get(...args) } }))

let tenant: { id: string } | undefined = { id: 'tenant-1' }
vi.mock('../../hooks/useTenant', () => ({
  useTenant: () => ({ currentTenant: tenant }),
}))

const { MediaCard } = await import('./MediaCard')

const IMAGE: MediaRef = {
  mediaId: 'media-1',
  mimeType: 'image/png',
  filename: 'browser-screenshot_v1.png',
  width: 1280,
  height: 3200,
  alt: 'the checkout page',
}

beforeEach(() => {
  // The signed-URL cache is module state and outlives a test. Without this the
  // first case that mints a URL hands it to every case after it, and the ones
  // that assert on the pre-URL states silently stop testing anything.
  _resetMediaUrlCache()
  tenant = { id: 'tenant-1' }
  get.mockReset()
  get.mockResolvedValue({ downloadUrl: 'https://storage.example/fresh', mimeType: 'image/png' })
})

describe('MediaCard', () => {
  it('mints a fresh URL on mount rather than trusting a stored one', async () => {
    render(<MediaCard media={IMAGE} />)
    const img = await screen.findByAltText('the checkout page')
    expect(img).toHaveAttribute('src', 'https://storage.example/fresh')
    expect(get).toHaveBeenCalledWith(
      '/api/generated-files/media-1/download?tenantId=tenant-1',
    )
  })

  // The regression this replaces a passing assertion for.
  //
  // The loaded image used to carry `aspect-ratio` built from the stored
  // dimensions. Those come from the JPEG frame header — RAW pixels, before EXIF
  // rotation — so a phone photo shot in portrait is recorded as landscape and
  // the browser rotates it on render. The imposed landscape ratio then stretched
  // the portrait picture sideways to fill it, and widened the bubble with it.
  //
  // Reserving space is the placeholder's job; it is a different element and it
  // is gone by the time this one paints. The image sizes itself from its own
  // bytes, which is the one source that cannot disagree with what the reader
  // sees.
  it('imposes no aspect ratio on the loaded image', async () => {
    render(<MediaCard media={IMAGE} />)
    const img = await screen.findByAltText('the checkout page')
    expect(img.style.aspectRatio).toBe('')
    expect(img.getAttribute('width')).toBeNull()
    expect(img.getAttribute('height')).toBeNull()
  })

  // A portrait screenshot is the case that goes wrong quietly. The placeholder
  // is a plain <div>, so it has no intrinsic size and reserves whatever CSS is
  // told to reserve; `width: 100%` plus the image's ratio makes a
  // bubble-wide, 2.5-screens-tall grey rectangle that the picture then
  // collapses out of. The stylesheet clamps the width to `max-height x ratio`,
  // and this is the value that clamp is computed from.
  it('hands CSS the ratio it needs to size a portrait placeholder', () => {
    // Never resolves, so the card stays in its loading state.
    get.mockImplementation(() => new Promise(() => {}))
    const { container } = render(<MediaCard media={IMAGE} />)
    const placeholder = container.querySelector('.chat-media--loading') as HTMLElement
    expect(placeholder).toBeTruthy()
    expect(placeholder.style.getPropertyValue('--chat-media-ar')).toBe('1280 / 3200')
    // Unitless, so CSS can multiply it by the max height. 1280/3200 = 0.4.
    expect(Number(placeholder.style.getPropertyValue('--chat-media-ar-num'))).toBeCloseTo(0.4)
  })

  it('reserves nothing it cannot justify when no dimensions were recorded', () => {
    get.mockImplementation(() => new Promise(() => {}))
    const { container } = render(
      <MediaCard media={{ ...IMAGE, width: undefined, height: undefined }} />,
    )
    const placeholder = container.querySelector('.chat-media--loading') as HTMLElement
    expect(placeholder.style.getPropertyValue('--chat-media-ar')).toBe('')
  })

  // The expanded view must not reuse a fixed-width box. `--wide` is the pricing
  // grid's 960px landscape box; using it left a portrait photo centred in it
  // with two columns of white either side.
  it('opens the expanded view in a box that takes the picture’s shape', async () => {
    const user = userEvent.setup()
    const { container } = render(<MediaCard media={IMAGE} />)
    await user.click(await screen.findByRole('button', { name: /expand/i }))
    expect(container.ownerDocument.querySelector('.modal-overlay__content--media')).toBeTruthy()
    expect(container.ownerDocument.querySelector('.modal-overlay__content--wide')).toBeNull()
  })

  // Discoverability: nothing on screen said the expanded image was dismissable,
  // and a reader who does not guess that clicking the picture works has no
  // control to look for. The close button is an addition — every existing way
  // out still works.
  it('offers a close control in the expanded view', async () => {
    const user = userEvent.setup()
    render(<MediaCard media={IMAGE} />)
    await user.click(await screen.findByRole('button', { name: /expand/i }))
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close).toBeInTheDocument()
    await user.click(close)
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
  })

  it('still closes when the picture itself is clicked', async () => {
    const user = userEvent.setup()
    render(<MediaCard media={IMAGE} />)
    await user.click(await screen.findByRole('button', { name: /expand/i }))
    await user.click(screen.getByRole('button', { name: /^Close the checkout page$/ }))
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
  })

  it('falls back to the filename when the producer supplied no description', async () => {
    render(<MediaCard media={{ ...IMAGE, alt: undefined }} />)
    expect(await screen.findByAltText('browser-screenshot_v1.png')).toBeInTheDocument()
  })

  it('recovers when the workspace resolves after first paint', async () => {
    // The regression this pins: `currentTenant` is undefined for a beat on a
    // cold load. Treating that as a failure latched the card into its fallback
    // and the successful retry could not clear it, so every image on the page
    // rendered as a file row forever.
    tenant = undefined
    const { rerender } = render(<MediaCard media={IMAGE} />)
    expect(get).not.toHaveBeenCalled()

    tenant = { id: 'tenant-1' }
    rerender(<MediaCard media={{ ...IMAGE }} />)
    expect(await screen.findByAltText('the checkout page')).toBeInTheDocument()
  })

  it('degrades to a named, downloadable card when the URL cannot be minted', async () => {
    get.mockRejectedValue(new Error('403'))
    render(<MediaCard media={IMAGE} />)
    expect(await screen.findByText('browser-screenshot_v1.png')).toBeInTheDocument()
    // NOT FileOutputCard's connector branch: "Not in your cloud storage" is
    // about a document, and means nothing here.
    expect(screen.queryByText(/Not in your cloud storage/)).not.toBeInTheDocument()
  })

  it('re-mints once when the bytes will not load, before giving up', async () => {
    render(<MediaCard media={IMAGE} />)
    const img = await screen.findByAltText('the checkout page')
    get.mockResolvedValue({ downloadUrl: 'https://storage.example/second', mimeType: 'image/png' })

    img.dispatchEvent(new Event('error'))

    // An expired signed URL is the likeliest cause by far, and the person
    // should never have to know it happened.
    await waitFor(() =>
      expect(screen.getByAltText('the checkout page')).toHaveAttribute(
        'src',
        'https://storage.example/second',
      ),
    )
  })

  it('draws video with controls and never autoplays', async () => {
    const { container } = render(
      <MediaCard media={{ ...IMAGE, mimeType: 'video/mp4', filename: 'clip_v1.mp4' }} />,
    )
    await waitFor(() => expect(container.querySelector('video')).toBeInTheDocument())
    const video = container.querySelector('video')!
    expect(video).toHaveAttribute('controls')
    expect(video).not.toHaveAttribute('autoplay')
    expect(video).toHaveAttribute('preload', 'metadata')
  })

  it('draws audio with controls', async () => {
    const { container } = render(
      <MediaCard media={{ ...IMAGE, mimeType: 'audio/mpeg', filename: 'memo_v1.mp3' }} />,
    )
    await waitFor(() => expect(container.querySelector('audio')).toBeInTheDocument())
    expect(container.querySelector('audio')).toHaveAttribute('controls')
  })

  it('shows a MIME it cannot draw as a card rather than a broken element', async () => {
    const { container } = render(
      <MediaCard media={{ ...IMAGE, mimeType: 'application/pdf', filename: 'report_v1.pdf' }} />,
    )
    expect(await screen.findByText('report_v1.pdf')).toBeInTheDocument()
    expect(container.querySelector('img')).not.toBeInTheDocument()
  })

  it('opens an image full size and closes it again by clicking it', async () => {
    const user = userEvent.setup()
    render(<MediaCard media={IMAGE} />)
    await screen.findByAltText('the checkout page')

    await user.click(screen.getByRole('button', { name: /Expand the checkout page/ }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // The overlay stops propagation on its own content, so clicking the picture
    // is otherwise the one gesture that would not close it.
    await user.click(screen.getByRole('button', { name: /Close the checkout page/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
