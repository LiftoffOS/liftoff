// The addresses this deployment sends mail FROM, in one place.
//
// Why this is not a constant: the sending domain belongs to whoever runs the
// install, and it is the one piece of mail configuration that cannot be
// defaulted. Resend (and every other provider worth using) will only sign mail
// for a domain the account has verified, so a hard-coded
// `noreply@<someone-else>` does not quietly send from the wrong place — it
// fails every send, which means no invitation, no password reset and no signup
// approval. Those are the paths a fresh install needs most.
//
// So MAIL_FROM_ADDRESS has no default and `mailFrom()` throws without it, the
// same discipline control-plane-url.ts and webhook-base-url.ts apply to their
// hostnames. The display name does default, because a wrong display name is
// cosmetic where a wrong address is fatal.

/** Display name on outbound mail. Cosmetic, so it defaults. */
function mailFromName(): string {
  return (process.env.MAIL_FROM_NAME ?? 'Liftoff').replace(/[\r\n"<>]/g, '').trim() || 'Liftoff';
}

/**
 * The bare address outbound mail is sent from — `noreply@example.com`, no
 * display name and no angle brackets.
 *
 * Throws when unset. A provider cannot sign mail for a domain it has not
 * verified, so there is no address that works by default.
 */
function mailFromAddress(): string {
  const raw = process.env.MAIL_FROM_ADDRESS?.trim();
  if (!raw) {
    throw new Error(
      'MAIL_FROM_ADDRESS is unset, so no email can be sent. Set it to an address on a ' +
      'domain verified with your email provider (for Resend: Domains → Add Domain, then ' +
      'MAIL_FROM_ADDRESS=noreply@yourdomain.com). Optional companions: MAIL_FROM_NAME, ' +
      'MAIL_REPLY_TO_ADDRESS, MAIL_SIGNUP_NOTIFICATION_ADDRESS — see .env.example.',
    );
  }
  return raw;
}

/** `Name <address>`, ready for a From header. */
export function mailFrom(displayName?: string): string {
  const name = (displayName ?? '').replace(/[\r\n"<>]/g, '').trim().slice(0, 100) || mailFromName();
  return `"${name}" <${mailFromAddress()}>`;
}

/**
 * Where replies go. Falls back to the From address rather than to a support
 * mailbox nobody in this install reads.
 */
export function mailReplyToAddress(): string {
  return process.env.MAIL_REPLY_TO_ADDRESS?.trim() || mailFromAddress();
}

/**
 * Who gets told when somebody signs up, or null when nobody should be.
 *
 * Null is a supported answer and not a degraded one: the signup-approval page
 * is the surface that matters, and an install with no operations mailbox should
 * not have its signups mailed to whatever address was in the source. The
 * notification is skipped rather than sent somewhere arbitrary.
 */
export function signupNotificationAddress(): string | null {
  return process.env.MAIL_SIGNUP_NOTIFICATION_ADDRESS?.trim() || null;
}
