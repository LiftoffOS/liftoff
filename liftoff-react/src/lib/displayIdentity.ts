// Whose name, email and face the workspace chrome shows.
//
// Two identities exist at once during a support delegation session. `account`
// is the backend account the request is ANSWERED as, which under delegation is
// the customer. `user` is the Firebase user, which stays the OPERATOR for the
// whole session because their credential is never swapped.
//
// Every identity surface in the app was written as `account?.x || user?.x`,
// which is right when those are the same person and wrong the moment they are
// not. The name resolved to the customer while the email underneath it stayed
// the operator's, and the avatar fell back to the operator's photo. The result
// was a sidebar that described two different people at once.
//
// So under delegation there is no fallback: if the customer's account has no
// value for a field, the answer is "nothing", never the operator's. An empty
// avatar is a smaller lie than somebody else's face.

import type { User } from 'firebase/auth'
import { isDelegating } from './supportDelegation'

interface AccountLike {
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  avatarUrl?: string | null
}

export interface DisplayIdentity {
  /** Short label for the collapsed chrome. Never empty. */
  name: string
  /** Full name when both parts are known, for initials. Null otherwise. */
  fullName: string | null
  email: string | null
  avatarUrl: string | null
}

export function displayIdentity(
  account: AccountLike | null | undefined,
  user: Pick<User, 'displayName' | 'email' | 'photoURL'> | null | undefined,
): DisplayIdentity {
  // The operator is only a legitimate fallback when the operator IS the subject.
  const fallback = isDelegating() ? null : user

  const name =
    account?.firstName ||
    fallback?.displayName ||
    account?.email?.split('@')[0] ||
    fallback?.email?.split('@')[0] ||
    'User'

  const fullName =
    account?.firstName && account?.lastName
      ? `${account.firstName} ${account.lastName}`
      : fallback?.displayName ?? null

  return {
    name,
    fullName,
    email: account?.email ?? fallback?.email ?? null,
    avatarUrl: account?.avatarUrl ?? fallback?.photoURL ?? null,
  }
}
