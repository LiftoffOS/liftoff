// A connector client may not answer "your account is empty" when the truth is
// "nobody implemented this".
//
// Sixteen clients once shipped a `list()` whose entire body was
// `return { records: [], hasMore: false }`. Nothing failed, no log was written,
// and every caller — the poll scheduler, the tool gateway, the destination
// picker in the hire flow — was told the customer had no data. The picker then
// showed "no files found", which reads as a fact about the customer's account
// and is not one.
//
// The fix was to implement them. This test is what stops the next one being
// added: a stub is cheap to write and invisible in review, so the bar is
// enforced here rather than by remembering.

import fs from 'fs';
import path from 'path';
import '../index.js';
import { getClientFactory, registeredClientTypes } from '../adapter.js';

const CLIENTS_DIR = path.join(__dirname, '..');

/** Body of `async list(...)`, brace-matched from its opening brace. */
function listBody(src: string): string | null {
  const m = /async list\s*\([^)]*\)\s*:\s*Promise<ListResult>\s*\{/.exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1; // index of the body's `{`
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function clientFiles(): string[] {
  return fs
    .readdirSync(CLIENTS_DIR)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter(f => !['types.ts', 'adapter.ts', 'index.ts', 'mcp-entity-list.ts'].includes(f));
}

describe('client factory registry', () => {
  // Browse resolves its client from this registry, which makeClientExecutor
  // fills as a side effect of `import './clients/index.js'` in src/index.ts.
  // That import binds no name, so it reads as dead and is exactly the kind of
  // line a tidy-up removes. If it goes, the map is empty, getClientFactory
  // returns null for everything, and every connector reports "cannot enumerate"
  // — a total outage of the picker that no type error would catch.
  it('is populated by importing the client barrel', () => {
    expect(registeredClientTypes().length).toBeGreaterThan(50);
  });

  it('resolves every connector the old hardcoded browse used to serve', () => {
    // Before browse resolved clients from this registry it switched on five
    // literal type sets. Those sets are the historical record of what worked,
    // so nothing in them may silently stop working. Two did: notion and
    // intercom register through makeMCPClientExecutor, a second factory family
    // the registry did not originally cover, and both went from browseable to
    // "cannot enumerate" with no test to notice.
    //
    // Excluded: discord, microsoft_excel, airtable, coda and baserow, which
    // appeared in those sets but have no client and always returned an empty
    // list. They were never actually served — that was the bug.
    const PREVIOUSLY_SERVED = [
      'zendesk', 'intercom',
      'google_drive', 'microsoft_onedrive', 'dropbox', 'box',
      'microsoft_sharepoint', 'google_docs',
      'atlassian_confluence', 'notion', 'microsoft_onenote',
      'slack', 'microsoft_teams',
      'google_sheets',
    ];

    const missing = PREVIOUSLY_SERVED.filter(t => getClientFactory(t) === null);
    expect(missing).toEqual([]);
  });

  it('covers both factory families', () => {
    // A client registered through either makeClientExecutor or
    // makeMCPClientExecutor must be reachable the same way. notion is
    // MCP-backed; google_drive is not.
    expect(getClientFactory('notion')).not.toBeNull();
    expect(getClientFactory('google_drive')).not.toBeNull();
  });

  it('returns null for a connector with no client, rather than throwing', () => {
    // The route turns this into `unsupported: true`. It must be a value, not an
    // exception, or an unknown connector becomes a 500 instead of an answer.
    expect(getClientFactory('not_a_real_connector')).toBeNull();
  });
});

describe('connector clients: no stub list()', () => {
  it('no client returns an empty list unconditionally', () => {
    const offenders: string[] = [];

    for (const file of clientFiles()) {
      const src = fs.readFileSync(path.join(CLIENTS_DIR, file), 'utf8');
      const body = listBody(src);
      if (!body) continue;

      // A stub is a list() that is nothing but an empty return: no branch, no
      // request, no way to ever produce a record.
      const bare = stripComments(body).replace(/\s+/g, ' ').trim();
      if (/^\{ return \{ records: \[\][^}]*\}; \}$/.test(bare)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every empty return is either explained by a guard or marked unsupported', () => {
    // An empty `records` array is only honest when something in scope says why:
    // either the client declared it cannot enumerate this entity
    // (`unsupported: true`), or an early guard shows the REQUEST was missing a
    // parent id. A bare empty return with neither is the ambiguity this whole
    // change exists to remove.
    const suspicious: Array<{ file: string; snippet: string }> = [];

    for (const file of clientFiles()) {
      const src = fs.readFileSync(path.join(CLIENTS_DIR, file), 'utf8');
      const body = listBody(src);
      if (!body) continue;

      const clean = stripComments(body);
      const re = /return\s*\{[^{}]*records:\s*\[\][^{}]*\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(clean)) !== null) {
        if (m[0].includes('unsupported')) continue;

        // Look back for the guard that produced this empty answer. A guarded
        // empty is the author saying something true about THIS request — the
        // parent id was missing, or a bare-array endpoint has no second page.
        // What this test is hunting is the UNguarded empty: a fall-through that
        // returns nothing because no branch handled the call, which is how a
        // silent gap reaches a picker as "your account is empty".
        const before = clean.slice(Math.max(0, m.index - 240), m.index);
        const guarded = /if\s*\(/.test(before);
        if (!guarded) {
          suspicious.push({ file, snippet: m[0].replace(/\s+/g, ' ') });
        }
      }
    }

    expect(suspicious).toEqual([]);
  });
});
