// FITNESS FUNCTION — every caller of `openByokSession` has DECIDED whether it can
// use a managed-primary session, and said why.
//
// The decision is invisible either way. `acceptManagedGateway` defaults to false,
// so a caller that omits it keeps today's behaviour exactly and nothing reports
// that it did — which is the right default and the reason a new call site can join
// without anybody noticing that the capture never reaches it. And passing it where
// it does not belong is worse than silent: a run holds more than one session under
// one invocation id, and a managed row landing beside a genuinely customer-funded
// turn is how the ledger's funding answer flips.
//
// So the call sites are enumerated from SOURCE rather than listed by hand, and a
// new one fails here, in the change that adds it.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...walk(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Each `openByokSession(...)` call, as the file it is in and the argument block
 *  it was given. Anchored on the call so a mere import does not count. */
function callSites(): Array<{ file: string; block: string }> {
  const sites: Array<{ file: string; block: string }> = [];
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');
    const relative = file.slice(SRC.length + 1);
    // The definition itself is not a call site.
    if (relative === join('byok', 'session.ts')) continue;
    const re = /openByokSession\(\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      // The argument object, bounded generously. Long enough to contain the flag
      // wherever in the literal it was written.
      sites.push({ file: relative, block: source.slice(m.index, m.index + 2000) });
    }
  }
  return sites;
}

/**
 * Call sites that must NOT take a managed-primary session, each for a reason
 * about the caller rather than about missing wiring.
 *
 * Named rather than pattern-matched: a site that quietly stops opting in should
 * fail this suite, not join a category by omission. Adding a name here is a
 * deliberate edit a reviewer can question.
 */
const DOES_NOT_ACCEPT: Record<string, string> = {
  // In-process SDK calls. They read the vendor's own HTTP response already, so
  // the gateway has no number to add — and routing every llmClient call through
  // an extra hop to the control plane would buy latency and a failure mode for
  // nothing.
  'llm/byok-routing.ts':
    'in-process SDK; it already reads the vendor response, so there is nothing to capture',
  // The browser agent loop. Its credential decision is a boolean (`byok: true`)
  // that feeds attribution, and a managed session is not a customer-funded one:
  // taking one here would label Liftoff's own spend as the customer's.
  'integrations/web-fetch/stagehand-agent.ts':
    'its credential flag feeds attribution; a managed session is not customer-funded',
  // A coding session inside a turn. Its spend is priced from the runner's own
  // usage and ADDED to the outer invocation by computeCodeSessionCost, while its
  // gateway rows would land under the outer run's id — so the turn-end shortfall
  // would charge the same tokens a second time. Capturing it needs its rows to be
  // separable from the turn's first, which is a change to the row and not to this
  // call.
  'agent-execution/adapter/tools/code-session/index.ts':
    'its spend is already added to the outer invocation; gateway rows under the same run id would double-count',
};

describe('every openByokSession caller has decided about the capture', () => {
  const sites = callSites();

  it('finds call sites at all, so this cannot pass vacuously', () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it.each(sites.map((s, i) => [`${s.file}#${i}`, i] as const))(
    '%s either opts in or is a named exception',
    (_label, i) => {
      const { file, block } = sites[i];
      const optsIn = /acceptManagedGateway:\s*true/.test(block);
      if (DOES_NOT_ACCEPT[file]) {
        // A stated exception must NOT opt in. The reason is in the table above,
        // where a reviewer reads it.
        expect(optsIn).toBe(false);
        return;
      }
      // Anything else is a subprocess engine's turn, which is what the capture is
      // for. If this fails for a new call site, decide: opt in, or add a name and
      // a reason above.
      expect(optsIn).toBe(true);
    },
  );

  it('carries no exception for a call site that no longer exists', () => {
    const files = new Set(sites.map((s) => s.file));
    expect(Object.keys(DOES_NOT_ACCEPT).filter((f) => !files.has(f))).toEqual([]);
  });

  it('gives every exception a reason, not just a name', () => {
    for (const [file, reason] of Object.entries(DOES_NOT_ACCEPT)) {
      expect(`${file}: ${reason}`.length).toBeGreaterThan(file.length + 30);
    }
  });
});

describe('every site that opts in also reads back what the gateway saw', () => {
  // THE OTHER END OF THE SAME WIRE. Opting in without reading the usage back is
  // the shape of this repo's dominant defect: the session opens, the gateway
  // records every token, and the invocation still bills from the engine's own
  // short count. It would pass every other check in this suite.
  const source = readFileSync(join(SRC, 'agent-execution', 'service.ts'), 'utf8');

  it('reads it at the fresh turn\'s two completion paths and at the resumed half', () => {
    // Success, salvage, and the continuation of a paused run. Three, because a run
    // that errored or paused has still spent every token the gateway counted.
    expect(source.match(/readGatewayRunUsage\(/g) ?? []).toHaveLength(3);
  });

  it('bounds every read to the half that is billing', () => {
    // Unbounded, a continuation's sum contains the paused half's requests, which
    // the paused half was already charged for.
    //
    // Windowed from each call rather than matched as a whole expression: the
    // argument lists carry comments, and a regex that has to reach the closing
    // paren through them is a regex that silently matches fewer calls than exist
    // — which is how this assertion would pass while covering one of three.
    const windows: string[] = [];
    for (let i = source.indexOf('readGatewayRunUsage('); i >= 0;
         i = source.indexOf('readGatewayRunUsage(', i + 1)) {
      windows.push(source.slice(i, i + 900));
    }
    expect(windows).toHaveLength(3);
    for (const w of windows) expect(w).toContain('state.startTime');
  });

  it('prefers the counts at every completion that writes them', () => {
    expect(source.match(/preferGatewayCounts\(/g) ?? []).toHaveLength(3);
  });
});
