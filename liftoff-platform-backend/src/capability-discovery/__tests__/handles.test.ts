import { mintCapabilityHandle, resolveCapabilityHandle, isExecutableRef, operationFingerprint } from '../handles';

/** The runtime's view: the segments between the class marker and the
 *  ciphertext, read by format alone. The ciphertext is always last. */
const operationOf = (token: string): string | undefined => token.split('.')[1];
const familyOf = (token: string): string | null => {
  const parts = token.split('.');
  return parts.length === 4 ? parts[2] : null;
};

describe('stateless capability handles', () => {
  it('round-trips the ref and fallbacks through an opaque token', () => {
    const token = mintCapabilityHandle('tikhub:tiktok_fetch_user', ['apify:tiktok_scraper', 'nasdaq:x']);
    expect(token.startsWith('cap_')).toBe(true);
    // The vendor must NOT be readable out of the opaque token.
    expect(token.toLowerCase()).not.toContain('tikhub');
    expect(token.toLowerCase()).not.toContain('tiktok');

    const resolved = resolveCapabilityHandle(token);
    expect(resolved).not.toBeNull();
    expect(resolved?.primaryRef).toBe('tikhub:tiktok_fetch_user');
    expect(resolved?.fallbacks).toEqual([{ ref: 'apify:tiktok_scraper' }, { ref: 'nasdaq:x' }]);
  });

  // A tail entry carries what it needs to run: a store actor rides as
  // `apify:run_actor` with its actor id INSIDE the ciphertext, beside a
  // registry function that needs nothing. Neither identity is readable out of
  // the token.
  it('round-trips a mixed tail — registry functions and a store actor with its actor id', () => {
    const token = mintCapabilityHandle('tikhub:fetch_posts', [
      { ref: 'apify:run_actor', presetArgs: { actorId: 'clockworks/tiktok-scraper' } },
      'strale:search_posts',
      { ref: 'nasdaq:x', presetArgs: {} },
    ]);
    expect(token.toLowerCase()).not.toContain('clockworks');
    expect(token.toLowerCase()).not.toContain('apify');
    expect(resolveCapabilityHandle(token)?.fallbacks).toEqual([
      { ref: 'apify:run_actor', presetArgs: { actorId: 'clockworks/tiktok-scraper' } },
      { ref: 'strale:search_posts' },
      { ref: 'nasdaq:x' },
    ]);
  });

  it('still resolves a handle whose tail was encoded as bare strings (deploy-window compatibility)', () => {
    // A handle minted by the pre-entry code: same envelope, `f` is a list of
    // strings. Built with the module's own key so only the payload differs.
    const { createCipheriv, randomBytes } = jest.requireActual<typeof import('crypto')>('crypto');
    const { deriveHandleKey } = jest.requireActual<typeof import('../handles')>('../handles');
    const key = deriveHandleKey('capability-handle-v1');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const payload = JSON.stringify({ p: 'tikhub:fetch_posts', f: ['strale:search_posts', 'nasdaq', 'gloria:get_latest_news'], e: Date.now() + 60_000 });
    const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    const legacy = 'cap_r.' + operationFingerprint('tikhub:fetch_posts') + '.' + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
    expect(resolveCapabilityHandle(legacy)).toEqual({
      primaryRef: 'tikhub:fetch_posts',
      fallbacks: [{ ref: 'strale:search_posts' }, { ref: 'gloria:get_latest_news' }],
    });
  });

  it('resolves the same token minted anywhere (stateless — no server store)', () => {
    // Two independent mints of the same ref both resolve; there is no shared
    // in-memory map involved, which is what lets a different instance resolve it.
    const a = mintCapabilityHandle('gloria:get_latest_news');
    const b = mintCapabilityHandle('gloria:get_latest_news');
    expect(a).not.toBe(b); // distinct ivs => distinct ciphertext
    expect(resolveCapabilityHandle(a)?.primaryRef).toBe('gloria:get_latest_news');
    expect(resolveCapabilityHandle(b)?.primaryRef).toBe('gloria:get_latest_news');
  });

  it('marks a write/outbound-class handle so the runtime can gate without decrypting', () => {
    const write = mintCapabilityHandle('saperly:make_call', [], undefined, true);
    const read = mintCapabilityHandle('gloria:get_latest_news', [], undefined, false);
    // The plaintext class marker is readable WITHOUT the key — that is the whole
    // point: the tenant-runtime forwards the handle and cannot decrypt it, but
    // must know at admission time whether to pause for approval.
    expect(write.startsWith('cap_w.')).toBe(true);
    expect(read.startsWith('cap_r.')).toBe(true);
    // The class is read/write only — the vendor still must not leak out.
    expect(write.toLowerCase()).not.toContain('saperly');
    // The marker does not disturb resolution.
    expect(resolveCapabilityHandle(write)?.primaryRef).toBe('saperly:make_call');
    expect(resolveCapabilityHandle(read)?.primaryRef).toBe('gloria:get_latest_news');
  });

  it('still resolves a legacy unmarked handle (deploy-window compatibility)', () => {
    // Simulate a token minted by the pre-marker code: same body, no `w.`/`r.`.
    const marked = mintCapabilityHandle('nasdaq:get_stock_quote', [], undefined, false);
    const legacy = 'cap_' + marked.slice('cap_r.'.length); // strip the marker
    expect(legacy.startsWith('cap_r.')).toBe(false);
    expect(resolveCapabilityHandle(legacy)?.primaryRef).toBe('nasdaq:get_stock_quote');
  });

  it('carries server-set preset args (the Apify actor id) and hides them from the token', () => {
    const token = mintCapabilityHandle('apify:run_actor', [], { actorId: 'someuser/crunchbase-scraper' });
    // The actor id (which would leak the source) must not be readable out of it.
    expect(token.toLowerCase()).not.toContain('crunchbase');
    expect(token.toLowerCase()).not.toContain('apify');

    const resolved = resolveCapabilityHandle(token);
    expect(resolved?.primaryRef).toBe('apify:run_actor');
    expect(resolved?.presetArgs).toEqual({ actorId: 'someuser/crunchbase-scraper' });
  });

  it('omits presetArgs when none are given (ordinary connector handles)', () => {
    const resolved = resolveCapabilityHandle(mintCapabilityHandle('tikhub:x'));
    expect(resolved?.presetArgs).toBeUndefined();
    // And an empty preset object is treated as none.
    expect(resolveCapabilityHandle(mintCapabilityHandle('tikhub:x', [], {}))?.presetArgs).toBeUndefined();
  });

  it('rejects a tampered, malformed, or non-handle token', () => {
    const token = mintCapabilityHandle('nasdaq:get_stock_quote');
    const tampered = `${token}AAAA`;
    expect(resolveCapabilityHandle(tampered)).toBeNull();
    expect(resolveCapabilityHandle('cap_not-base64-!!')).toBeNull();
    expect(resolveCapabilityHandle('not_a_handle')).toBeNull();
    expect(resolveCapabilityHandle('')).toBeNull();
  });
});

