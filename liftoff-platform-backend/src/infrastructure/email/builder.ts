// Email builder - Composes final HTML from shared constants and content

import {
  EMAIL_COLORS,
  DOCTYPE,
  HEAD,
  BODY_OPEN,
  WRAPPER_START,
  CONTENT_TABLE_START,
  CONTENT_TABLE_END,
  FOOTER,
  CLOSING,
} from './shared';

import { EMAIL_CONTENT } from './content';

export interface BuildOptions {
  firstName: string;
  verificationUrl?: string;
  resetUrl?: string;
  inviteUrl?: string;
  teamName?: string;
  // [SE-007] Ownership transfer options
  tenantName?: string;
  newOwnerName?: string;
  newOwnerEmail?: string;
  confirmUrl?: string;
  expiresIn?: string;
  currentOwnerName?: string;
  rawHtml?: string;
  // Billing notification options
  outstandingBalanceUsd?: string;
  // Notification placeholders
  actorName?: string;        // human actor for agent_activity emails (e.g. "Sarah Chen")
  internalAgentName?: string; // Internal agent's user-given name for escalation/task_update emails. Rendered to recipients as the agent name.
  eventTitle?: string;       // short title (e.g. "Approve destructive migration in user-service")
  eventSummary?: string;     // 1-2 sentence description
  eventLink?: string;        // deep link back to the dashboard item
  digestPeriod?: string;     // "the past 24 hours" or "the past week"
  // Newsletter
  newsletterSubject?: string;
  newsletterPreheader?: string;
  // Base URL of the public frontend, from FRONTEND_URL (which has no default —
  // see src/infrastructure/frontend-url.ts). Used by welcome + payment-failed
  // CTAs that need to deep-link into the dashboard.
  frontendUrl?: string;
  // Billing-lifecycle placeholders (subscription confirmation/ending/ended,
  // unified receipt, payment-failed-auto-reload, agents-stalled, card-expiring).
  planName?: string;
  billingSummary?: string;
  promoSummary?: string;
  accessEndsDate?: string;
  accessEndedDate?: string;
  amountUsd?: string;
  paymentMethodSummary?: string;
  chargeReason?: string;
  nextResetDate?: string;
  cardBrand?: string;
  cardLast4?: string;
  cardExpMonth?: string;
  cardExpYear?: string;
  // Invitation-reminder: the full-month expiry date, e.g. "September 1".
  expiryDate?: string;
  // Referral invitation: the referee bonus in dollars, pre-formatted (e.g.
  // "$20"). Dollars rather than Operating Units in the subject and preheader
  // because the person reading it has never used Liftoff and would have to
  // learn what an Operating Unit is before the offer meant anything.
  refereeBonusUsd?: string;
}

