// Minting a workspace's share code.
//
// A short opaque string, e.g. `k7m2q9`. It carries nothing about the
// workspace.
//
// It used to be `{workspace-name-slug}-{4 hex}`, on the reasoning that a link
// reading `northwind-trading-7f3a` says who is recommending. Two things are
// wrong with that. The smaller one is that it leans on workspace names being
// distinctive, which they are not. The larger one is what the names actually
// are: tenants/service.ts defaults them to `Personal Workspace` or
// `{firstName}'s Workspace`, and nobody renames a workspace before sending
// their first invitation — so the common link was
// `example.com/?ref=example-workspace-7f3a`. That publishes a person's
// first name to every recipient, and it reads like something half-configured
// rather than something to pass on.
//
// The alphabet is digits plus consonants. Vowels are gone so a random draw can
// never spell a word, and i/l/o/u are gone because they are the characters
// people mistake for 1 and 0 when reading a link aloud or typing it from a
// phone screen.
//
// `code` is immutable for the life of a workspace (migration 415): a rename must
// not rotate it. Nothing parses the format, so changing the shape needs no
// migration.

import { randomBytes } from 'crypto';

/** Digits and consonants: no vowels, so no draw can spell anything; no i/l/o/u,
 *  which are the ones misread as 1 and 0. */
const ALPHABET = '0123456789bcdfghjkmnpqrstvwxyz';

/**
 * Six characters: 30^6 ≈ 7.3e8.
 *
 * Shorter than is strictly comfortable, chosen because the link is a thing
 * people read out and retype. The trade is real and worth naming: at ten
 * thousand workspaces a blind guess lands on a live code about once in seventy
 * thousand attempts, and each attempt costs an attacker a signup. The prize is
 * mis-attributing one referral, so that is a fair price. Collisions are handled
 * by the caller's retry rather than by the size of the space — at a hundred
 * thousand workspaces occupancy is still one in seven thousand.
 */
const CODE_LENGTH = 6;

/**
 * Largest byte value that can be reduced modulo the alphabet without bias.
 *
 * 256 is not a multiple of 30, so a plain `byte % 30` would draw the first
 * sixteen characters more often than the rest. Bytes at or above this are
 * redrawn instead.
 */
const UNBIASED_LIMIT = 256 - (256 % ALPHABET.length);

/**
 * A candidate code. Callers retry on a unique-constraint collision rather than
 * checking first: the check-then-insert race is real at signup volume and the
 * constraint is the only thing that actually decides.
 */
export function mintReferralCode(): string {
  const out: string[] = [];
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte >= UNBIASED_LIMIT) continue;
      out.push(ALPHABET[byte % ALPHABET.length]);
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out.join('');
}
