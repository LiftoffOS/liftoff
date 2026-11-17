import { Storage } from '@google-cloud/storage';
import { randomUUID } from 'crypto';

const SIGNED_URL_TTL_MS = 10 * 60 * 1000;

// Lazy singleton — constructing the GCS client at module load runs at import
// time, which (a) fails in unit tests that pull this in transitively and (b)
// would do credential resolution work even when no screenshot is ever taken.
let storage: Storage | null = null;
function getStorage(): Storage {
  return (storage ??= new Storage());
}

function bucketName(): string {
  return process.env.BROWSER_SCREENSHOT_BUCKET!;
}

// Upload a PNG to GCS and return the durable object path. Pure write — no
// signing, no URL minting. Callers that need a one-shot signed URL alongside
// the upload use `uploadScreenshotAndSign`; callers that persist the object
// path for later re-signing (the paused-frame UX) use this directly.
export async function uploadScreenshot(args: {
  tenantId: string;
  vendorSessionId: string;
  png: Buffer;
}): Promise<{ objectPath: string }> {
  const objectPath = `tenants/${args.tenantId}/${args.vendorSessionId}/${randomUUID()}.png`;
  const file = getStorage().bucket(bucketName()).file(objectPath);
  await file.save(args.png, {
    contentType: 'image/png',
    resumable: false,
    metadata: { cacheControl: 'private, max-age=0, no-store' },
  });
  return { objectPath };
}

// Re-sign a previously uploaded object. Used by the proto mapper to mint a
// fresh signed URL for last_screenshot_object_path on every read — the prior
// URL has a 10 min TTL and may be stale by the time the frontend hits the
// browser-sessions RPC, so we always sign at read time.
export async function signObjectPath(
  objectPath: string,
): Promise<{ url: string; expiresAt: Date }> {
  const file = getStorage().bucket(bucketName()).file(objectPath);
  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_MS);
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: expiresAt,
    version: 'v4',
  });
  return { url, expiresAt };
}

// One-shot upload + sign. Kept as the canonical entry point for handlers that
// need both a persistable object path AND a fresh signed URL in the same call
// (read_active_browser_session, GetPageState). Returns `objectPath` so the
// caller can persist it via repo.setLastScreenshot without making a second
// signing round-trip.
export async function uploadScreenshotAndSign(args: {
  tenantId: string;
  vendorSessionId: string;
  png: Buffer;
}): Promise<{ url: string; expiresAt: Date; objectPath: string }> {
  const { objectPath } = await uploadScreenshot(args);
  const signed = await signObjectPath(objectPath);
  return { ...signed, objectPath };
}
