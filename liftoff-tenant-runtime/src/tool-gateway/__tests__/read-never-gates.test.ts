// A read never requires approval — any tool, any connector.
//
// The untrusted-inbound invariant asked `effectPassesUngated(tool?.effect)`.
// `effect` is populated for PLATFORM tools and left undefined on every
// CONNECTOR tool, which states the same fact in `categories` instead. So the
// check read undefined, failed closed, and raised an approval for a pure read.
//
// The result is an "Approval needed — Retrieve email thread … from Google
// Mail" card on `get_thread`, whose catalog entry is
// `effect: undefined, categories: ['read']`. Asking a person to authorise a
// retrieval teaches them to click through approvals without reading them, which
// costs more safety than gating a read could ever buy.

import { toolIsReadOnly, classifyVendorToolEffect, effectFromMcpAnnotations, nameHasMutatingVerb } from '../tool-effect';
import type { McpToolAnnotations } from '../tool-effect';
import { classifyVendorMcpTool } from '../../agent-execution/adapter/vendor-mcp-classify';

/** Build the { effect, categories } a vendor-MCP tool enumerates to, exactly as
 *  vendor-mcp-enumerate does: categories from the sensitivity classifier, and
 *  effect from a server annotation when it decides one, else the name
 *  classifier. The readOnlyHint backstop keys off explicit mutating-verb
 *  evidence (nameHasMutatingVerb), not the sensitivity categories — mirror that
 *  here so the test asserts the REAL enumeration. */
function enumerate(name: string, annotations?: McpToolAnnotations, serverId = 'acme-server') {
  const classification = classifyVendorMcpTool(serverId, name);
  const declared = effectFromMcpAnnotations(annotations, {
    nameLooksMutating: nameHasMutatingVerb(name),
  });
  return {
    effect: declared ?? classifyVendorToolEffect(name),
    categories: classification.categories,
  };
}

describe('connector tools, which carry categories but no effect', () => {
  it.each([
    ['google-mail__get_thread', ['read']],
    ['google-mail__list_messages', ['read']],
    ['salesforce__read_contacts', ['read']],
  ])('%s is read-only', (_name, categories) => {
    expect(toolIsReadOnly({ categories })).toBe(true);
  });

  it.each([
    ['mark_as_read', ['write']],
    ['reply_to_thread', ['outbound', 'write']],
    ['delete_message', ['destructive']],
  ])('%s is NOT read-only', (_name, categories) => {
    expect(toolIsReadOnly({ categories })).toBe(false);
  });
});

describe('platform tools, which carry effect', () => {
  it('honours effect: read', () => {
    expect(toolIsReadOnly({ effect: 'read' })).toBe(true);
  });

  it('does not treat write or spawn as read', () => {
    expect(toolIsReadOnly({ effect: 'write' })).toBe(false);
    expect(toolIsReadOnly({ effect: 'spawn' })).toBe(false);
  });
});

describe('a write signal in EITHER source wins', () => {
  it('refuses a tool tagged both read and write', () => {
    // `['read','write']` is a write. Trusting `read` alone would open the
    // fast-path to anything that also reads something on its way to mutating.
    expect(toolIsReadOnly({ categories: ['read', 'write'] })).toBe(false);
  });

  it('refuses effect:write even when categories claim read', () => {
    expect(toolIsReadOnly({ effect: 'write', categories: ['read'] })).toBe(false);
  });
});

describe('a genuine state-change category beats an effect:read annotation', () => {
  // `dataChanges` is the ONE vendor-MCP tag that beats effect:'read', because
  // classifyVendorMcpTool emits it ONLY on a WRITE_VERBS/DESTRUCTIVE_VERBS match
  // — verb-derived write evidence. A read-hinted `update_cache` enumerates as
  // { effect:'read', categories:['dataChanges'] }; the category must win, or the
  // write slips the read gate.
  it('effect:read + [dataChanges] is NOT read-only', () => {
    expect(toolIsReadOnly({ effect: 'read', categories: ['dataChanges'] })).toBe(false);
  });

  it('matching is case-insensitive across the mixed vocabulary', () => {
    // connector categories are lowercase, vendor-MCP ones camelCase; both normalize.
    expect(toolIsReadOnly({ effect: 'read', categories: ['DataChanges'] })).toBe(false);
  });
});

