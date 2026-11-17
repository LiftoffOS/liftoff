// Tests: every recurring role has DECIDED whether it can act twice.
//
// `have_i_acted_on` is the only thing that answers "have I done this before",
// and `findMissingIdempotencyStep` is the only thing that forces it into a
// graph. That fence reads `requiresIdempotencyCheck` off the template, so a
// template that does not declare it is exempt from the check — silently, and
// with no signal anywhere that a decision was skipped.
//
// Until this test, the declaration was produced by exactly one thing: a
// phrase-matching rule in the validator looking for "confirm you have not
// already". Across 65 templates, NOT ONE declared the flag without that regex
// matching first, so its coverage was the whole mechanism rather than a
// backstop on top of one. What a phrase match cannot see, nothing saw:
//
//   - `competitive-intelligence-analyst` writes "week-over-week" and the
//     sibling comparison fence looks for "week over week". A hyphen.
//   - `order-fulfillment-coordinator` says "skip anything you have already
//     handled" and paraphrases this tool's documented limits verbatim, so its
//     author plainly had the tool in mind. Different words, no declaration. It
//     ships, invoices, cancels and refunds every five minutes.
//   - `code-reviewer` carries no such sentence at all — and posting repeated
//     "review ready" messages about one pull request is exactly the failure
//     `have_i_acted_on` was built for.
//
// So the default is inverted here. A template that does not fire by hand can
// be re-delivered: a cron sweep wakes against a backlog it has already worked,
// and an event topic re-delivers by design. Every one of them must either
// declare the check or say here, in writing, why it cannot act twice.
//
// Manual templates are out of scope: a person pressing the button again has
// decided to run it again, and that is not the trigger repeating itself.
//
// EXEMPT is not a permission list. An entry is a claim that re-delivery is
// harmless for that role, and it needs a reason a reader can check.

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const CATALOG_DIR = path.join(__dirname, '..', 'catalog');

interface Template {
  id?: string;
  requiresIdempotencyCheck?: boolean;
  defaultTriggerConfig?: { type?: string };
}

/** Roles whose trigger repeats and for which acting twice is genuinely
 *  harmless. Each entry states why, because the claim is what is being
 *  reviewed — not the presence of the key. */
const EXEMPT: Record<string, string> = {};

const files = fs.readdirSync(CATALOG_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

function load(file: string): Template {
  return yaml.load(fs.readFileSync(path.join(CATALOG_DIR, file), 'utf8')) as Template;
}

describe('idempotency declaration ratchet', () => {
  const recurring = files
    .map(f => ({ file: f, tpl: load(f) }))
    .filter(({ tpl }) => (tpl.defaultTriggerConfig?.type ?? 'manual') !== 'manual');

  it('finds recurring templates to check', () => {
    // A loader change that silently matched nothing would make every
    // assertion below vacuous.
    expect(recurring.length).toBeGreaterThan(40);
  });

  it.each(recurring.map(({ file, tpl }) => [file, tpl] as const))(
    '%s declares requiresIdempotencyCheck or is exempt with a reason',
    (file, tpl) => {
      const id = tpl.id ?? file.replace(/\.ya?ml$/, '');
      if (tpl.requiresIdempotencyCheck === true) return;
      const reason = EXEMPT[id];
      expect(
        typeof reason === 'string' && reason.trim().length > 0
          ? 'exempt'
          : `${id} has a repeating trigger (${tpl.defaultTriggerConfig?.type}) and does not declare `
            + 'requiresIdempotencyCheck. Its trigger re-delivers, so nothing stops it acting twice on the '
            + 'same thing. Declare it — and add the obligation to the workflow prose as step 1, the way '
            + 'the templates that already declare it do — or add an EXEMPT entry saying why re-delivery '
            + 'is harmless for this role.',
      ).toBe('exempt');
    },
  );

  it('lists no exemption for a template that no longer exists or already declares', () => {
    // A stale exemption is the failure this whole family exists to prevent: it
    // reads as a considered decision and covers nothing.
    const byId = new Map(recurring.map(({ file, tpl }) => [tpl.id ?? file.replace(/\.ya?ml$/, ''), tpl]));
    for (const id of Object.keys(EXEMPT)) {
      const tpl = byId.get(id);
      expect(tpl ? 'present' : `EXEMPT names ${id}, which is not a recurring template`).toBe('present');
      expect(tpl?.requiresIdempotencyCheck === true
        ? `EXEMPT names ${id}, which already declares requiresIdempotencyCheck — remove the exemption`
        : 'ok').toBe('ok');
    }
  });
});
