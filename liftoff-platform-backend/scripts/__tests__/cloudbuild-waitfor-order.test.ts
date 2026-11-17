// A `waitFor` may only name a step DEFINED EARLIER in the file.
//
// Cloud Build enforces this, and it enforces it at config-validation time —
// before step 0 runs. So the failure is not a red step in a build you can read:
// it is a build with no steps, no SHORT_SHA and no trigger name, whose only
// evidence is one line of statusDetail:
//
//   invalid build: invalid .steps field: build step #10 -
//   "dump-registry-baseline" depends on "build", which has not been defined
//
// It does not appear in the trigger's own build list, because it never became
// that trigger's build. A push therefore looks like it simply did not fire, and
// the natural next move — waiting longer for a build that will never exist — is
// the wrong one. That is what this file costs a second of a test run to prevent.
//
// The property is ORDER, not existence. A name that matches a real step still
// fails validation when that step is declared further down, which is why
// eyeballing the ids is not enough: every id in the failing config was real.

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

interface Step {
  id?: string;
  waitFor?: string[];
}

const CONFIGS = fs
  .readdirSync(path.join(__dirname, '..', '..'))
  .filter((f) => f === 'cloudbuild.yaml' || (f.startsWith('cloudbuild') && f.endsWith('.yaml')));

describe.each(CONFIGS)('%s', (file) => {
  const doc = yaml.load(
    fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8'),
  ) as { steps?: Step[] };
  const steps = doc.steps ?? [];

  it('has steps', () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  it('never waits on a step that is declared later, or not at all', () => {
    const idAt = new Map<string, number>();
    steps.forEach((s, i) => {
      if (s.id) idAt.set(s.id, i);
    });

    const problems: string[] = [];
    steps.forEach((step, i) => {
      for (const dep of step.waitFor ?? []) {
        // '-' means "start immediately", not a step name.
        if (dep === '-') continue;
        const at = idAt.get(dep);
        if (at === undefined) {
          problems.push(`step #${i} "${step.id ?? '(unnamed)'}" waits on "${dep}", which no step defines`);
        } else if (at >= i) {
          problems.push(
            `step #${i} "${step.id ?? '(unnamed)'}" waits on "${dep}", which is declared later (#${at}) `
            + '— Cloud Build rejects the whole config at validation time',
          );
        }
      }
    });
    expect(problems).toEqual([]);
  });

  it('gives every step an id, so a waitFor can name it', () => {
    const unnamed = steps
      .map((s, i) => (s.id ? null : `step #${i}`))
      .filter((s): s is string => s !== null);
    expect(unnamed).toEqual([]);
  });
});
