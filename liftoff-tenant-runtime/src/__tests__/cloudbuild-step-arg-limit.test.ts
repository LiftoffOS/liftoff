// Cloud Build rejects any single step arg over 10,000 characters.
//
// Each deploy step here is one `bash -c` script, which means the whole script is
// ONE argument. A large step such as `deploy-agent-service` can sit close to
// the ceiling, so adding a few environment variables and their comments fails
// the build at validation with:
//
//     invalid build: invalid .steps field: build step 28 arg 1 too long (max: 10000)
//
// That message names no step id, no file and no cause, and it fires before any
// step runs — so the signal is a build that never starts, after a push, with
// nothing in the logs to read. Nothing local catches it: the YAML is valid, the
// tests pass, the typecheck passes.
//
// This is the cheap guard. It fails locally, names the step, and says how much
// room is left, so the ceiling is visible before a push rather than after.
// Rationale for the flags themselves lives in docs/agent-service-flags.md, which
// is where prose belongs precisely because a doc has no size limit.

import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';

/** Cloud Build's hard limit on one arg. Not configurable. */
const MAX_ARG_CHARS = 10_000;

/** Fail before the ceiling, not at it. A step this close is one comment away from
 *  breaking, which is exactly the state deploy-agent-service was in. */
const WARN_THRESHOLD = 9_000;

interface CloudBuild {
  steps: Array<{ id?: string; args?: unknown[] }>;
}

const config = load(
  readFileSync(join(__dirname, '..', '..', 'cloudbuild.yaml'), 'utf8'),
) as CloudBuild;

const args = config.steps.flatMap((step, index) =>
  (step.args ?? []).map((arg, argIndex) => ({
    label: `step ${index} (${step.id ?? 'unnamed'}) arg ${argIndex}`,
    chars: String(arg).length,
  })),
);

describe('cloudbuild.yaml step args fit Cloud Build limits', () => {
  it('parses and has steps to check', () => {
    expect(args.length).toBeGreaterThan(0);
  });

  it('no arg exceeds the 10,000-character limit', () => {
    const over = args.filter(a => a.chars > MAX_ARG_CHARS);
    expect(
      over.map(a => `${a.label}: ${a.chars} chars (${a.chars - MAX_ARG_CHARS} over)`),
    ).toEqual([]);
  });

  it('no arg is within 1,000 characters of the limit', () => {
    // Headroom is the point. Passing at 9,698 is how the next person's one-line
    // addition becomes a failed build they did not cause.
    const tight = args.filter(a => a.chars > WARN_THRESHOLD);
    expect(
      tight.map(a => `${a.label}: ${a.chars} chars, only ${MAX_ARG_CHARS - a.chars} left. `
        + 'Move the prose to docs/agent-service-flags.md rather than trimming the decision.'),
    ).toEqual([]);
  });
});
