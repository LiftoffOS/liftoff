// One job, one name.
//
// `role` is the short job title handed to distillation; `displayName` is what
// the gallery card and the hired team are called; `id` is how everything else
// addresses the template. They drifted: a card offered a "CP Checklist
// Associate" and distillation was told to build a "CP Associate", and the id
// `lpa-analyst` named a template whose card read "Limited Partnership Agreement
// Analyst". None of that fails anything at runtime, which is why it needs a test.

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const CATALOG = path.join(__dirname, '..', 'catalog');

const kebab = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const templates = fs
  .readdirSync(CATALOG)
  .filter((f) => f.endsWith('.yaml'))
  .map((filename) => ({
    filename,
    t: yaml.load(fs.readFileSync(path.join(CATALOG, filename), 'utf8')) as {
      id: string; role: string; displayName: string;
    },
  }));

it('has templates to check', () => {
  expect(templates.length).toBeGreaterThan(50);
});

describe.each(templates)('$filename', ({ filename, t }) => {
  it('calls the job the same thing on the card and in distillation', () => {
    // A card that promises one job while the agent is built for another is a
    // mismatch no downstream check can see.
    expect(t.displayName).toBe(t.role);
  });

  it('has an id derived from that name', () => {
    expect(t.id).toBe(kebab(t.displayName));
  });

  it('lives in a file named after its id', () => {
    // Not enforced by the loader, which reads `id` from the body. Enforced here
    // because an id and a filename that disagree make every grep lie.
    expect(filename).toBe(`${t.id}.yaml`);
  });
});
