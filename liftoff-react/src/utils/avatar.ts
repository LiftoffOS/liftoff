// Shared avatar helpers.
//
// Used by the workspace member row on the dashboard home page and by the
// sender avatar on chat messages, so a person renders the same way wherever
// their avatar appears.

// Get initials from first and last name, returns null if no name
export function getInitials(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string | null {
  const initials = `${(firstName ?? '').charAt(0)}${(lastName ?? '').charAt(0)}`.toUpperCase()
  return initials.length > 0 ? initials : null
}

// Same, for surfaces that only hold one combined name string (a Firebase
// displayName, say). Returns null rather than guessing from an email address.
export function getInitialsFromName(name: string | null | undefined): string | null {
  if (!name) return null
  const parts = name.trim().split(' ').filter(part => part.length > 0)
  if (parts.length === 0) return null
  if (parts.length >= 2) {
    // First and last name initials
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  }
  // Just first name - use first letter only
  return parts[0][0].toUpperCase()
}

// Avatar color palette - distinct, accessible colors with matching text colors
const AVATAR_COLORS = [
  { bg: '#e0e7ff', text: '#4338ca' }, // Indigo
  { bg: '#dbeafe', text: '#1d4ed8' }, // Blue
  { bg: '#d1fae5', text: '#047857' }, // Emerald
  { bg: '#fef3c7', text: '#b45309' }, // Amber
  { bg: '#fce7f3', text: '#be185d' }, // Pink
  { bg: '#e0f2fe', text: '#0369a1' }, // Sky
  { bg: '#f3e8ff', text: '#7c3aed' }, // Purple
  { bg: '#dcfce7', text: '#15803d' }, // Green
  { bg: '#ffedd5', text: '#c2410c' }, // Orange
  { bg: '#fae8ff', text: '#a21caf' }, // Fuchsia
]

// Get consistent color for a member based on their ID
export function getAvatarColor(memberId: string): { bg: string; text: string } {
  let hash = 0
  for (let i = 0; i < memberId.length; i++) {
    hash = memberId.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

// Human-readable label for a person: their name when we have one, otherwise
// their email address.
export function getDisplayName(person: {
  firstName?: string | null
  lastName?: string | null
  email: string
}): string {
  const name = [person.firstName, person.lastName].filter(Boolean).join(' ').trim()
  return name || person.email
}
