// Firebase Storage Service
// Handles profile photo uploads to Firebase Storage

import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { app } from '../config/firebase'

const storage = getStorage(app)

const PROFILE_PHOTO_PREFIX = 'profile-photos'

// The host getDownloadURL() mints its URLs on. Anything else is not an object we
// put in the bucket, so it is not an object we may delete.
const DOWNLOAD_URL_HOST = 'firebasestorage.googleapis.com'

// The fixed filename uploads used before uploads became unique. Environments
// that share one Firebase project share one bucket, so this single object can be
// named by more than one environment's accounts.avatar_url. Removing it would
// blank the avatar wherever it has not been re-uploaded since, so nothing here
// may delete it.
const SHARED_LEGACY_FILENAME = 'avatar'

/**
 * Upload a profile photo and return the download URL to store against the
 * account.
 *
 * Every upload is a NEW object. Replacing one rotates its
 * `firebaseStorageDownloadTokens`, and that token is the only credential the
 * download URL carries, so a replacement turns every URL already stored against
 * the old object into a 403 — in this environment if the account write that
 * follows fails, and in the other environment unconditionally, since the bucket
 * is shared. A unique name per upload means an upload cannot invalidate a URL
 * anything else still holds.
 *
 * The unique part is one path segment on purpose: `storage.rules` matches
 * `/profile-photos/{userId}/{fileName}` and checks `request.auth.uid == userId`,
 * so a deeper path would move the owner check onto the wrong segment. Content
 * type rides on the blob, which is why no extension is needed.
 */
export async function uploadProfilePhoto(userId: string, file: File): Promise<string> {
  const storageRef = ref(storage, `${PROFILE_PHOTO_PREFIX}/${userId}/${crypto.randomUUID()}`)
  await uploadBytes(storageRef, file)
  return getDownloadURL(storageRef)
}

/**
 * The bucket-relative object path a profile-photo download URL names, or null
 * when the URL is not one: a Google account photo, a data URL, or anything
 * outside the profile-photo prefix.
 */
export function profilePhotoPathFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname !== DOWNLOAD_URL_HOST) return null

  // The object path sits after `/o/`, percent-encoded as one segment. Read it
  // off `pathname` so the `?alt=media&token=` half cannot leak into it.
  const marker = '/o/'
  const start = parsed.pathname.indexOf(marker)
  if (start === -1) return null

  const encoded = parsed.pathname.slice(start + marker.length)
  if (!encoded) return null

  let path: string
  try {
    path = decodeURIComponent(encoded)
  } catch {
    return null
  }

  const segments = path.split('/')
  if (segments.length !== 3) return null
  if (segments[0] !== PROFILE_PHOTO_PREFIX) return null
  if (!segments[1] || !segments[2]) return null

  return path
}

/**
 * Delete the object a superseded download URL pointed at.
 *
 * Call this only once the account names the replacement: until that write
 * lands, the previous object is what every surface still renders. Best effort by
 * design — the photo has already been changed successfully, so a failure here is
 * a stale object rather than anything the person needs to hear about.
 *
 * Refuses the legacy shared filename, and refuses any URL it cannot resolve to a
 * `profile-photos/<uid>/<file>` object.
 */
export async function deleteProfilePhotoByUrl(previousUrl: string | null | undefined): Promise<void> {
  if (!previousUrl) return

  const path = profilePhotoPathFromUrl(previousUrl)
  if (!path) return
  if (path.split('/')[2] === SHARED_LEGACY_FILENAME) return

  try {
    await deleteObject(ref(storage, path))
  } catch {
    // Already gone, or the rules refused it. Either way there is nothing to
    // repair and nothing to report.
  }
}
