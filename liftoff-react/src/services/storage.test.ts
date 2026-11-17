// A profile photo upload must never invalidate a URL something else already
// holds. The download token IS the credential in the URL, replacing an object
// rotates it, and dev and prod share one bucket, so a fixed object name means an
// upload in one environment 403s the other. These assert the two properties that
// prevent it: every upload is a new object, and the one legacy shared object is
// never deleted.
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeRef {
  path: string
}

const uploadBytes = vi.fn(async (_ref: FakeRef, _data: Blob): Promise<void> => undefined)
const deleteObject = vi.fn(async (_ref: FakeRef): Promise<void> => undefined)

vi.mock('firebase/storage', () => ({
  getStorage: vi.fn(() => ({ name: 'fake-storage' })),
  ref: vi.fn((_storage: unknown, path: string): FakeRef => ({ path })),
  uploadBytes,
  deleteObject,
  getDownloadURL: vi.fn(
    async (refArg: FakeRef) =>
      `https://firebasestorage.googleapis.com/v0/b/YOUR_WEB_PROJECT.firebasestorage.app/o/${encodeURIComponent(
        refArg.path,
      )}?alt=media&token=11111111-2222-3333-4444-555555555555`,
  ),
}))

const { uploadProfilePhoto, deleteProfilePhotoByUrl, profilePhotoPathFromUrl } = await import(
  './storage'
)

const UID = 'F6wbR2SXrBhe6aMT398J38pNzb53'

function downloadUrl(objectPath: string, token = 'tok'): string {
  return `https://firebasestorage.googleapis.com/v0/b/YOUR_WEB_PROJECT.firebasestorage.app/o/${encodeURIComponent(
    objectPath,
  )}?alt=media&token=${token}`
}

function fakeFile(): File {
  return new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' })
}

beforeEach(() => {
  uploadBytes.mockClear()
  deleteObject.mockClear()
})

describe('uploadProfilePhoto', () => {
  it('writes a new object every time, so no stored URL is invalidated', async () => {
    const first = await uploadProfilePhoto(UID, fakeFile())
    const second = await uploadProfilePhoto(UID, fakeFile())

    expect(profilePhotoPathFromUrl(first)).not.toBe(profilePhotoPathFromUrl(second))
  })

  it('never writes the legacy shared object name', async () => {
    const url = await uploadProfilePhoto(UID, fakeFile())

    expect(profilePhotoPathFromUrl(url)).not.toBe(`profile-photos/${UID}/avatar`)
  })

  it('keeps the owner uid as the segment storage.rules checks', async () => {
    const url = await uploadProfilePhoto(UID, fakeFile())
    const segments = profilePhotoPathFromUrl(url)!.split('/')

    // storage.rules matches /profile-photos/{userId}/{fileName} and compares
    // request.auth.uid to {userId}; a deeper path moves that check off the uid.
    expect(segments).toHaveLength(3)
    expect(segments[0]).toBe('profile-photos')
    expect(segments[1]).toBe(UID)
    expect(segments[2]).toBeTruthy()
  })
})

describe('profilePhotoPathFromUrl', () => {
  it('reads the object path out of a download URL', () => {
    expect(profilePhotoPathFromUrl(downloadUrl(`profile-photos/${UID}/abc-123`))).toBe(
      `profile-photos/${UID}/abc-123`,
    )
  })

  it('does not claim a Google account photo', () => {
    expect(profilePhotoPathFromUrl('https://lh3.googleusercontent.com/a/ACg8ocK')).toBeNull()
  })

  it('does not claim an object outside the profile-photo prefix', () => {
    expect(profilePhotoPathFromUrl(downloadUrl('generated-files/x/y'))).toBeNull()
  })

  it('returns null for a URL it cannot parse', () => {
    expect(profilePhotoPathFromUrl('not a url')).toBeNull()
    expect(profilePhotoPathFromUrl('')).toBeNull()
  })
})

describe('deleteProfilePhotoByUrl', () => {
  it('removes the object the superseded URL named', async () => {
    await deleteProfilePhotoByUrl(downloadUrl(`profile-photos/${UID}/abc-123`))

    expect(deleteObject).toHaveBeenCalledWith(
      expect.objectContaining({ path: `profile-photos/${UID}/abc-123` }),
    )
  })

  it('refuses the legacy shared object, which both environments still name', async () => {
    await deleteProfilePhotoByUrl(downloadUrl(`profile-photos/${UID}/avatar`))

    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('does nothing for an absent or foreign URL', async () => {
    await deleteProfilePhotoByUrl(null)
    await deleteProfilePhotoByUrl(undefined)
    await deleteProfilePhotoByUrl('https://lh3.googleusercontent.com/a/ACg8ocK')

    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('stays quiet when the object is already gone', async () => {
    deleteObject.mockRejectedValueOnce(new Error('storage/object-not-found'))

    await expect(
      deleteProfilePhotoByUrl(downloadUrl(`profile-photos/${UID}/abc-123`)),
    ).resolves.toBeUndefined()
  })
})