describe('a heuristic sensitivity tag is NOT evidence of a write', () => {
  // The vendor-MCP classifier derives financialActions/hiringDecisions/
  // externalPublishing/customerCommunication from domain NOUNS (invoice, payment,
  // price, candidate, applicant, interview, post, release, message, reply) that
  // co-occur with read verbs. So a genuine read is tagged with the sensitive
  // domain it reads FROM. These are the sensitivity axis, read by oversight — they
  // must not gate a read on the side-effect axis. Each name below is run through
  // the REAL classifiers, so the { effect:'read', categories:[<sensitivity>] }
  // shape it asserts on is the one the runtime actually builds.
  it.each([
    ['get_invoice', 'financialActions'],
    ['read_payment', 'financialActions'],
    ['view_price', 'financialActions'],
    ['get_candidate', 'hiringDecisions'],
    ['view_applicant', 'hiringDecisions'],
    ['get_interview', 'hiringDecisions'],
    ['get_post', 'externalPublishing'],
    ['view_release', 'externalPublishing'],
    ['get_message', 'customerCommunication'],
    ['read_reply', 'customerCommunication'],
  ])('%s enumerates read + [%s] and IS read-only', (name, expectedCategory) => {
    const tool = enumerate(name);
    expect(tool.effect).toBe('read');
    expect(tool.categories).toContain(expectedCategory);
    expect(toolIsReadOnly(tool)).toBe(true);
  });

  it('internalCollaboration (never emitted by the classifier) does not gate a read', () => {
    expect(toolIsReadOnly({ effect: 'read', categories: ['internalCollaboration'] })).toBe(true);
  });

  it('a sensitive read still passes with no read signal beyond its effect', () => {
    expect(toolIsReadOnly({ effect: 'read', categories: ['read', 'financialActions'] })).toBe(true);
    expect(toolIsReadOnly({ effect: 'read' })).toBe(true);
    expect(toolIsReadOnly({ categories: ['read'] })).toBe(true);
  });

  it('the genuine WRITE in the same domain is still gated — by its effect, not its tag', () => {
    // create_refund/send_email/publish_post get effect:'write' from their verb
    // (or the rule-3 fail-closed default), so the write signal on the side-effect
    // axis catches them; the sensitivity tag is not doing the gating.
    for (const name of ['create_refund', 'send_email', 'publish_post']) {
      const tool = enumerate(name);
      expect(tool.effect).toBe('write');
      expect(toolIsReadOnly(tool)).toBe(false);
    }
    // And an explicit effect:write with only a sensitivity tag is still a write.
    expect(toolIsReadOnly({ effect: 'write', categories: ['financialActions'] })).toBe(false);
    // A dataChanges tag with no effect at all is still a write (fail-closed).
    expect(toolIsReadOnly({ categories: ['dataChanges', 'financialActions'] })).toBe(false);
  });
});

describe('a readOnlyHint cannot rescue a recognized write', () => {
  // A server declaring readOnlyHint:true on a recognized mutating/outbound name
  // must NOT slip the read gate. The enumerator backstops the hint with explicit
  // mutating-verb evidence, so effect falls back to the name classifier ('write'
  // for these) and the tool gates.
  it.each([
    ['charge_card'],        // mutating verb: charge
    ['refund_payment'],     // refund
    ['publish_post'],       // publish
    ['delete_record'],      // delete
    ['send_email'],         // send
    // Recognized writes with NO sensitivity category: the mutating verb is the
    // evidence, so a category-count backstop would miss these but a verb one gates them.
    ['approve_request'],    // approve
    ['enable_feature'],     // enable
    ['upload_file'],        // upload
  ])('%s + readOnlyHint enumerates write and is NOT read-only', (name) => {
    const tool = enumerate(name, { readOnlyHint: true });
    expect(tool.effect).toBe('write');
    expect(toolIsReadOnly(tool)).toBe(false);
  });

  it('still rescues a genuinely unknown read verb (the annotation feature)', () => {
    // query_docs/lookup_article carry no action evidence, so the hint is honoured.
    for (const name of ['query_docs', 'lookup_article', 'find_answer']) {
      const tool = enumerate(name, { readOnlyHint: true });
      expect(tool.effect).toBe('read');
      expect(toolIsReadOnly(tool)).toBe(true);
    }
  });

  it('honours the read hint for a read named in a sensitive domain (no mutating verb)', () => {
    // lookup_invoice/query_candidate carry a domain noun but NO mutating verb, so
    // a category-count backstop would reject the hint while a verb one honours it
    // — these are reads.
    for (const name of ['lookup_invoice', 'query_candidate']) {
      const tool = enumerate(name, { readOnlyHint: true });
      expect(nameHasMutatingVerb(name)).toBe(false);
      expect(tool.effect).toBe('read');
      expect(toolIsReadOnly(tool)).toBe(true);
    }
  });

  it('preserves a genuine read named in a sensitive domain, hint or not', () => {
    // get_invoice matches financialActions, but its name classifier calls it
    // 'read' (get) and it carries no mutating verb, so it stays a read either way.
    for (const ann of [undefined, { readOnlyHint: true }] as const) {
      const tool = enumerate('get_invoice', ann);
      expect(tool.effect).toBe('read');
      expect(toolIsReadOnly(tool)).toBe(true);
    }
  });
});

describe('unknown still gates', () => {
  it('is not read-only with no signal at all', () => {
    // Absence is not evidence of a read. A tool nobody classified is unknown,
    // and unknown gates — that half of the original behaviour is correct.
    expect(toolIsReadOnly({})).toBe(false);
    expect(toolIsReadOnly({ categories: [] })).toBe(false);
    expect(toolIsReadOnly(undefined)).toBe(false);
  });
});
