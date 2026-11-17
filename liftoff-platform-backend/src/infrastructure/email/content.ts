// Email content definitions
// Add new email types here

export interface EmailContent {
  subject: string;
  preheader: string;
  headingPrefix: string;
  paragraphs?: string[];
  bodyTemplate?: string;
  rawHtml?: string;
  listIntro?: string;
  listItems?: string[];
  closingParagraph?: string;
  signatureParagraphs?: string[];
  cta?: {
    text: string;
    url: string;
  };
  ctaPosition?: 'before-list' | 'after-signature';
}

export const EMAIL_CONTENT: Record<string, EmailContent> = {
  'email-verification': {
    subject: 'Verify your new email address - Liftoff',
    preheader: 'Verify your new email address for Liftoff',
    headingPrefix: 'Hi, ',
    paragraphs: [
      'You requested to change your email address. Click the button below to verify your new email:',
    ],
    cta: {
      text: 'Verify Email Address',
      url: '{verificationUrl}',
    },
    ctaPosition: 'before-list',
    signatureParagraphs: [
      'Or copy and paste this link into your browser:',
      '{verificationUrl}',
      'This link will expire in 24 hours.',
    ],
    closingParagraph: 'If you did not request this change, you can safely ignore this email.',
  },

  // Initial signup email-verification (distinct from 'email-verification',
  // which is the email-CHANGE flow for existing accounts). The link inside is
  // a Firebase email-verification action link generated server-side; clicking
  // it flips the Firebase user's email_verified claim. Delivered via Resend.
  'signup-verification': {
    subject: 'Confirm your email address - Liftoff',
    preheader: 'Confirm your email to finish setting up your Liftoff account',
    headingPrefix: 'Welcome, ',
    paragraphs: [
      'Thank you for signing up for Liftoff. Please confirm your email address to finish setting up your account.',
    ],
    cta: {
      text: 'Confirm Email',
      url: '{verificationUrl}',
    },
    ctaPosition: 'before-list',
    signatureParagraphs: [
      'Or copy and paste this link into your browser:',
      '{verificationUrl}',
    ],
    closingParagraph: 'If you did not create a Liftoff account, you can safely ignore this email.',
  },

  'welcome': {
    subject: 'Welcome to Liftoff',
    preheader: 'Welcome to the Operating System for Agents',
    headingPrefix: 'Welcome, ',
    paragraphs: [
      'We are excited to have you on board. Liftoff is where you hand off work and an agent owns it.',
      'Head over to Liftoff. Describe the job you want done, and the agent does the rest.',
    ],
    cta: {
      text: 'Get Started',
      url: '{frontendUrl}/dashboard',
    },
  },

  'password-reset': {
    subject: 'Reset your password - Liftoff',
    preheader: 'Reset your Liftoff account password',
    headingPrefix: 'Hi, ',
    paragraphs: [
      'We received a request to reset your password. Click the button below to create a new password:',
    ],
    cta: {
      text: 'Reset Password',
      url: '{resetUrl}',
    },
    signatureParagraphs: [
      'This link will expire in 1 hour.',
      'If you did not request a password reset, you can safely ignore this email.',
    ],
  },

  'team-invite': {
    subject: 'You have been invited to join a team on Liftoff',
    preheader: 'Join your team on Liftoff',
    headingPrefix: 'Hi, ',
    paragraphs: [
      'You have been invited to join {teamName} on Liftoff.',
      'Click the button below to accept the invitation and join the team:',
    ],
    cta: {
      text: 'Accept Invitation',
      url: '{inviteUrl}',
    },
    signatureParagraphs: [
      'This invitation will expire in 7 days.',
    ],
  },

  // Sent by the daily invite-expiry sweep (jobs/invite-expiry-sweep.ts) to an
  // inviter when one or more people they invited let their invitation lapse
  // (invitations expire 7 days after they are sent). The invitee list and its
  // intro are passed as rawHtml by sendInvitesExpiredEmail; this entry supplies
  // the subject, heading, CTA and closing. ctaPosition 'before-list' places the
  // button right after the rawHtml body, ahead of the closing paragraph.
  'invites-expired': {
    subject: 'Re-invite your team to {teamName}',
    preheader: 'The people you invited to {teamName} have not accepted your invitations yet',
    headingPrefix: 'Hi, ',
    cta: {
      text: 'Re-invite them',
      url: '{inviteUrl}',
    },
    ctaPosition: 'before-list',
    closingParagraph:
      'If you no longer need these people in your Liftoff workspace, you can safely ignore this message.',
  },

  // Sent by the reminder sweep (jobs/invite-reminder-sweep.ts) to the RECIPIENT
  // of a still-pending invitation, 2 to 3 days before it expires. Button
  // first (immediate action), then the supporting/urgency line. The intro (who
  // invited them) is passed as rawHtml by sendInviteReminderEmail, which handles
  // a missing inviter name; heading has no name because the recipient is a
  // non-user we have no name for.
  'invite-reminder': {
    subject: 'Your invitation to {teamName} expires on {expiryDate}',
    preheader: 'Your invitation to {teamName} has not been accepted yet',
    headingPrefix: 'Your invitation to {teamName}',
    cta: {
      text: 'Accept invitation',
      url: '{inviteUrl}',
    },
    ctaPosition: 'before-list',
    closingParagraph: 'Accept it to join the workspace. This invitation expires on {expiryDate}.',
  },

  // [SE-007] Ownership transfer confirmation email
  'ownership-transfer': {
    subject: 'Confirm ownership transfer - Liftoff',
    preheader: 'Action required: Confirm ownership transfer for your workspace',
    headingPrefix: 'Hi, ',
    paragraphs: [
      'You have initiated an ownership transfer for {tenantName}.',
      'You are transferring ownership to {newOwnerName} ({newOwnerEmail}).',
      'Click the button below to confirm this transfer:',
    ],
    cta: {
      text: 'Confirm Transfer',
      url: '{confirmUrl}',
    },
    signatureParagraphs: [
      'Important: This action cannot be undone. Once confirmed, you will be demoted to admin.',
      'This link will expire in {expiresIn}.',
      "If you did not initiate this transfer, please secure your account immediately.",
    ],
  },

  // Internal: invite request notification
  'invite-request': {
    subject: 'New Invite Request',
    preheader: 'A new invite request has been submitted',
    headingPrefix: 'Invite Request from ',
  },

  // Sent by POST /api/referrals/invites to somebody a paying workspace wants to
  // recommend Liftoff to. The body — what the offer is, and the sender's own
  // note if they wrote one — arrives as rawHtml from sendReferralInviteEmail,
  // which is also where the note is escaped. ctaPosition 'before-list' puts the
  // button under that body and ahead of the closing line.
  //
  // The heading carries no recipient name because there is none: this goes to a
  // person who has never used Liftoff, and the only thing known about them is
  // the address the sender typed.
  'referral-invite': {
    subject: '{teamName} invites you to try Liftoff',
    preheader: 'Start with {refereeBonusUsd} of Liftoff usage on the house',
    headingPrefix: 'An invitation from {teamName}',
    cta: {
      text: 'See what Liftoff does',
      url: '{inviteUrl}',
    },
    ctaPosition: 'before-list',
    // Kept short deliberately. This is a cold message to an address that never
    // opted in, so the no-action-needed line earns its place. The half that used
    // to follow it, "and you will not hear from us again about it", was removed
    // because it is not true: the already-invited guard is per tenant, so a
    // different workspace can invite the same person.
    closingParagraph: 'If this is not for you, no action is needed.',
  },

  // Same email, for when there is nobody to name. The referrer's account has no
  // first or last name AND their workspace is still on one of the two defaults
  // from tenants/service.ts, so "{teamName} invites you" would read
  // "Personal Workspace invites you to try Liftoff". The two conditions travel
  // together: a missing first name is itself what produces 'Personal Workspace'.
  // Everything else is identical, including the emailType tag, so this does not
  // split the metrics.
  'referral-invite-unnamed': {
    subject: 'You have been invited to try Liftoff',
    preheader: 'Start with {refereeBonusUsd} of Liftoff usage on the house',
    headingPrefix: 'An invitation to try Liftoff',
    cta: {
      text: 'See what Liftoff does',
      url: '{inviteUrl}',
    },
    ctaPosition: 'before-list',
    closingParagraph: 'If this is not for you, no action is needed.',
  },

  // Internal: new-signup notification sent to MAIL_SIGNUP_NOTIFICATION_ADDRESS with
  // Approve/Waitlist actions. The body (info table + buttons, or an
  // already-has-access note) is supplied via rawHtml by sendSignupNotification;
  // the subject is overridden per-signup by that caller (like invite-request).
  'signup-notification': {
    subject: 'New signup',
    preheader: 'A new user signed up for Liftoff',
    headingPrefix: 'New signup',
  },

  // Internal: demo/contact form notification
  'contact-form': {
    subject: 'New Demo Request',
    preheader: 'A new demo request has been submitted',
    headingPrefix: 'Demo Request from ',
  },

  'subscription-confirmation': {
    subject: 'Your Liftoff plan is active',
    preheader: 'Your {planName} plan is now active.',
    headingPrefix: 'Your Liftoff plan is active, ',
    bodyTemplate: 'Your {planName} plan ({billingSummary}) is now active. {promoSummary}Your agents have everything they need to get to work.',
    cta: { text: 'Go to Dashboard', url: '{frontendUrl}/dashboard' },
    ctaPosition: 'before-list',
    listIntro: 'With your {planName} plan, you have:',
    listItems: [
      'Unlimited agents',
      'Unlimited integrations',
      'Workflow orchestration',
      'Real-time visibility',
      'Governance controls',
      'Human oversight and control',
    ],
  },

  'subscription-ending': {
    subject: 'Your Liftoff plan is ending soon',
    preheader: 'Your {planName} plan has been canceled. You will continue to have access until {accessEndsDate}.',
    headingPrefix: 'Hi, ',
    paragraphs: [
      'Your {planName} plan has been canceled. You will continue to have access to all paid features until {accessEndsDate}.',
    ],
    cta: { text: 'Resubscribe', url: '{frontendUrl}/dashboard/settings/billing' },
    ctaPosition: 'before-list',
    closingParagraph: 'If you change your mind, you can resubscribe anytime before {accessEndsDate} in Settings.',
  },

  'subscription-ending-7d': {
    subject: 'Your Liftoff plan ends in 7 days',
    preheader: 'Your {planName} plan ends on {accessEndsDate}. Resubscribe to keep your agents running.',
    headingPrefix: 'Hi, ',
    paragraphs: [
      'Your {planName} plan ends in 7 days on {accessEndsDate}. After that, your agents will be unable to run and your workspace will lose access to paid features.',
    ],
    cta: { text: 'Resubscribe', url: '{frontendUrl}/dashboard/settings/billing' },
    ctaPosition: 'before-list',
    closingParagraph: 'If you change your mind, you can resubscribe anytime before {accessEndsDate} in Settings.',
  },

  'subscription-ending-1d': {
    subject: 'Your Liftoff plan ends tomorrow',
    preheader: 'Your {planName} plan ends tomorrow on {accessEndsDate}.',
    headingPrefix: 'Hi, ',
    paragraphs: [
      'Your {planName} plan ends tomorrow on {accessEndsDate}. After that, your agents will be unable to run and your workspace will lose access to paid features.',
    ],
    cta: { text: 'Resubscribe', url: '{frontendUrl}/dashboard/settings/billing' },
    ctaPosition: 'before-list',
    closingParagraph: 'After {accessEndsDate}, you can still resubscribe, but your agents will be paused in the meantime.',
  },

  'subscription-ended': {
    subject: 'Your Liftoff plan has ended',
    preheader: 'Resubscribe anytime to resume your agents.',
    headingPrefix: 'Your Liftoff plan has ended, ',
    paragraphs: [
      'Your {planName} plan ended on {accessEndedDate}. Your workspace is preserved. If you would like to run your agents again, you can resubscribe at any time in Settings.',
    ],
    cta: { text: 'Resubscribe', url: '{frontendUrl}/dashboard/settings/billing' },
    ctaPosition: 'before-list',
    closingParagraph: 'Thank you for being with Liftoff.',
  },

  'card-expiring': {
    subject: 'Your credit card on file is expiring soon',
    preheader: 'Your {cardBrand} credit card ending in {cardLast4} expires {cardExpMonth}/{cardExpYear}. Update it to avoid interruption.',
    headingPrefix: 'Hi, ',
    paragraphs: [
      'Your {cardBrand} credit card ending in {cardLast4} on file with Liftoff expires on {cardExpMonth}/{cardExpYear}.',
      'After this date, charges to this credit card will fail. Update your credit card to avoid any interruption to your Liftoff plan or agents.',
    ],
    cta: { text: 'Update Credit Card', url: '{frontendUrl}/dashboard/settings/billing' },
    ctaPosition: 'before-list',
  },

  'agents-stalled-credit-depleted': {
    subject: 'Action required: Your agents are unable to run',
    preheader: 'Your Liftoff workspace requires attention to resume your agents.',
    headingPrefix: 'Hi, ',
    paragraphs: [
      'Your agents are unable to run. You have used all the Operating Units in your {planName} plan and your credit balance has reached $0.',
    ],
    cta: { text: 'Add Credit', url: '{frontendUrl}/dashboard/settings/billing' },
    ctaPosition: 'before-list',
    closingParagraph: 'Or wait until your Operating Units reset on {nextResetDate}.',
  },

  'receipt': {
    subject: 'Your receipt from Liftoff',
    preheader: 'We charged ${amountUsd} to your {paymentMethodSummary}.',
    headingPrefix: 'Hi, ',
    bodyTemplate: 'We charged ${amountUsd} to your {paymentMethodSummary} to {chargeReason}.',
    cta: { text: 'View Billing', url: '{frontendUrl}/dashboard/settings/billing' },
    ctaPosition: 'after-signature',
  },

  'payment-failed-subscription': {
    subject: 'Action required: Payment failed for your Liftoff workspace',
    preheader: 'Payment failed and your agents are unable to run. Update your payment method to resume your agents.',
    headingPrefix: 'Hi, ',
    paragraphs: [
      'A payment attempt for your Liftoff workspace has failed. Your agents are unable to run until the outstanding balance is resolved.',
      'Outstanding balance: ${outstandingBalanceUsd}',
      'To resume your agents, update your payment method in Settings.',
    ],
    cta: {
      text: 'Update Payment Method',
      url: '{frontendUrl}/dashboard/settings/billing',
    },
    ctaPosition: 'before-list',
    closingParagraph: 'Your agents will automatically resume once the outstanding balance is paid.',
  },

  'payment-failed-auto-reload': {
    subject: 'Action required: Auto-reload failed for your Liftoff workspace',
    preheader: 'Your auto-reload was unsuccessful. Update your payment method to retry.',
    headingPrefix: 'Hi, ',
    paragraphs: [
      'We could not charge your {paymentMethodSummary} for an auto-reload of ${amountUsd}.',
      'Update your payment method to allow auto-reload to retry, or add credit to your credit balance.',
    ],
    cta: {
      text: 'Update Payment Method',
      url: '{frontendUrl}/dashboard/settings/billing',
    },
    ctaPosition: 'before-list',
    closingParagraph: 'Auto-reload will retry automatically once your payment method is updated.',
  },

  // --- Notification emails (realtime + digest + perf recap) ---
  // Body is built dynamically in src/notifications/email.ts via options.rawHtml
  // so the unsubscribe footer is appended uniformly across all six types.
  // Naming convention: in code we say "internal agent" / "external agent"
  // (origin labels). In user-facing copy we render an internal agent as the
  // "agent" with its user-given name (e.g. "Code Reviewer Bot"); external
  // agents render as "External Agents" (not used in these templates).
  'task-update': {
    subject: '{internalAgentName} updated a task on Liftoff',
    preheader: '{eventTitle}',
    headingPrefix: 'Hi, ',
  },

  'team-activity': {
    subject: 'Activity in your Liftoff workspace',
    preheader: '{actorName} took action in your workspace',
    headingPrefix: 'Hi, ',
  },

  'escalation': {
    subject: '{internalAgentName} needs your input on Liftoff',
    preheader: 'An item in your review queue needs your attention',
    headingPrefix: 'Hi, ',
  },

  'daily-digest': {
    subject: 'Your Liftoff daily digest',
    preheader: 'A summary of activity in {digestPeriod}',
    headingPrefix: 'Hi, ',
  },

  'weekly-digest': {
    subject: 'Your Liftoff weekly digest',
    preheader: 'A summary of activity in {digestPeriod}',
    headingPrefix: 'Hi, ',
  },

  'weekly-performance-recap': {
    subject: 'Your Liftoff weekly performance recap',
    preheader: "Last week's performance across your agents",
    headingPrefix: 'Hi, ',
  },

  // Newsletter — operator-composed. Body is operator-supplied HTML via rawHtml.
  'newsletter': {
    subject: '{newsletterSubject}',
    preheader: '{newsletterPreheader}',
    headingPrefix: 'Hi, ',
  },

  // [SE-007] Admin notification about ownership transfer
  'ownership-transfer-notification': {
    subject: 'Ownership transfer initiated - Liftoff',
    preheader: 'An ownership transfer has been initiated for your workspace',
    headingPrefix: 'Hi, ',
    paragraphs: [
      'This is to notify you that an ownership transfer has been initiated for {tenantName}.',
      '{currentOwnerName} is transferring ownership to {newOwnerName}.',
      'If the current owner confirms this transfer, the new owner will have full control of the workspace.',
    ],
    signatureParagraphs: [
      'No action is required from you. This is for your information only.',
      'If you believe this transfer is unauthorized, please contact the current owner immediately.',
    ],
  },
};
