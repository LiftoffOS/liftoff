// The FAMILY of an outward act, named without naming a vendor.
//
// Two capabilities with the same recipient and subject are the same act only
// if they are the same KIND of act: a send through one mail vendor and a send
// through another are one email; a send and a calendar invite carrying the
// same fields are not. The operation fingerprint on a handle tells two
// capabilities apart; this tells the runtime which of them may be matched
// against a direct connector send of the same email, and it is the only
// thing that may. Curated, not inferred: a reference is in a family because
// it is listed here.

export type ActFamily = 'mail_send';

const MAIL_SEND: ReadonlySet<string> = new Set([
  'google-mail:send_email',
  'microsoft-outlook-mail:send_email',
  'sendgrid:send_email',
  'sendgrid:send_email_from_template',
]);

/** `<connector-type>:<function>` spelled the way the runtime spells a type. */
export function canonicalActRef(ref: string): string {
  const i = ref.indexOf(':');
  const type = (i > 0 ? ref.slice(0, i) : ref).trim().toLowerCase().replace(/_/g, '-');
  const fn = (i > 0 ? ref.slice(i + 1) : '').trim().toLowerCase();
  return `${type}:${fn}`;
}

export function actFamilyOf(ref: string): ActFamily | null {
  return MAIL_SEND.has(canonicalActRef(ref)) ? 'mail_send' : null;
}
