// Tests: catalog prose obeys the product's copy rules.
//
// These fields are not internal configuration. The frontend renders
// displayName, description, responsibilities and additionalContext verbatim on
// the template detail page, and the team builder prefills the editors with them
// when someone edits a template. So whatever is written here is read by a
// customer, and the product's copy invariants apply.
//
// This exists because all three rules below were broken at scale by bulk
// template generation, not by anyone typing them one at a time: the same
// scheduling clause landed on line 19 of thirteen files at once. A schema
// cannot catch prose, so it is caught here.

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const CATALOG_DIR = path.join(__dirname, '..', 'catalog');

/** The fields a customer actually reads. Connector descriptions and trigger
 *  objectives are included: the detail page lists them, and they are prose. */
const PROSE_FIELDS = [
  'displayName',
  'description',
  'roleSummary',
  'role',
  'responsibilities',
  'additionalContext',
] as const;

interface Template {
  [key: string]: unknown;
}

const files = fs.readdirSync(CATALOG_DIR)
  .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

function prose(tpl: Template): string {
  return PROSE_FIELDS
    .map(f => (typeof tpl[f] === 'string' ? (tpl[f] as string) : ''))
    .join('\n');
}

function load(file: string): Template {
  return yaml.load(fs.readFileSync(path.join(CATALOG_DIR, file), 'utf-8')) as Template;
}

