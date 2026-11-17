/**
 * "There is nothing there yet" is a business condition, not a broken contract.
 *
 * Two failures wear one class and they are not the same thing.
 *
 * A reference that cannot be READ — a missing root, an absent key — means the
 * step was never attempted on the data it was written against. Routing that
 * down the author's `onFailure` presents a defect as an anticipated condition:
 * a support agent reading `{{input.message.threadId}}` on a cron fire carrying
 * no message would take its failure branch into "acknowledge", and mark mail
 * read in a mailbox it had never opened.
 *
 * A reference that resolved to NULL is the opposite. The producing step RAN,
 * and null is what it had to say. Take a step s14 that
 * updates the snapshot document at
 * `{"document_id":"{{steps.s9.snapshot_doc_id}}"}` with `onFailure: s15`, which
 * creates one — and on a FIRST run there is no snapshot, so s9 reports null by
 * design. That is the author answering the exact question, and sending it to a
 * recovery model turn would only rediscover a fact the graph states.
 *
 * It is the common shape: "update it, or make it if it is not there".
 */
import { TemplateResolutionError } from '../types';
import { readFileSync } from 'fs';
import { join } from 'path';

const SERVICE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
const TEMPLATE = readFileSync(join(__dirname, '..', 'template.ts'), 'utf8');

describe('the error carries which failure it was', () => {
  it('defaults to a broken contract, so an unmarked thrower keeps the old routing', () => {
    expect(new TemplateResolutionError('steps.s9.x', 'msg').producedNull).toBe(false);
  });

  it('marks the null case', () => {
    expect(new TemplateResolutionError('steps.s9.x', 'msg', true).producedNull).toBe(true);
  });

  it('keeps the reference, which the recovery prompt reads', () => {
    expect(new TemplateResolutionError('steps.s9.snapshot_doc_id', 'msg', true).reference)
      .toBe('steps.s9.snapshot_doc_id');
  });
});

describe('only the null thrower marks itself', () => {
  it('the null-into-text throw passes the marker', () => {
    const at = TEMPLATE.indexOf('resolved to null, and it is being interpolated');
    expect(at).toBeGreaterThan(-1);
    expect(TEMPLATE.slice(at, at + 900)).toMatch(/\n\s*true,\n\s*\);/);
  });

  it('the UNDEFINED throw does not', () => {
    // An absent key is the case the exclusion exists for. Marking it would
    // route a genuinely broken contract down the author's failure branch.
    const at = TEMPLATE.indexOf('resolved to undefined');
    expect(at).toBeGreaterThan(-1);
    const thrower = TEMPLATE.slice(at, at + 400);
    expect(thrower).not.toMatch(/\n\s*true,\n\s*\);/);
  });

  it('the empty-root throw does not either', () => {
    const at = TEMPLATE.indexOf('is a valid root but');
    expect(at).toBeGreaterThan(-1);
    expect(TEMPLATE.slice(at, at + 600)).not.toMatch(/\n\s*true,\n\s*\);/);
  });
});

describe('the step loop reads it', () => {
  it('a null-produced template failure is not a contract defect', () => {
    expect(SERVICE).toContain('e instanceof TemplateResolutionError && !e.producedNull');
  });

  it('a condition with no input stays unconditionally a defect', () => {
    // No narrowing reaches this one: the comparison was never made, so there is
    // no else-case the author could have meant. Asserted as presence plus the
    // ABSENCE of a narrowing, rather than by pinning the term to the end of the
    // expression — being last is incidental, and a third defect joined it.
    expect(SERVICE).toMatch(/\|\|\s*e instanceof ConditionInputMissingError\b/);
    expect(SERVICE).not.toMatch(/ConditionInputMissingError\s*&&\s*!/);
  });

  it('a loop collection that did not resolve stays unconditionally a defect', () => {
    // And for the same reason, with one difference worth stating: there is no
    // `producedNull` exception here. A loop's report of nothing is `[]`, which
    // iterates cleanly and never reaches the classifier — so null, absent and
    // wrong-shaped all mean the body ran zero times and the step never ran.
    expect(SERVICE).toMatch(/\|\|\s*e instanceof LoopCollectionUnresolvedError\b/);
    expect(SERVICE).not.toMatch(/LoopCollectionUnresolvedError\s*&&\s*!/);
  });

  it('onFailure is still gated on the contract-defect test', () => {
    expect(SERVICE).toMatch(/if\s*\(step\.onFailure\s*&&\s*!isPauseSignal\s*&&\s*!isContractDefect\)/);
  });

  // THE CLASSIFIER IS ONLY AS GOOD AS THE TYPE THAT REACHES IT.
  //
  // Every `applyTemplate` call sat inside a catch that logged the error and
  // handed back a string, or rewrapped it in a plain Error — so the classifier
  // above, which tests `instanceof TemplateResolutionError`, could never fire
  // for a tool_call step, a loop iteration or a capability step. The rule was
  // intact; the type was destroyed one frame below it. Three sites, and a
  // fourth would do it again, so this is asserted over the source rather than
  // left to the three behavioural tests that cover today's three.
  //
  // `ask_user` is the one deliberate exception: it renders the step's question
  // and falls back to the question as authored, which is not a dispatch.
  it('no applyTemplate catch swallows the type the classifier reads', () => {
    const sites = [...SERVICE.matchAll(/applyTemplate\(/g)].map((m) => m.index ?? 0);
    expect(sites.length).toBeGreaterThan(2);
    const unguarded: string[] = [];
    sites.forEach((at, i) => {
      // Each call's own handler, bounded by the NEXT call site rather than by a
      // character count: a guard belonging to a later site must not be
      // miscredited to this one, and the comment explaining a guard can be
      // longer than any fixed window.
      const until = sites[i + 1] ?? SERVICE.length;
      const window = SERVICE.slice(at, until);
      if (window.includes('renderedQuestion = step.question')) return;
      if (!/if \(err instanceof TemplateResolutionError\) throw err;/.test(window)) {
        unguarded.push(SERVICE.slice(at, at + 90).split('\n')[0]);
      }
    });
    expect(unguarded).toEqual([]);
  });
});
