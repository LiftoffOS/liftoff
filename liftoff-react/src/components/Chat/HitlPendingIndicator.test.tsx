import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { HitlPendingIndicator } from './HitlPendingIndicator'

// Threads are shared, so the person who triggers a gate is usually not the one
// who can clear it. This used to tell them "waiting on your review" regardless,
// and told everyone else nothing — a stalled thread that looked broken rather
// than blocked.

describe('HitlPendingIndicator', () => {
  it('asks you to review when it is yours to clear', () => {
    render(<HitlPendingIndicator onOpenReview={vi.fn()} isForYou routedTo={['Ada Lovelace']} />)
    expect(screen.getByText('Waiting on your review to continue')).toBeInTheDocument()
    expect(screen.getByText('Review')).toBeInTheDocument()
  })

  it('names the person it is waiting on when it is not yours', () => {
    render(<HitlPendingIndicator onOpenReview={vi.fn()} routedTo={['Ada Lovelace']} />)
    expect(screen.getByText('Waiting on Ada Lovelace to approve')).toBeInTheDocument()
    // Softer call to action: it is not this reader's to clear.
    expect(screen.getByText('View')).toBeInTheDocument()
  })

  it('names two people in full', () => {
    render(<HitlPendingIndicator onOpenReview={vi.fn()} routedTo={['Ada', 'Grace']} />)
    expect(screen.getByText('Waiting on Ada and Grace to approve')).toBeInTheDocument()
  })

  it('summarises a longer list rather than growing without bound', () => {
    render(<HitlPendingIndicator onOpenReview={vi.fn()} routedTo={['Ada', 'Grace', 'Alan', 'Katherine']} />)
    expect(screen.getByText('Waiting on Ada, Grace and 2 others to approve')).toBeInTheDocument()
  })

  // No assignee could approve, so it fell through. Describing that by role is
  // more honest than naming whichever admins happen to exist.
  it('describes an admin fallback by role', () => {
    render(<HitlPendingIndicator onOpenReview={vi.fn()} routedToAdmins />)
    expect(screen.getByText('Waiting on a workspace admin to approve')).toBeInTheDocument()
  })

  // Nobody owns the agent, so it belongs to whoever is looking. Second person
  // on purpose: "a workspace member" describes somebody else, and when nobody
  // owns a thing, everyone assuming somebody else will act is how it sits
  // unactioned forever.
  it('makes an unassigned agent your review when you can act', () => {
    render(<HitlPendingIndicator onOpenReview={vi.fn()} unassigned canApprove />)
    expect(screen.getByText('Waiting on your review to continue')).toBeInTheDocument()
    expect(screen.getByText('Review')).toBeInTheDocument()
  })

  // Same broken promise as a button that throws: do not tell somebody a
  // decision is theirs when their role cannot make it.
  it('does not claim an unassigned request is yours when you cannot approve', () => {
    render(<HitlPendingIndicator onOpenReview={vi.fn()} unassigned canApprove={false} />)
    expect(screen.getByText('Waiting on a workspace admin to approve')).toBeInTheDocument()
    expect(screen.getByText('View')).toBeInTheDocument()
  })

  // Without this the people responsible learn less than a bystander does: Ada
  // would see only "your review" and never know Grace was asked too.
  it('tells you who else was asked when several of you were', () => {
    render(
      <HitlPendingIndicator
        onOpenReview={vi.fn()}
        isForYou
        routedTo={['You', 'Grace Hopper']}
      />,
    )
    expect(screen.getByText('Waiting on you and Grace Hopper')).toBeInTheDocument()
  })

  // Route resolution is best-effort on the backend; if it yielded nothing we
  // say what is true rather than naming the wrong person.
  it('stays vague when no route was resolved', () => {
    render(<HitlPendingIndicator onOpenReview={vi.fn()} />)
    expect(screen.getByText('Waiting on a review to continue')).toBeInTheDocument()
  })

  it('opens the queue for anyone, including people it is not routed to', () => {
    const onOpenReview = vi.fn()
    render(<HitlPendingIndicator onOpenReview={onOpenReview} routedTo={['Ada']} />)
    fireEvent.click(screen.getByText('View'))
    expect(onOpenReview).toHaveBeenCalled()
  })
})
