/**
 * R5 Fix 1 (SE-R5-003): TypeScript binding for the openat native addon.
 *
 * Loads the native addon compiled from openat.cc. Provides openatNoFollow()
 * for atomic write-path validation against symlink-swap TOCTOU.
 *
 * On platforms where the native binary isn't available (macOS dev, CI before
 * node-gyp runs), falls back to a throw so callers know to skip the native
 * check and use the walkParentChainNoSymlinkEscape advisory path only.
 */
import path from 'path';

export interface OpenatAddon {
  openatNoFollow: (dirPath: string, basename: string, flags: number) => number;
  O_RDONLY: number;
  O_WRONLY: number;
  O_RDWR: number;
  O_CREAT: number;
  O_EXCL: number;
  O_NOFOLLOW: number;
  O_DIRECTORY: number;
  O_TRUNC: number;
}

let addon: OpenatAddon | null = null;
let loadError: Error | null = null;

function tryLoadAddon(): OpenatAddon | null {
  if (addon) return addon;
  if (loadError) return null;
  try {
    // Resolve from build output
    const addonPath = path.join(__dirname, '..', '..', '..', 'build', 'Release', 'openat.node');
     
    addon = require(addonPath) as OpenatAddon;
    return addon;
  } catch (err) {
    loadError = err as Error;
    return null;
  }
}

export function isOpenatAvailable(): boolean {
  return tryLoadAddon() !== null;
}

export function openatNoFollow(dirPath: string, basename: string, flags: number): number {
  const a = tryLoadAddon();
  if (!a) {
    throw new Error(
      `openat native addon unavailable: ${loadError?.message ?? 'unknown'}. ` +
        'Build with `node-gyp rebuild` in src/workspace/native/.',
    );
  }
  return a.openatNoFollow(dirPath, basename, flags);
}

// Flag constants — fall back to Linux defaults when addon not loaded (for typing).
// Callers should use `isOpenatAvailable()` before relying on these.
const FALLBACK_FLAGS = {
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_EXCL: 128,
  O_NOFOLLOW: 131072,
  O_DIRECTORY: 65536,
  O_TRUNC: 512,
};

function getFlag(name: keyof typeof FALLBACK_FLAGS): number {
  const a = tryLoadAddon();
  return a ? (a[name] as number) : FALLBACK_FLAGS[name];
}

export const O_RDONLY = getFlag('O_RDONLY');
export const O_WRONLY = getFlag('O_WRONLY');
export const O_RDWR = getFlag('O_RDWR');
export const O_CREAT = getFlag('O_CREAT');
export const O_EXCL = getFlag('O_EXCL');
export const O_NOFOLLOW = getFlag('O_NOFOLLOW');
export const O_DIRECTORY = getFlag('O_DIRECTORY');
export const O_TRUNC = getFlag('O_TRUNC');
