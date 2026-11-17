// A sha that YAML silently turned into a number.
//
// Roughly one hexadecimal string in three has the shape `<digits>e<digits>` and
// nothing else, which YAML reads as scientific notation: `head: 2358e17` loads
// as 235800000000000000000, and the original characters are unrecoverable.
// `head: 03d4fc5` survives untouched because it contains letters — so the fault
// appears in some fixtures and not others, and looks like a bug anywhere except
// where it is.
//
// It cost three of the code-reviewer's four cases their head sha. The action
// ledger then recorded WHICH pull request was reviewed and not at which commit,
// so the idempotency check could only answer "you did something here, I cannot
// tell at which revision" — and an agent handed that reasonably reviews again.
//
// Caught at load, because reading a sha and noticing it happens to be legal
// scientific notation is not something a person reliably does.
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { load as loadYaml } from 'js-yaml';
import { validateTemplate } from '../validator';

const base = {
  id: 'x',
  name: 'X',
  role: 'Reviewer',
  department: 'engineering',
  description: 'x',
  responsibilities: ['Reviews things.'],
};

const withHead = (head: unknown) => ({
  ...base,
  evals: [{
    id: 'c',
    trigger: { source: 'github', entityType: 'PullRequest', payload: { number: 1, head } },
    turns: ['a thing happened'],
    expected: { calls_tool: ['t'] },
  }],
});

describe('a revision identifier that loaded as a number', () => {
  it('is refused, and the error names the field and the cause', () => {
    let message = '';
    try {
      validateTemplate(withHead(235800000000000000000));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('head');
    expect(message).toContain('scientific notation');
  });

  it('does not complain when the same sha is quoted', () => {
    let message = '';
    try {
      validateTemplate(withHead('2358e17'));
    } catch (err) {
      message = (err as Error).message;
    }
    // It may fail for other reasons this fixture does not satisfy; what must
    // not appear is the sha complaint.
    expect(message).not.toContain('scientific notation');
  });
});

// The shipped fixtures, not just a constructed one: the guard exists because
// real cases lost their shas, and a rule nothing in the catalog is checked
// against is a rule that passes while the catalog is wrong.
describe('every shipped eval fixture', () => {
  const CATALOG = join(__dirname, '..', 'catalog');

  it('carries revision identifiers as strings', () => {
    const numeric: string[] = [];
    const revisionKey = /^(head|sha|commit|head_sha|headSha|commit_id|commitId)$/i;

    const walk = (value: unknown, where: string): void => {
      if (!value || typeof value !== 'object') return;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (revisionKey.test(k) && typeof v === 'number') numeric.push(`${where}.${k}`);
        else walk(v, `${where}.${k}`);
      }
    };

    for (const file of readdirSync(CATALOG).filter((f) => f.endsWith('.yaml'))) {
      const doc = loadYaml(readFileSync(join(CATALOG, file), 'utf8')) as {
        evals?: Array<{ id: string; trigger?: { payload?: unknown }; state?: unknown }>;
      };
      for (const ev of doc?.evals ?? []) {
        walk(ev.trigger?.payload, `${file}:${ev.id}:trigger.payload`);
        walk(ev.state, `${file}:${ev.id}:state`);
      }
    }

    expect(numeric).toEqual([]);
  });
});
