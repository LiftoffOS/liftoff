import { describe, it, expect, vi, beforeEach } from 'vitest'
import { prepareFiles } from './FileUploadPopover.media'

// The upload is the only part that leaves the browser, so it is the only part
// mocked. Everything else — which branch a file takes, which cap it meets, what
// the person is told when it is refused — is the behaviour under test.
const uploadChatMedia = vi.fn()
vi.mock('../../services/chatMedia', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/chatMedia')>()
  return { ...actual, uploadChatMedia: (...args: unknown[]) => uploadChatMedia(...args) }
})

const ctx = {
  tenantId: 'tenant-1',
  surface: 'liftoff' as const,
  threadId: 'thread-1',
  existingMediaCount: 0,
}

function file(name: string, type: string, size = 100): File {
  const f = new File(['x'], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

beforeEach(() => {
  uploadChatMedia.mockReset()
  uploadChatMedia.mockResolvedValue({
    mediaId: 'm1',
    mimeType: 'image/png',
    filename: 'shot_v1.png',
  })
})

describe('what each kind of file does', () => {
  it('uploads an image and attaches a reference, never its bytes', async () => {
    const { attachments, errors } = await prepareFiles([file('shot.png', 'image/png')], ctx)
    expect(errors).toEqual([])
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({ kind: 'media', name: 'shot.png' })
    expect(JSON.stringify(attachments[0])).not.toContain('base64')
  })

  // The path that predates media and must be untouched by it.
  it('still reads a text file inline', async () => {
    const { attachments } = await prepareFiles([file('notes.md', 'text/markdown')], ctx)
    expect(attachments[0]).toMatchObject({ kind: 'upload', name: 'notes.md' })
    expect(uploadChatMedia).not.toHaveBeenCalled()
  })

  // `accept` is a filter, not a guarantee: a paste and a drop bypass it. So the
  // refusal has to exist here, and it has to name the file.
  it('refuses a type it cannot take, by name', async () => {
    const { attachments, errors } = await prepareFiles([file('photo.heic', 'image/heic')], ctx)
    expect(attachments).toHaveLength(0)
    expect(errors[0]).toContain('photo.heic')
  })

  it('refuses an SVG, which the store will not hold', async () => {
    const { errors } = await prepareFiles([file('logo.svg', 'image/svg+xml')], ctx)
    expect(errors).toHaveLength(1)
    expect(uploadChatMedia).not.toHaveBeenCalled()
  })
})

describe('several files at once', () => {
  // `files?.[0]` took one per invocation regardless of what was selected, so
  // picking three documents silently attached one.
  it('takes every file, not just the first', async () => {
    const { attachments } = await prepareFiles(
      [file('a.md', 'text/markdown'), file('b.md', 'text/markdown'), file('c.md', 'text/markdown')],
      ctx,
    )
    expect(attachments).toHaveLength(3)
  })

  // One bad file must not cost the person the good ones in the same drop.
  it('keeps the good ones when one is refused', async () => {
    const { attachments, errors } = await prepareFiles(
      [file('a.md', 'text/markdown'), file('bad.exe', 'application/x-msdownload')],
      ctx,
    )
    expect(attachments).toHaveLength(1)
    expect(errors).toHaveLength(1)
  })
})

describe('caps are enforced before anything leaves the browser', () => {
  it('refuses an oversized file without uploading it', async () => {
    const { attachments, errors } = await prepareFiles(
      [file('huge.mp4', 'video/mp4', 40 * 1024 * 1024)],
      ctx,
    )
    expect(attachments).toHaveLength(0)
    expect(errors[0]).toContain('limit')
    expect(uploadChatMedia).not.toHaveBeenCalled()
  })

  it('counts media already on the message, not just this batch', async () => {
    const { attachments, errors } = await prepareFiles(
      [file('a.png', 'image/png')],
      { ...ctx, existingMediaCount: 4 },
    )
    expect(attachments).toHaveLength(0)
    expect(errors[0]).toContain('a.png')
  })

  it('stops at the cap partway through a batch and says which were dropped', async () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map(n => file(`${n}.png`, 'image/png'))
    const { attachments, errors } = await prepareFiles(files, ctx)
    expect(attachments).toHaveLength(4)
    expect(errors).toHaveLength(2)
  })
})

describe('several files upload together, not one after another', () => {
  // Four screenshots used to take four round trips end to end because each
  // await blocked the next. The uploads are independent; only the CAP decisions
  // have to be ordered.
  it('starts every upload before any of them finishes', async () => {
    let inFlight = 0
    let peak = 0
    uploadChatMedia.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight -= 1
      return { mediaId: 'm', mimeType: 'image/png', filename: 'a.png' }
    })
    await prepareFiles(
      ['a', 'b', 'c'].map(n => file(`${n}.png`, 'image/png')),
      ctx,
    )
    expect(peak).toBeGreaterThan(1)
  })

  // Concurrency must not decide which file is which. The pills should read in
  // the order the person picked them, whatever order the network answers in.
  it('keeps the picked order even when the uploads finish out of order', async () => {
    const delays: Record<string, number> = { 'a.png': 30, 'b.png': 1, 'c.png': 15 }
    uploadChatMedia.mockImplementation(async (input: { file: File }) => {
      await new Promise(r => setTimeout(r, delays[input.file.name]))
      return { mediaId: input.file.name, mimeType: 'image/png', filename: input.file.name }
    })
    const { attachments } = await prepareFiles(
      ['a', 'b', 'c'].map(n => file(`${n}.png`, 'image/png')),
      ctx,
    )
    expect(attachments.map(a => a.name)).toEqual(['a.png', 'b.png', 'c.png'])
  })

  // The cap is decided up front, in order, so it always refuses the same file.
  it('refuses the same file regardless of which upload wins the race', async () => {
    uploadChatMedia.mockImplementation(async (input: { file: File }) => {
      await new Promise(r => setTimeout(r, input.file.name === 'a.png' ? 20 : 1))
      return { mediaId: 'm', mimeType: 'image/png', filename: input.file.name }
    })
    const { attachments, errors } = await prepareFiles(
      ['a', 'b', 'c', 'd', 'e'].map(n => file(`${n}.png`, 'image/png')),
      ctx,
    )
    expect(attachments.map(a => a.name)).toEqual(['a.png', 'b.png', 'c.png', 'd.png'])
    expect(errors[0]).toContain('e.png')
  })
})

describe('an upload that fails', () => {
  it('reports the reason rather than attaching nothing quietly', async () => {
    uploadChatMedia.mockRejectedValueOnce(new Error('Unsupported media type'))
    const { attachments, errors } = await prepareFiles([file('shot.png', 'image/png')], ctx)
    expect(attachments).toHaveLength(0)
    expect(errors).toEqual(['Unsupported media type'])
  })

  it('does not stop the files after it', async () => {
    uploadChatMedia.mockRejectedValueOnce(new Error('nope'))
    const { attachments, errors } = await prepareFiles(
      [file('shot.png', 'image/png'), file('notes.md', 'text/markdown')],
      ctx,
    )
    expect(attachments).toHaveLength(1)
    expect(errors).toHaveLength(1)
  })
})