// Replace template placeholders in a string
function replacePlaceholders(text: string, options: BuildOptions): string {
  let result = text;
  if (options.verificationUrl !== undefined) {
    result = result.replace(/{verificationUrl}/g, options.verificationUrl);
  }
  if (options.resetUrl !== undefined) {
    result = result.replace(/{resetUrl}/g, options.resetUrl);
  }
  if (options.inviteUrl !== undefined) {
    result = result.replace(/{inviteUrl}/g, options.inviteUrl);
  }
  if (options.teamName !== undefined) {
    result = result.replace(/{teamName}/g, options.teamName);
  }
  // [SE-007] Ownership transfer placeholders
  if (options.tenantName !== undefined) {
    result = result.replace(/{tenantName}/g, options.tenantName);
  }
  if (options.newOwnerName !== undefined) {
    result = result.replace(/{newOwnerName}/g, options.newOwnerName);
  }
  if (options.newOwnerEmail !== undefined) {
    result = result.replace(/{newOwnerEmail}/g, options.newOwnerEmail);
  }
  if (options.confirmUrl !== undefined) {
    result = result.replace(/{confirmUrl}/g, options.confirmUrl);
  }
  if (options.expiresIn !== undefined) {
    result = result.replace(/{expiresIn}/g, options.expiresIn);
  }
  if (options.currentOwnerName !== undefined) {
    result = result.replace(/{currentOwnerName}/g, options.currentOwnerName);
  }
  if (options.outstandingBalanceUsd !== undefined) {
    result = result.replace(/\$\{outstandingBalanceUsd\}/g, options.outstandingBalanceUsd);
  }
  if (options.actorName !== undefined) {
    result = result.replace(/{actorName}/g, options.actorName);
  }
  if (options.internalAgentName !== undefined) {
    result = result.replace(/{internalAgentName}/g, options.internalAgentName);
  }
  if (options.eventTitle !== undefined) {
    result = result.replace(/{eventTitle}/g, options.eventTitle);
  }
  if (options.eventSummary !== undefined) {
    result = result.replace(/{eventSummary}/g, options.eventSummary);
  }
  if (options.eventLink !== undefined) {
    result = result.replace(/{eventLink}/g, options.eventLink);
  }
  if (options.digestPeriod !== undefined) {
    result = result.replace(/{digestPeriod}/g, options.digestPeriod);
  }
  if (options.newsletterSubject !== undefined) {
    result = result.replace(/{newsletterSubject}/g, options.newsletterSubject);
  }
  if (options.newsletterPreheader !== undefined) {
    result = result.replace(/{newsletterPreheader}/g, options.newsletterPreheader);
  }
  if (options.frontendUrl !== undefined) {
    result = result.replace(/{frontendUrl}/g, options.frontendUrl);
  }
  if (options.planName !== undefined) {
    result = result.replace(/{planName}/g, options.planName);
  }
  if (options.billingSummary !== undefined) {
    result = result.replace(/{billingSummary}/g, options.billingSummary);
  }
  if (options.promoSummary !== undefined) {
    result = result.replace(/{promoSummary}/g, options.promoSummary);
  }
  if (options.accessEndsDate !== undefined) {
    result = result.replace(/{accessEndsDate}/g, options.accessEndsDate);
  }
  if (options.accessEndedDate !== undefined) {
    result = result.replace(/{accessEndedDate}/g, options.accessEndedDate);
  }
  if (options.amountUsd !== undefined) {
    result = result.replace(/{amountUsd}/g, options.amountUsd);
  }
  if (options.paymentMethodSummary !== undefined) {
    result = result.replace(/{paymentMethodSummary}/g, options.paymentMethodSummary);
  }
  if (options.chargeReason !== undefined) {
    result = result.replace(/{chargeReason}/g, options.chargeReason);
  }
  if (options.nextResetDate !== undefined) {
    result = result.replace(/{nextResetDate}/g, options.nextResetDate);
  }
  if (options.cardBrand !== undefined) {
    result = result.replace(/{cardBrand}/g, options.cardBrand);
  }
  if (options.cardLast4 !== undefined) {
    result = result.replace(/{cardLast4}/g, options.cardLast4);
  }
  if (options.cardExpMonth !== undefined) {
    result = result.replace(/{cardExpMonth}/g, options.cardExpMonth);
  }
  if (options.cardExpYear !== undefined) {
    result = result.replace(/{cardExpYear}/g, options.cardExpYear);
  }
  if (options.expiryDate !== undefined) {
    result = result.replace(/{expiryDate}/g, options.expiryDate);
  }
  if (options.refereeBonusUsd !== undefined) {
    result = result.replace(/{refereeBonusUsd}/g, options.refereeBonusUsd);
  }
  return result;
}

export function buildEmail(
  emailType: string,
  options: BuildOptions
): { subject: string; html: string } {
  const content = EMAIL_CONTENT[emailType];

  if (!content) {
    throw new Error(`Unknown email type: ${emailType}`);
  }

  const { firstName } = options;
  const subject = replacePlaceholders(content.subject, options);
  const preheader = replacePlaceholders(content.preheader, options);
  const headingPrefix = replacePlaceholders(content.headingPrefix, options);

  // Build HTML by concatenating exact strings
  let html = DOCTYPE;
  html += '\n';
  html += HEAD;
  html += BODY_OPEN;
  html += preheader;
  html += '\n';
  html += WRAPPER_START;
  html += buildHeading(headingPrefix, firstName);
  html += CONTENT_TABLE_START;

  // Build body content
  if (options.rawHtml) {
    html += options.rawHtml;
  } else if (content.paragraphs) {
    const processedParagraphs = content.paragraphs.map((p) => replacePlaceholders(p, options));
    html += buildParagraphs(processedParagraphs);
  } else if (content.bodyTemplate) {
    const bodyText = replacePlaceholders(content.bodyTemplate, options);
    html += buildParagraph(bodyText);
  }

  // CTA before list
  if (content.cta && content.ctaPosition === 'before-list') {
    const ctaUrl = replacePlaceholders(content.cta.url, options);
    html += buildCTA(content.cta.text, ctaUrl);
  }

  if (content.listIntro) {
    html += buildListIntro(replacePlaceholders(content.listIntro, options));
  }

  if (content.listItems) {
    const processedItems = content.listItems.map((item) => replacePlaceholders(item, options));
    html += buildList(processedItems);
  }

  if (content.closingParagraph) {
    html += buildParagraph(replacePlaceholders(content.closingParagraph, options));
  }

  if (content.signatureParagraphs) {
    const processedSignature = content.signatureParagraphs.map((p) => replacePlaceholders(p, options));
    html += buildParagraphs(processedSignature);
  }

  // CTA after signature (default position)
  if (content.cta && content.ctaPosition !== 'before-list') {
    const ctaUrl = replacePlaceholders(content.cta.url, options);
    html += buildCTA(content.cta.text, ctaUrl);
  }

  html += CONTENT_TABLE_END;
  html += FOOTER;
  html += '\n';
  html += CLOSING;

  return { subject, html };
}

