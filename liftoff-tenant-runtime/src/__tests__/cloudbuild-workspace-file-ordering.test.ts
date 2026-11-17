// A step that reads a /workspace file must wait for the step that writes it.
//
// `waitFor` is the whole of Cloud Build's ordering: a step with no edge to a
// producer runs CONCURRENTLY with it. Two steps sharing a file through
// /workspace therefore have a dependency that exists in the shell script and
// nowhere in the DAG, and nothing validates the pair.
//
// `deploy-tool-gateway-service` sources /workspace/operator-flags.env, which
// `resolve-operator-flags` writes. Without a `waitFor` edge a build can lose
// that race:
//
//     bash: line 8: /workspace/operator-flags.env: No such file or directory
//     ERROR: build step 39 failed: step exited with non-zero status: 1
//
// `deploy-agent-service` reads the same file, so the file has two consumers and
// both must declare the dependency — a file with two consumers where only one
// says so is a common defect class, here in YAML.
//
// WHY IT IS WORTH A TEST RATHER THAN A FIX AND A SHRUG. The failure is a RACE,
// so it is intermittent, it lands in a DEPLOY step after every gate has passed,
// and it leaves the branch head ahead of what is deployed with nothing alerting.
// An intermittent red in the deploy path teaches people that red means "not your
// fault, retry" — and that habit is how a real failure gets waved through.
//
// Transitive edges count: a consumer that reaches the producer through another
// step is correctly ordered, and demanding a direct edge would force noise into
// the DAG.

import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';

interface Step { id?: string; args?: unknown; waitFor?: string[] }

const CLOUDBUILD = load(
  readFileSync(join(__dirname, '..', '..', 'cloudbuild.yaml'), 'utf8'),
) as { steps: Step[] };

/** Files passed between steps through the shared /workspace volume, and the step
 *  that writes each one. Listed rather than inferred: deciding "writes" from
 *  shell text means parsing redirections, heredocs and `tee`, and a parser that
 *  is wrong in either direction is worse than a list that is checked. */
const WORKSPACE_FILES: Array<{ file: string; producer: string }> = [
  { file: 'operator-flags.env', producer: 'resolve-operator-flags' },
];

const byId = new Map<string, Step>();
for (const s of CLOUDBUILD.steps) if (s.id) byId.set(s.id, s);

/** Does `from` reach `target` through any chain of waitFor edges? */
function reaches(from: string, target: string, seen = new Set<string>()): boolean {
  if (seen.has(from)) return false;
  seen.add(from);
  const wf = byId.get(from)?.waitFor ?? [];
  if (wf.includes(target)) return true;
  return wf.some((w) => reaches(w, target, seen));
}

describe('a /workspace file is read only after it is written', () => {
  it.each(WORKSPACE_FILES)('$file: the producer exists', ({ producer }) => {
    expect(byId.has(producer)).toBe(true);
  });

  it.each(WORKSPACE_FILES)('$file: every consumer waits for $producer', ({ file, producer }) => {
    const consumers = CLOUDBUILD.steps
      .filter((s) => s.id && s.id !== producer && JSON.stringify(s.args ?? '').includes(file))
      .map((s) => s.id!);

    // Not vacuous: the file has consumers, or the entry is stale and should go.
    expect(consumers.length).toBeGreaterThan(0);

    const unordered = consumers.filter((c) => !reaches(c, producer));
    expect(unordered).toEqual([]);
  });
});
