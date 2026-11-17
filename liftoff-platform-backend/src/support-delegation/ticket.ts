// Ticket minting and hashing.
//
// The ticket is the bearer secret that travels in a URL and then in a header,
// so it is generated with crypto-grade randomness and stored only as a digest.
// A dump of support_delegation_sessions therefore yields nothing usable.
//
// A plain sha256 rather than a slow KDF on purpose: unlike a password this is
// 256 bits of uniform randomness, so there is no dictionary to attack and
// nothing for a work factor to buy. The hash is verified on every request, so
// a deliberately slow one would tax the hot path for no gain.

import crypto from 'crypto';

/** 32 bytes, base64url. Long enough that guessing is not a threat model. */
export function mintTicket(): { ticket: string; ticketHash: string } {
  const ticket = crypto.randomBytes(32).toString('base64url');
  return { ticket, ticketHash: hashTicket(ticket) };
}

export function hashTicket(ticket: string): string {
  return crypto.createHash('sha256').update(ticket).digest('hex');
}
