import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import type { FileAttachment } from './ChatMessages'

// A connector-native card is a file that lives in the connector: no bytes on
// the platform, nothing to download. The registration route writes
// `downloadUrl: null` on the attachment, and this card hides its Download
// button on exactly null — `undefined !== null`, so an omitted field draws a
// button that leads nowhere. The property lives in the contract between the
// two repos, and only a rendered assertion sees both ends.

vi.mock('../../services/api', () => ({ api: { get: vi.fn() } }))
vi.mock('../../hooks/useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-1' } }),
}))

const { FileOutputCard } = await import('./FileOutputCard')

// A file the team FOUND in Drive and handed over: registered
// connector-natively, so the platform never held its bytes.
const CONNECTOR_NATIVE: FileAttachment = {
  generatedFileId: 'file-1',
  filename: 'Larkspur-Tern NDA (3 Mar 2026)_v1.pdf',
  outputType: 'pdf',
  version: 1,
  downloadUrl: null,
  webViewUrl: 'https://drive.google.com/file/d/11oLOzMC4S614mxUUAvLEfV7Myx6whVBh/view',
}

const STORED: FileAttachment = {
  generatedFileId: 'file-2',
  filename: 'report_v1.pdf',
  outputType: 'pdf',
  version: 1,
  downloadUrl: 'https://storage.example/signed',
  webViewUrl: 'https://drive.google.com/file/d/f2/view',
}

function draw(attachment: FileAttachment) {
  return render(
    <MemoryRouter>
      <FileOutputCard attachment={attachment} />
    </MemoryRouter>,
  )
}

describe('FileOutputCard', () => {
  it('draws no Download button for a connector-native file, only the link into the connector', () => {
    draw(CONNECTOR_NATIVE)
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
    const open = screen.getByRole('link', { name: 'Open in Google Drive' })
    expect(open).toHaveAttribute('href', CONNECTOR_NATIVE.webViewUrl)
    expect(screen.getByText('Larkspur-Tern NDA (3 Mar 2026)_v1.pdf')).toBeInTheDocument()
  })

  it('says the copy did not reach the connector, without claiming why, when there is no link into it', () => {
    // The platform only hears about a sync that SUCCEEDED, so an auth
    // failure, a vendor error and a connector that never syncs all arrive
    // here as the same missing webViewUrl. Sending a person to re-authorize a
    // connection that is fine is the harm to avoid (an upload route bug can
    // produce a 401 over a healthy Drive connection).
    draw({ ...STORED, webViewUrl: undefined })
    expect(screen.getByRole('button', { name: /Not in your cloud storage/ })).toBeInTheDocument()
    expect(screen.queryByText(/Re-authorize|Check connection|Saved here/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
  })

  it('keeps the Download button for a file the platform holds the bytes of', () => {
    draw(STORED)
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open in Google Drive' })).toHaveAttribute('href', STORED.webViewUrl)
  })
})