// Helper functions that return exact HTML strings

function buildHeading(prefix: string, firstName: string): string {
  return `
                                    <h1
                                      style="margin:0;padding:0;font-size:2.25em;line-height:1.44em;padding-top:0.389em;font-weight:600;text-align:center;color:${EMAIL_COLORS.text};"
                                    >
                                      <span>${prefix}</span>${firstName}
                                    </h1>`;
}

export function buildParagraph(text: string): string {
  return `
                                    <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em;color:${EMAIL_COLORS.text};">
                                      <span>${text}</span>
                                    </p>`;
}

function buildParagraphs(paragraphs: string[]): string {
  return paragraphs.map((text) => buildParagraph(text)).join('');
}

export function buildListIntro(text: string): string {
  return `
                                    <p
                                      style="margin:0;padding:0;font-size:1em;padding-top:1.1em;padding-bottom:0.35em;font-weight:600;color:${EMAIL_COLORS.text};"
                                    >
                                      <span>${text}</span>
                                    </p>`;
}

export function buildList(items: string[]): string {
  const listItems = items
    .map((item, index) => {
      const isLast = index === items.length - 1;
      const margin = isLast ? '0' : '0 0 8px 0';
      return `                                      <li style="margin:${margin};">${item}</li>`;
    })
    .join('\n');

  return `
                                    <ul
                                      style="margin:0;padding-left:20px;padding-top:0.15em;padding-bottom:1em;font-size:1em;line-height:155%;color:${EMAIL_COLORS.text};"
                                    >
${listItems}
                                    </ul>`;
}

export function buildCTA(text: string, url: string): string {
  // Escape the URL for an HTML attribute. An unescaped "&" in the href (our
  // link carries &oobCode=...) is a known cause of buttons failing to register
  // as tappable in iOS / Apple Mail. The client decodes &amp; back to & on tap,
  // so the destination is unchanged.
  const safeUrl = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  // Bulletproof (table-based) button: the padding lives on a block-ish <a> that
  // fills the cell, so the whole pill — not just the text glyphs — is the tap
  // target across Gmail, Apple Mail (iOS/macOS) and Outlook. bgcolor on the
  // <td> backs Outlook; the .cta-button class keeps dark-mode handling.
  return `
                                    <div style="padding-top:20px;padding-bottom:20px;text-align:center;">
                                      <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto;">
                                        <tr>
                                          <td align="center" bgcolor="${EMAIL_COLORS.accent}" style="border-radius:24px;">
                                            <a class="cta-button" href="${safeUrl}" target="_blank" style="display:inline-block;background-color:${EMAIL_COLORS.accent};color:#ffffff;padding:12px 28px;border-radius:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.2;text-decoration:none;">${text}</a>
                                          </td>
                                        </tr>
                                      </table>
                                    </div>`;
}

// Outline (secondary) variant of buildCTA: transparent fill with a neutral GREY
// border and grey text — matching the site's .btn--outline, NOT the orange
// accent. Same bulletproof table-based structure so the whole pill — not just
// the text — is the tap target across Gmail, Apple Mail (iOS/macOS) and Outlook.
// Used for the "Waitlist" button on the signup-notification email, sitting under
// the solid Approve CTA.
export function buildOutlineButton(text: string, url: string): string {
  const safeUrl = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `
                                    <div style="padding-top:8px;padding-bottom:20px;text-align:center;">
                                      <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto;">
                                        <tr>
                                          <td align="center" style="border-radius:24px;border:1px solid ${EMAIL_COLORS.outlineBorder};">
                                            <a href="${safeUrl}" target="_blank" style="display:inline-block;color:${EMAIL_COLORS.outlineText};padding:11px 27px;border-radius:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.2;text-decoration:none;">${text}</a>
                                          </td>
                                        </tr>
                                      </table>
                                    </div>`;
}

