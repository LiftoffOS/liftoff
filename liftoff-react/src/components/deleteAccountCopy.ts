import type { DeletionPreflight } from '../services/account'

export type Shape = 'block_sub' | 'block_invoice' | 'confirm_delete'
export function chooseShape(p: DeletionPreflight): Shape {
  if (p.hasActiveSubscription) return 'block_sub'
  if (p.hasOutstandingInvoice) return 'block_invoice'
  return 'confirm_delete'
}
// Composes the consequence body for the confirm-delete shape. See §5.2.1 of
// the deletion plan for the rule table; this implementation mirrors it
// exactly so the strings render predictably regardless of which optional
// sentences precede the fixed closer.
export function composeBody(shape: Shape, p: DeletionPreflight): string {
  if (shape === 'block_sub') {
    return 'This account has an active subscription. Please cancel it in Billing before deleting your account.'
  }
  if (shape === 'block_invoice') {
    return 'This account has an outstanding balance. Please pay it in Billing before deleting your account.'
  }
  const parts: string[] = []
  const X = p.orphanWorkspaceCount
  const P = p.lostAccessCount
  const Y = p.memberOfWorkspaceCount

  // Sentence 1: workspaces other people lose access to.
  if (X > 0) {
    if (X === 1) {
      if (P === 1) parts.push('1 person will lose access to your workspace.')
      else parts.push(`${P} people will lose access to your workspace.`)
    } else {
      if (P === 1) parts.push(`1 person will lose access to ${X} of your workspaces.`)
      else parts.push(`${P} people will lose access to ${X} of your workspaces.`)
    }
  }

  // Sentence 2: workspaces this user is a member of (and will drop out of).
  // "also" / "other" qualifiers appear only when Sentence 1 was rendered.
  if (Y > 0) {
    const sentence1Present = parts.length > 0
    if (Y === 1) {
      parts.push(sentence1Present
        ? 'You will also be removed from another workspace you belong to.'
        : 'You will be removed from the workspace you belong to.')
    } else {
      parts.push(sentence1Present
        ? `You will also be removed from ${Y} other workspaces you belong to.`
        : `You will be removed from ${Y} workspaces you belong to.`)
    }
  }

  // Sentences 3 + 4: fixed closer.
  parts.push('Are you sure you want to delete your account?')
  parts.push('This action cannot be undone.')
  return parts.join(' ')
}