describe('Agent Template Catalog — copy rules', () => {
  it('has templates to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // Bulk generation appended a scheduling clause to every workflow heading:
  // "Every Monday morning, and whenever a new weekly window opens, ...". It
  // restated the cadence immediately before it in scheduler vocabulary, so it
  // told the reader nothing and cost them a sentence.
  it.each(files)('%s does not restate its cadence as a scheduling window', (file) => {
    const text = prose(load(file));
    const match = text.match(/,\s*and whenever a new [a-z ]+ window opens/i);
    expect(match?.[0] ?? null).toBeNull();
  });

  // INV: user-facing copy says "agent" or the agent's own name, never "AI team".
  //
  // This assertion reversed with the rename, and the exemption list went with
  // it. The old direction needed one — "agent bank", "facility agent",
  // "security agent", "human agent" are all real terms of art that a ban on the
  // bare word kept tripping over. The retired noun has no such collisions,
  // because "AI team" is nobody else's term for anything.
  it.each(files)('%s does not call an agent an "AI team"', (file) => {
    const offenders = prose(load(file))
      .split('\n')
      .filter(l => /\bAI teams?\b/i.test(l));
    expect(offenders).toEqual([]);
  });

  // INV: no em dashes in user-facing copy.
  it.each(files)('%s uses no em dashes', (file) => {
    const offenders = prose(load(file))
      .split('\n')
      .filter(l => l.includes('—'));
    expect(offenders).toEqual([]);
  });

  // These fields become the team's own instructions. Copy about the customer's
  // buying decision ("nobody has to write it before hiring you") is addressed to
  // the wrong reader: the team cannot act on it, and it only makes sense to
  // someone choosing a template.
  const AUDIENCE_LEAK = /hiring you|before hiring|when you were hired|returning to Liftoff/i;
  it.each(files)('%s does not address the reader as someone hiring', (file) => {
    const offenders = prose(load(file))
      .split('\n')
      .filter(l => AUDIENCE_LEAK.test(l));
    expect(offenders).toEqual([]);
  });

  // A template states what must be true of the team's work. HOW that is enforced
  // belongs to the distiller, which already derives idempotency design (see
  // distill-service.ts, "Acting on each inbound thing exactly once"), and to the
  // runtime, which supplies the tool either way.
  //
  // Fifteen templates once named `have_i_acted_on` directly. That put a runtime
  // identifier into copy a customer reads and edits, and pinned fifteen files to
  // a name only the runtime owns: renaming the tool would have quietly made all
  // fifteen wrong, with nothing failing.
  //
  // The reader is not technical. They are deciding whether to hire this team,
  // and every tool name spends their attention on something they cannot act on.
  // The runtime sends each tool's own description and schema to the agent at
  // call time, so naming one here is duplication that only a customer pays for.
  //
  // The worst of these were a graph-executor API — spawn_task_graph, its
  // reserved `_dependencyResults` field and its depends_on syntax — pasted into
  // five templates, with an example about researching a competitor sitting in
  // the middle of a code review template.
  //
  // NOT covered, deliberately: field names like `lead_score` and
  // `last_enriched_at`. Those are columns in the customer's own CRM, so someone
  // setting this up needs to recognise them. They are the customer's
  // vocabulary, not ours.
  // A connector description is one line under a connector name on the setup
  // screen. The person is deciding which tool to connect and where the work
  // goes; the description says which tool this is, not what the team does with
  // it. One ran to 268 characters and recapped the whole job — "Your document
  // workspace, where this team keeps the watch list, the weekly digest and the
  // battle cards" — in a place where the job is not the question.
  //
  // A ceiling, not a target. It may only ever be lowered: 130 is where the
  // catalog sits after a pass, and the long tail below it is still worth
  // shortening.
  const MAX_CONNECTOR_DESCRIPTION = 130;
  it.each(files)('%s keeps its connector descriptions to one line', (file) => {
    const tpl = load(file) as Record<string, unknown>;
    const reqs = [
      ...((tpl.requiredConnectors as Array<Record<string, unknown>>) ?? []),
      ...((tpl.optionalConnectors as Array<Record<string, unknown>>) ?? []),
    ];
    const tooLong = reqs
      .map(r => ({ id: r.id, len: String(r.description ?? '').length }))
      .filter(r => r.len > MAX_CONNECTOR_DESCRIPTION);
    expect(tooLong).toEqual([]);
  });

  // "from memory" is OUR word for something else.
  //
  // Seven templates used it to forbid answering from the model's own training
  // data: "never add one from memory", "do not state vendor prices from
  // memory". Correct in intent, and unreadable in practice — the platform's
  // recall tools are also called memory, and a model has no way to tell which
  // sense a prohibition is in.
  //
  // A template that carries these and has no memory step in its graph is told
  // by every mention of memory in its instructions not to use memory, and can
  // end up reporting that a document it wrote itself does not exist.
  //
  // Say what is being forbidden: "you cannot source", "you have not read from a
  // source", "your own recollection of this run".
  it.each(files)('%s does not forbid working "from memory"', (file) => {
    const offenders = prose(load(file))
      .split('\n')
      .filter(l => /from memory/i.test(l));
    expect(offenders).toEqual([]);
  });

  // A template must not tell a team to CREATE a folder.
  //
  // Google Docs exposes nine actions and not one of them creates a folder or
  // moves a file. Notion, Coda and OneNote are the same: a page is the unit,
  // and there is nothing to file it into. So "save it in a subfolder you
  // create" is not a standard the work is held to, it is a sentence the model
  // has to work around — and what it works around to is leaving documents
  // loose in a customer's Drive and then being unable to find them again.
  //
  // Findable beats tidy. The deliverable is named, everything else is LINKED
  // from it, and the team finds its own prior work from the action ledger the
  // runtime injects rather than from remembering where it filed things.
  //
  // Narrow on purpose: READING a folder someone hands over is fine, and so is
  // a folder the person picked. Only creating one is out.
  const FOLDER_CREATION = /subfolder|folder you create|create (that |a |the )?(sub)?folder|new folder/i;
  it.each(files)('%s does not tell the team to create a folder', (file) => {
    const offenders = prose(load(file))
      .split('\n')
      .filter(l => FOLDER_CREATION.test(l));
    expect(offenders).toEqual([]);
  });

  // Nor may a template say WHERE a new document should land, relative to
  // another one.
  //
  // Same defect as the folder rule and a different sentence, which is why the
  // folder pass missed it: fourteen document analysts said "put the completed
  // grid back where the source document came from" without ever using the word
  // folder. `create_document_markdown` takes a title and a body and NO parent,
  // so a Docs-bound or Notion-bound team cannot honour it, and the model works
  // around an instruction it cannot follow.
  //
  // Name the artifact after its source and LINK it. That is findable on every
  // connector, including the ones that can place files.
  const UNFOLLOWABLE_PLACEMENT =
    /back where the source|where the source (document|documents)? ?came from|file it (beside|next to|alongside)|in the same folder as/i;
  it.each(files)('%s does not say where a new document must land', (file) => {
    const offenders = prose(load(file))
      .split('\n')
      .filter(l => UNFOLLOWABLE_PLACEMENT.test(l))
      // The rule's own explanation names the thing it forbids.
      .filter(l => !/cannot choose where a new document lands/.test(l));
    expect(offenders).toEqual([]);
  });

  const OUR_INTERNALS =
    /have_i_acted_on|spawn_task_graph|spawn_child_task|_dependencyResults|input_data\b|generate_xlsx|generate_pptx|generate_docx|edit_presentation|read_document|list_files|action_ledger|__browse__|canUseTool|hitlGate/;
  it.each(files)('%s names no tool or field of ours', (file) => {
    const offenders = prose(load(file))
      .split('\n')
      .filter(l => OUR_INTERNALS.test(l));
    expect(offenders).toEqual([]);
  });

  // A summary describes this team. It never places the team relative to
  // another one.
  //
  // `description` is the card in the gallery and `roleSummary` the line under
  // the name: the two sentences a person reads while deciding whether this is
  // the team they want. Five marketing templates opened theirs with another
  // template ("Where the Positioning Specialist turns evidence into
  // positioning, this role gathers the evidence"), so the card read as half of
  // a pair, sent the reader to a team they had not asked about, and broke the
  // moment that template was renamed. What the team does is the whole
  // summary; who it hands to belongs in the body, under working with
  // teammates.
  //
  // Frozen: three sales templates name the Account Executive as the hand-off
  // in their summary. Existing debt, not a permission; the set only shrinks.
  const KNOWN_SUMMARY_CROSS_REFERENCES = new Set([
    'customer-success-manager',
    'inbound-lead-qualifier',
    'sales-development-representative',
  ]);
  const displayNames = files.map(f => String(load(f).displayName ?? ''));
  it.each(files)('%s summarises itself without naming another template', (file) => {
    const tpl = load(file);
    const own = String(tpl.displayName ?? '');
    const summary = ['description', 'roleSummary']
      .map(f => (typeof tpl[f] === 'string' ? (tpl[f] as string) : ''))
      .join('\n')
      .toLowerCase();
    const named = displayNames
      .filter(n => n && n !== own && summary.includes(n.toLowerCase()));
    if (KNOWN_SUMMARY_CROSS_REFERENCES.has(String(tpl.id))) {
      expect(named.length).toBeGreaterThan(0);
      return;
    }
    expect(named).toEqual([]);
  });

  // A connector clause and a destination fallback render as CHIPS.
  //
  // The gallery and the team's own page resolve `{{connector:x}}` to the
  // connector's whenBound clause and `{{pick:x}}` to the destination's
  // fallback, each inside one chip the reader cannot type into. The chip is
  // the length of the phrase. The catalog's convention is a verb phrase that
  // sits inside a numbered step ("post to {{pick:alert-channel}}", "through
  // the connected web scraper"); nine marketing templates shipped clauses of
  // 90 to 309 characters, and one unbound clause listed which of eleven
  // checks the text fallback could run. That is a paragraph in a chip, and
  // the reader cannot select, wrap or edit any of it. What a clause used to
  // explain belongs in plain prose beside the token: an edge case, a rule, the
  // rest of the step.
  //
  // Ceilings, not targets: 80 is where the catalog sits after a pass, with the
  // long tail below it still worth shortening. `platform_chat` is a keyword,
  // not a clause. Frozen: three pre-existing clauses over the line, listed by
  // connector; the set only shrinks.
  const MAX_CLAUSE = 80;
  const MAX_FALLBACK = 40;
  const KNOWN_LONG_CLAUSES = new Set([
    'employee-onboarding-specialist/opt-documents/whenUnbound',
    'sales-quote-coordinator/opt-documents/whenUnbound',
    'technical-writer/opt-documents/whenUnbound',
  ]);
  it.each(files)('%s keeps its connector clauses and fallbacks chip-sized', (file) => {
    const tpl = load(file);
    const reqs = [
      ...((tpl.requiredConnectors as Array<Record<string, unknown>>) ?? []),
      ...((tpl.optionalConnectors as Array<Record<string, unknown>>) ?? []),
    ];
    const over: string[] = [];
    const frozenStillOver: string[] = [];
    for (const r of reqs) {
      const prose = r.prose as { whenBound?: string; whenUnbound?: string } | undefined;
      for (const side of ['whenBound', 'whenUnbound'] as const) {
        const clause = prose?.[side];
        if (typeof clause !== 'string' || clause === 'platform_chat') continue;
        const key = `${tpl.id}/${r.id}/${side}`;
        if (clause.length <= MAX_CLAUSE) continue;
        (KNOWN_LONG_CLAUSES.has(key) ? frozenStillOver : over).push(`${key} (${clause.length})`);
      }
      for (const o of (r.objects as Array<{ id: string; fallback?: string }>) ?? []) {
        if (typeof o.fallback === 'string' && o.fallback.length > MAX_FALLBACK) {
          over.push(`${tpl.id}/${r.id}/pick:${o.id}.fallback (${o.fallback.length})`);
        }
      }
    }
    expect(over).toEqual([]);
    // A frozen entry that came under the line is removed from the set, so the
    // ratchet only ever tightens.
    const frozenHere = [...KNOWN_LONG_CLAUSES].filter(k => k.startsWith(`${tpl.id}/`));
    expect(frozenStillOver.map(k => k.replace(/ \(\d+\)$/, '')).sort()).toEqual(frozenHere.sort());
  });
});
