// Re-export from email module for backwards compatibility.
// Node's CommonJS resolution prefers `email.ts` over `email/index.ts`, so
// every `from '../infrastructure/email'` import resolves THROUGH this file.
// Every public export of `./email/index` MUST also be re-exported here, or
// downstream code (e.g. src/notifications/email.ts) sees TS2305.
export {
  sendEmail,
  sendEmailVerification,
  sendSignupVerification,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendTenantInviteEmail,
  sendTeamInviteEmail,
  sendInvitesExpiredEmail,
  sendInviteReminderEmail,
  sendReferralInviteEmail,
  sendPaymentFailedEmail,
  sendSubscriptionConfirmationEmail,
  sendSubscriptionEndingEmail,
  sendSubscriptionEnding7dEmail,
  sendSubscriptionEnding1dEmail,
  sendSubscriptionEndedEmail,
  sendReceiptEmail,
  sendAgentsStalledCreditDepletedEmail,
  sendCardExpiringEmail,
  buildEmail,
  buildParagraph,
  buildList,
  buildListIntro,
  buildCTA,
  buildOutlineButton,
  sendSignupNotification,
  type BuildOptions,
} from './email/index';
