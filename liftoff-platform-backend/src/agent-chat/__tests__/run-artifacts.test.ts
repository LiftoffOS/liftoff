// A delivery points at what the run made.
//
// The run that prompted this wrote nine documents, one of them the competitive
// digest the person had asked for, and was delivered a single sentence about
// how it ENDED. Every link was already recorded — the connector returns the new
// document's URL and the audit row keeps it — and none was ever shown.

import { withArtifacts, type RunArtifact } from '../run-artifacts';

const doc = (title: string, url: string): RunArtifact => ({ title, url });

describe('what a delivery says about what was produced', () => {
  it('leaves a message untouched when the run made nothing', () => {
    // A run with no artifacts is the common case and must read exactly as it
    // did before: an empty heading would be worse than no heading.
    expect(withArtifacts('This work finished.', [])).toBe('This work finished.');
  });

  it('lists what was made, with the names the agent gave them', () => {
    const text = withArtifacts('This work finished.', [
      doc('Acme — Competitive Digest 2026-09-02', 'https://docs.google.com/document/d/132FY/edit'),
      doc('Acme — Battle Card: RivalCo', 'https://docs.google.com/document/d/1JV2A/edit'),
    ]);
    expect(text).toContain('This work finished.');
    expect(text).toContain('What this run produced:');
    expect(text).toContain('- Acme — Competitive Digest 2026-09-02: https://docs.google.com/document/d/132FY/edit');
    expect(text).toContain('- Acme — Battle Card: RivalCo: https://docs.google.com/document/d/1JV2A/edit');
  });

  it('is plain text, because this lands in Slack and Teams too', () => {
    const text = withArtifacts('done', [doc('A', 'https://x/1')]);
    expect(text).not.toMatch(/[<[]a href|\*\*/i);
  });
});

describe('what counts as an artifact', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'run-artifacts.ts'), 'utf8',
  ) as string;

  it('reads the LINK in a result, not any one provider\'s field name', () => {
    // display_url / webViewUrl / permalink all name the same thing and differ
    // per provider; the link itself is the stable part.
    expect(src).toMatch(/https\?:\\\/\\\//);
    expect(src).not.toContain("'display_url'");
  });

  it('ignores a successful call that produced nothing openable', () => {
    // A call with no link in its result made nothing a person can open.
    expect(src).toMatch(/if \(!url\) continue;/);
  });

  it('scopes to the current exchange, not to a time window', () => {
    // A run continuing across several invocations is still one thing the person
    // asked for; yesterday's run is not.
    expect(src).toContain("role = 'user'");
    expect(src).toContain('a.created_at >= asked.created_at');
  });

  it('only counts calls that actually succeeded', () => {
    expect(src).toContain("a.outcome = 'success'");
  });

  it('goes through the tenant scope, never a raw pool', () => {
    expect(src).toContain('withTenantScope');
  });

  it('never throws into the delivery path', () => {
    const fn = src.slice(src.indexOf('export async function collectRunArtifacts('));
    expect(fn).toMatch(/catch \(err\)/);
    expect(fn).toMatch(/return \[\];/);
  });

  it('is bounded, so a per-competitor sweep does not paste a wall of links', () => {
    expect(src).toMatch(/MAX_ARTIFACTS = \d+/);
    expect(src).toContain('artifacts.length >= MAX_ARTIFACTS');
  });
});

describe('the delivery actually uses it', () => {
  const router = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'wake-settlement', 'internal-router.ts'), 'utf8',
  ) as string;

  it('collects the artifacts and composes the pushed text from them', () => {
    // The STORED text stays clean — the transcript draws cards instead — while
    // Slack and Teams, which have no card, get the list appended.
    expect(router).toContain('collectRunArtifacts(');
    expect(router).toMatch(/const deliveredText = withArtifacts\(replyText, artifacts\)/);
  });

  it('sends the same text to Slack and Teams as it stores', () => {
    // Two accounts of one delivery is the defect this avoids.
    expect(router).not.toMatch(/postToSlack\([^)]*replyText\)/);
    expect(router).not.toMatch(/postToTeams\([^)]*replyText\)/);
  });

  it('collects after the idempotency claim, so a redelivery does no work', () => {
    expect(router.indexOf('wake_settlement_ledger'))
      .toBeLessThan(router.indexOf('collectRunArtifacts('));
  });
});

