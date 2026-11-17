import { useCallback, useState } from 'react'

/**
 * An avatar photo URL, withdrawn once the browser has failed to load it.
 *
 * Every surface that renders a person already falls back to their initials, and
 * then to a person icon, when we hold no photo. That branch is chosen on the URL
 * being present alone, so a photo that is present but unloadable — a Firebase
 * Storage token that has been rotated, an expired Google photo, a dropped
 * connection — leaves an empty circle instead, and keeps it until the component
 * remounts. This puts the load result into that decision.
 *
 * Keyed on the URL rather than a bare boolean, so a photo that changes is tried
 * again instead of inheriting the previous one's failure.
 */
export function useAvatarImage(avatarUrl: string | null | undefined): {
  src: string | null
  onError: () => void
} {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const src = avatarUrl && avatarUrl !== failedUrl ? avatarUrl : null

  const onError = useCallback(() => {
    if (src) setFailedUrl(src)
  }, [src])

  return { src, onError }
}
