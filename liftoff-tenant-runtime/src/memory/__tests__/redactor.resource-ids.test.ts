// A document id is not a credential, and destroying it destroys the memory.
//
// Layer 1's pass 2 is an entropy fallback: 32+ characters of
// `[A-Za-z0-9_+/=-]`, mixed case, with digits, at >= 4.0 bits/char. A Google
// Drive file id is 44 characters, mixed case, with digits, and measures ~4.9.
// It satisfies every condition, so it is indistinguishable from an API key by
// that test and was replaced with `[REDACTED:high_entropy_string]`.
//
// For example, an agent that finishes a sweep and records where its work lives
// would store:
//
//   Watch list id [REDACTED:high_entropy_string]. Snapshot id
//   [REDACTED:high_entropy_string]. Battle cards: GetAgent
//   [REDACTED:high_entropy_string]; RivalCo [REDACTED:high_entropy_string];
//   ... Digest doc id [REDACTED:high_entropy_string].
//
// The row stores cleanly, is retrievable, and reads as healthy, which is why
// nothing surfaces it — the sentence still announces an id it no longer has.
//
// WHY AN EXEMPTION IS THE RIGHT SHAPE OF FIX. An API key IS the access: holding
// it is being authorised. A document id grants nothing; reaching the document
// needs the connector's OAuth grant, and without it the id returns a 404. Such
// ids are often already published as links in the team's own documents, so
// redacting them from memory buys no confidentiality and costs the team its
// record.
//
// These assert the exemption is NARROW: one recognised shape, opt-in, and the
// entropy threshold untouched — so a secret of similar shape with a known
// prefix is still caught, by pass 1, before pass 2 ever runs.

import { redactCredentials, isPlatformResourceId } from '../redactor';

/** The real ids from that run. */
const DOC_IDS = [
  '1ECmJpPH7xNTviKMA3SPHOcnBpXRQbeWzdJPOYU1ikHI', // watch list
  '1fLHeSjm5lw_ENdumRpSLxEiFQWaR_8i7VfmkPduvHRY', // snapshot
  '1a9Bx0i_ELzIzIkWUAm0QWet-i1hJcZM-bM3dR0Capcw', // battle card
  '1ghreavp7AKAS-zRNekIR5y0P1G6lhTDusA3deJ_ltv4', // the deliverable
];

describe('a platform resource id survives an agent\'s own memory', () => {
  it('keeps every id from the run that lost them', () => {
    const content = `Watch list id ${DOC_IDS[0]}. Snapshot id ${DOC_IDS[1]}. `
      + `Battle card GetAgent ${DOC_IDS[2]}. Digest doc id ${DOC_IDS[3]}.`;
    const { redacted, matches } = redactCredentials(content, { keepResourceIds: true });
    for (const id of DOC_IDS) expect(redacted).toContain(id);
    expect(redacted).not.toContain('[REDACTED');
    expect(matches).toEqual([]);
  });

  it('still redacts them when the option is OFF, so every other caller is unchanged', () => {
    const { redacted, matches } = redactCredentials(`id ${DOC_IDS[0]}`);
    expect(redacted).toContain('[REDACTED:high_entropy_string]');
    expect(matches).toHaveLength(1);
  });

  it('recognises the shape, and nothing broader', () => {
    for (const id of DOC_IDS) expect(isPlatformResourceId(id)).toBe(true);
    // Wrong length, wrong first character, wrong alphabet.
    expect(isPlatformResourceId('1ECmJpPH7xNTviKMA3SPHOcnBpXRQbeWzdJPOYU1ikH')).toBe(false);
    expect(isPlatformResourceId(`1${DOC_IDS[0]}`)).toBe(false);
    expect(isPlatformResourceId('2ECmJpPH7xNTviKMA3SPHOcnBpXRQbeWzdJPOYU1ikHI')).toBe(false);
    expect(isPlatformResourceId('1ECmJpPH7xNTviKMA3SPHOcnBpXRQbeWzdJPOYU1ik+I')).toBe(false);
  });
});

describe('the exemption does not weaken the credential rule', () => {
  // Pass 1 matches a named format by its PREFIX and runs before the entropy
  // fallback, so the exemption cannot reach any of these whatever its shape.
  // ASSEMBLED, never written out. Fixtures realistic enough to exercise pass 1
  // are realistic enough for GitHub's own secret scanning to block the push —
  // which it did, reading two of these as a live Stripe key and a Slack token.
  // The prefix is what pass 1 matches, so a low-entropy body exercises it just
  // as well and is unmistakably not a credential.
  const body = (n: number): string => 'a1B2c3D4'.repeat(Math.ceil(n / 8)).slice(0, n);
  const SECRETS: Array<[string, string]> = [
    ['openai_api_key', `sk${'-'}${body(32)}`],
    ['stripe_secret_key', `sk${'_'}live${'_'}${body(28)}`],
    ['slack_bot_token', `xoxb${'-'}1${'-'}2${'-'}${body(20)}`],
    ['slack_user_token', `xoxp${'-'}1${'-'}2${'-'}3${'-'}${body(20)}`],
    ['google_oauth_token', `ya29${'.'}${body(28)}`],
    ['aws_access_key', `AKIA${'ABCDEFGHIJKLMNOP'}`],
    ['github_token', `ghp${'_'}${body(40)}`],
    ['gitlab_pat', `glpat${'-'}${body(24)}`],
  ];

  it.each(SECRETS)('still redacts a %s with the exemption ON', (kind, secret) => {
    const { redacted, matches } = redactCredentials(`token ${secret}`, { keepResourceIds: true });
    expect(redacted).not.toContain(secret);
    expect(matches.map((m) => m.kind)).toContain(kind);
  });

  it('still redacts an unprefixed high-entropy secret that is not this shape', () => {
    // 50 characters, so the resource-id signature cannot match it, and the
    // entropy fallback still does its job.
    const blob = 'Zq7Z3vK9mTbX1pLrN8sWdYhJcF4gQ2eA6uR0iO5yPnM3kVbT1x';
    const { redacted } = redactCredentials(`key ${blob}`, { keepResourceIds: true });
    expect(redacted).toContain('[REDACTED:high_entropy_string]');
  });

  it('leaves the entropy threshold exactly where it was', () => {
    // The fix is a shape exemption, not a loosened bar. A token that is NOT a
    // resource id is judged by the same threshold with the option on or off.
    const blob = 'Xy9Qm2Vb7Nk4Rt1Ws8Zd3Gh6Jc0Lp5Fa';
    const on = redactCredentials(blob, { keepResourceIds: true }).matches.length;
    const off = redactCredentials(blob).matches.length;
    expect(on).toBe(off);
  });
});