// A handle is a promise the model can run it. The executor runs a
// `<connectorType>:<functionName>` pair and nothing else, so a reference that
// names only a system is refused at minting — where the caller can leave the
// candidate out — rather than minted and skipped silently at execution.
describe('the operation segment — one operation is one fingerprint, and names no vendor', () => {
  it('is the same across two mints of the same reference, and differs between references', () => {
    const first = mintCapabilityHandle('google_mail:send_email', [], undefined, true);
    const second = mintCapabilityHandle('google_mail:send_email', [], undefined, true);
    const other = mintCapabilityHandle('google_mail:create_draft', [], undefined, true);
    expect(operationOf(first)).toMatch(/^[0-9a-f]{12}$/);
    expect(operationOf(first)).toBe(operationOf(second));
    expect(operationOf(first)).not.toBe(operationOf(other));
    expect(operationOf(first)).toBe(operationFingerprint('google_mail:send_email'));
    // Readable without the key, like the class marker; the vendor is not.
    // The family names the KIND of act (`mail_send`) and no vendor.
    expect(first.toLowerCase()).not.toContain('google');
    expect(first.toLowerCase()).not.toContain('gmail');
  });

  it('canonicalises the reference the way the runtime spells a connector type', () => {
    expect(operationFingerprint('google_mail:send_email')).toBe(operationFingerprint('google-mail:Send_Email'));
    expect(operationFingerprint('google_mail:send_email')).not.toBe(operationFingerprint('google_mail:reply_email'));
  });

  it('carries the act family for a reference that has one, and none otherwise', () => {
    const gmail = mintCapabilityHandle('google_mail:send_email', [], undefined, true);
    const outlook = mintCapabilityHandle('microsoft_outlook_mail:send_email', [], undefined, true);
    const draft = mintCapabilityHandle('google_mail:create_draft', [], undefined, true);
    const news = mintCapabilityHandle('gloria:get_latest_news', [], undefined, false);
    expect(familyOf(gmail)).toBe('mail_send');
    expect(familyOf(outlook)).toBe('mail_send');
    // A draft is not a send; two vendors' sends are one family; a read has none.
    expect(familyOf(draft)).toBeNull();
    expect(familyOf(news)).toBeNull();
    expect(operationOf(gmail)).not.toBe(operationOf(outlook));
    expect(resolveCapabilityHandle(gmail)?.primaryRef).toBe('google_mail:send_email');
    expect(resolveCapabilityHandle(news)?.primaryRef).toBe('gloria:get_latest_news');
  });

  it('the family is bound too: adding, removing or changing it does not resolve', () => {
    const gmail = mintCapabilityHandle('google_mail:send_email', [], undefined, true);
    const [prefix, op, family, body] = gmail.split('.');
    expect(family).toBe('mail_send');
    expect(resolveCapabilityHandle(`${prefix}.${op}.${body}`)).toBeNull();            // family removed
    expect(resolveCapabilityHandle(`${prefix}.${op}.chat_post.${body}`)).toBeNull();  // family changed
    const draft = mintCapabilityHandle('google_mail:create_draft', [], undefined, true);
    const [dp, dop, dbody] = draft.split('.');
    expect(resolveCapabilityHandle(`${dp}.${dop}.mail_send.${dbody}`)).toBeNull();     // family added
  });

  it('is bound to the ciphertext: a relabelled segment does not resolve', () => {
    const send = mintCapabilityHandle('google_mail:send_email', [], undefined, true);
    const draftOp = operationFingerprint('google_mail:create_draft');
    const relabelled = `cap_w.${draftOp}.${send.split('.').slice(2).join('.')}`;
    expect(operationOf(relabelled)).toBe(draftOp);
    expect(resolveCapabilityHandle(relabelled)).toBeNull();
    expect(resolveCapabilityHandle(send)?.primaryRef).toBe('google_mail:send_email');
  });

  it('a handle minted before the segment existed still resolves, and reports no operation', () => {
    const marked = mintCapabilityHandle('nasdaq:get_stock_quote', [], undefined, false);
    const noSegment = 'cap_r.' + marked.split('.').slice(2).join('.');
    expect(noSegment.split('.')).toHaveLength(2);
    expect(resolveCapabilityHandle(noSegment)?.primaryRef).toBe('nasdaq:get_stock_quote');
  });
});

describe('a handle names something that can run', () => {
  it('recognizes an executable reference', () => {
    expect(isExecutableRef('google_mail:send_email')).toBe(true);
    expect(isExecutableRef('tikhub:x')).toBe(true);
    expect(isExecutableRef('google_mail')).toBe(false);
    expect(isExecutableRef('google_mail:')).toBe(false);
    expect(isExecutableRef(':send_email')).toBe(false);
    expect(isExecutableRef('')).toBe(false);
  });

  it('refuses to mint a primary reference with no function', () => {
    expect(() => mintCapabilityHandle('google_mail')).toThrow(/names no function/);
  });

  it('drops fallback references with no function and keeps the rest', () => {
    const token = mintCapabilityHandle('google_mail:send_email', ['outlook', { ref: 'outlook:send_email' }, 'slack', { ref: 'slack' }]);
    expect(resolveCapabilityHandle(token)?.fallbacks).toEqual([{ ref: 'outlook:send_email' }]);
  });
});