describe('what counts as PRODUCED, for a run with found and written documents', () => {
  // A delivered run summary, read back from its thread. Eight entries:
  // one real document, six that a `search_documents` call had merely FOUND
  // (its result carries a webViewLink per hit), and the same document twice
  // under two URL spellings. Six of eight were wrong, under a heading that
  // says "What this run produced".
  const { collectRunArtifacts } = require('../run-artifacts');

  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'run-artifacts.ts'), 'utf8',
  ) as string;

  it('excludes a read, however many links its result carries', () => {
    expect(src).toContain('isProducing(row.action)');
    expect(src).toMatch(/READ_VERB[\s\S]{0,200}search/);
  });

  it('treats a read as a read even when the verb could be both', () => {
    // A tie goes to "did not make it": listing something the run did not
    // produce is the error worth avoiding.
    const m = src.slice(src.indexOf('function isProducing'));
    expect(m.indexOf('READ_VERB.test')).toBeLessThan(m.indexOf('WRITE_VERB.test'));
  });

  it('counts an update as producing, since the agent wrote it', () => {
    expect(src).toMatch(/WRITE_VERB[\s\S]{0,120}update/);
  });

  it('names a file from the RESULT when the request did not carry one', () => {
    // A create sends `title`; an update sends only `document_id`. Reading the
    // request alone named one document in eight and labelled the rest
    // "Updated document" — for files the platform had every right to name,
    // since the result carries the title too.
    const { __nameFromForTest } = require('../run-artifacts');
    expect(src).toContain('function nameFrom(');
    expect(src).toMatch(/title\|name\|filename/);
    void __nameFromForTest;
  });

  it('prefers what the agent CALLED it over what came back', () => {
    const m = src.slice(src.indexOf('function labelFor('));
    expect(m).toMatch(/title\?\.trim\(\) \|\| nameFrom\(summary\)/);
  });

  it('never renders "Untitled"', () => {
    expect(src).not.toContain("'Untitled'");
  });

  it('counts one document once, however its link is spelled', () => {
    // The same file returns "/edit" from a create and "/edit?usp=drivesdk"
    // later; a string comparison listed it twice.
    expect(src).toContain('function identity(');
    expect(src).toMatch(/split\('\?'\)/);
  });

  it('is still guarded and still bounded', () => {
    expect(typeof collectRunArtifacts).toBe('function');
    expect(src).toContain('MAX_ARTIFACTS');
  });
});

describe('how a produced file reaches the transcript', () => {
  const { fileOutputAttachments } = require('../run-artifacts');
  const router = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'wake-settlement', 'internal-router.ts'), 'utf8',
  ) as string;

  const one = [{ title: 'Acme — Competitive Digest', url: 'https://docs.google.com/document/d/1NY/edit' }];

  it('shapes a card the transcript already knows how to draw', () => {
    const [a] = fileOutputAttachments(one);
    expect(a.filename).toBe('Acme — Competitive Digest');
    expect(a.webViewUrl).toBe('https://docs.google.com/document/d/1NY/edit');
  });

  it('offers no download, because the bytes are not ours', () => {
    // The file lives in the customer's own Drive. The card hides its download
    // control on null rather than offering one that cannot work.
    expect(fileOutputAttachments(one)[0].downloadUrl).toBeNull();
  });

  it('keys each card on the document, so two links to one file are one card', () => {
    const [a, b] = fileOutputAttachments([
      one[0],
      { title: 'again', url: 'https://docs.google.com/document/d/1NY/edit?usp=drivesdk' },
    ]);
    expect(a.generatedFileId).toBe(b.generatedFileId);
  });

  it('writes the cards as their OWN file_output row', () => {
    // The renderer keys on the message type: an outcome row carrying
    // attachments would store them and draw nothing.
    expect(router).toMatch(/'file_output'/);
    expect(router).toContain('fileOutputAttachments(artifacts)');
  });

  it('keeps raw links out of the stored sentence', () => {
    // Showing the same thing twice, once badly, is what a text list beside a
    // card is. The outcome row stores `replyText`, never `deliveredText`; the
    // column after it is the reply's contributors (migration 493).
    expect(router).toMatch(/agentId, replyText, JSON\.stringify\(await resolveContributors\(/);
    expect(router).not.toMatch(/agentId, deliveredText/);
  });

  it('still sends the text list to Slack and Teams, which have no card', () => {
    expect(router).toMatch(/postToSlack\([^)]*deliveredText\)/);
    expect(router).toMatch(/postToTeams\([^)]*deliveredText\)/);
  });
});

describe('naming an update from what the run READ', () => {
  // Google's update response carries no title — only a documentId and a link.
  // The run had opened the same document moments earlier and THAT response
  // carried "title". Reading each row in isolation lists such documents as
  // "Updated document" while their names sit in the same exchange.
  //
  // Example row shapes:
  //   get_document     {"title":"Acme competition test","documentId":"1aCLb…"}
  //   update_document  {"documentId":"1W9WHtag7…","display_url":"…"}
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'run-artifacts.ts'), 'utf8',
  ) as string;

  it('builds a name index across the whole exchange', () => {
    expect(src).toContain('function namesSeen(');
    expect(src).toContain('const known = namesSeen(rows.rows)');
  });

  it('joins a write to a read on the document LINK', () => {
    // Both rows carry display_url for the same document; the link is the only
    // field they reliably share.
    const fn = src.slice(src.indexOf('function labelFor('));
    expect(fn.slice(0, 900)).toMatch(/known\.get\(identity\(url\)\)/);
  });

  it('prefers the name on the row itself over the index', () => {
    const fn = src.slice(src.indexOf('function labelFor('));
    const body = fn.slice(0, 900);
    expect(body.indexOf('const own =')).toBeLessThan(body.indexOf('known.get('));
  });

  it('keeps the FIRST name a document was seen under', () => {
    // The earliest sighting is the name the person's own document had before
    // this run touched anything.
    expect(src).toMatch(/!known\.has\(identity\(url\)\)/);
  });

  it('still never lists a read as something the run produced', () => {
    // Reads feed the name index and nothing else.
    expect(src).toContain('isProducing(row.action)');
  });
});
