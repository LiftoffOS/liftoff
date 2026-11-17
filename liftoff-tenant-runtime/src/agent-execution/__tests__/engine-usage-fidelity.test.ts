// FITNESS FUNCTION — every engine has been DECIDED about, and every turn that
// asks for the capture says whether it got it.
//
// Two silent failures are fenced here, and they are different failures.
//
// The first is a new engine. `engineUsageFidelity` answers 'complete' for
// anything it does not recognise, which is the right default for the counter's
// label and the wrong default for a subprocess engine that cannot report its own
// thinking tokens: such an engine would join the runtime, under-bill on every
// bypassed session, and be labelled as if the bypass cost nothing. So the
// decision table below is exhaustive over the engines a vendor can actually
// resolve to, and a new one fails here until somebody classifies it.
//
// The second is a new call site. A turn that passes `acceptManagedGateway: true`
// has said it needs the vendor's own response; if it does not also report whether
// the session opened, a bypass there is invisible — which is the whole defect
// this counter exists for, reintroduced one call site over.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { VENDOR_ENGINE_IDS } from '../adapter/vendors';
import {
  ENGINES_THAT_CANNOT_PRICE_THEMSELVES,
  engineUsageFidelity,
  noteGatewaySessionOutcome,
} from '../engine-usage-fidelity';
import * as metrics from '../../observability/runtime-extensions-metrics';

/**
 * The decision, written out.
 *
 * 'incomplete' is a claim about the VENDOR's reporting and needs evidence, not a
 * guess: opencode splits reasoning out of the completion count it publishes, and
 * the Gemini CLI never names thinking at all. Everything else reports a summary
 * that can be priced, so a missing session there costs a cross-check rather than
 * money.
 */
const EXPECTED: Record<string, 'complete' | 'incomplete'> = {
  'claude-agent-sdk': 'complete',
  'openai-agents': 'complete',
  'openai-codex': 'complete',
  'google-genai': 'complete',
  'google-adk': 'complete',
  'google-gemini-cli': 'incomplete',
  'openrouter-openai-wire': 'complete',
  'xai-openai-wire': 'complete',
  opencode: 'incomplete',
};

describe('engine usage fidelity', () => {
  it('classifies every engine a vendor can resolve to', () => {
    const unclassified = VENDOR_ENGINE_IDS.filter((id) => !(id in EXPECTED));
    expect(unclassified).toEqual([]);
  });

  it('answers what the table says, for each of them', () => {
    for (const id of VENDOR_ENGINE_IDS) {
      expect(`${id}:${engineUsageFidelity(id)}`).toBe(`${id}:${EXPECTED[id]}`);
    }
  });

  it('holds the two engines this capture exists for', () => {
    // ENGINE_SUBSET_OK: the two engines are the assertion. Naming every engine
    // here would assert the opposite of what this test is for, and the
    // exhaustiveness the ratchet wants is the first case in this describe —
    // every resolvable engine has an expected answer.
    expect([...ENGINES_THAT_CANNOT_PRICE_THEMSELVES].sort()).toEqual(
      ['google-gemini-cli', 'opencode'],
    );
  });

  it('names no engine that is not a real one', () => {
    const real = new Set<string>(VENDOR_ENGINE_IDS);
    for (const id of ENGINES_THAT_CANNOT_PRICE_THEMSELVES) {
      expect(real.has(id)).toBe(true);
    }
  });
});

describe('noteGatewaySessionOutcome', () => {
  let inc: jest.SpyInstance;
  beforeEach(() => {
    inc = jest.spyOn(metrics.gateway_session_total, 'inc').mockImplementation(() => {});
  });
  afterEach(() => inc.mockRestore());

  it('emits on the OPENED path too, so the bypass count has a denominator', () => {
    noteGatewaySessionOutcome({
      engineId: 'google-gemini-cli',
      opened: true,
      resolvedProvider: 'google',
    });
    expect(inc).toHaveBeenCalledWith({
      engine: 'google-gemini-cli',
      opened: 'yes',
      fidelity: 'incomplete',
      provider: 'google',
    });
  });

  it('marks a bypass on an engine that cannot price itself as incomplete', () => {
    noteGatewaySessionOutcome({ engineId: 'opencode', opened: false, resolvedProvider: 'glm' });
    expect(inc).toHaveBeenCalledWith({
      engine: 'opencode',
      opened: 'no',
      fidelity: 'incomplete',
      provider: 'glm',
    });
  });

  it('marks a bypass on a self-reporting engine as complete', () => {
    noteGatewaySessionOutcome({
      engineId: 'claude-agent-sdk',
      opened: false,
      resolvedProvider: 'anthropic',
    });
    expect(inc).toHaveBeenCalledWith({
      engine: 'claude-agent-sdk',
      opened: 'no',
      fidelity: 'complete',
      provider: 'anthropic',
    });
  });
});

// ─── The call-site half ──────────────────────────────────────────────────

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

describe('every turn that asks for the capture reports whether it got it', () => {
  it('pairs each acceptManagedGateway call site with an outcome note', () => {
    const unreported: string[] = [];
    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      const relative = file.slice(SRC.length + 1);
      const re = /openByokSession\(\{/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        // The call's argument block, then the lines just past it — generous
        // enough to contain the note however the literal was formatted.
        const window = source.slice(m.index, m.index + 3000);
        if (!/acceptManagedGateway:\s*true/.test(window)) continue;
        if (!/noteGatewaySessionOutcome\(/.test(window)) {
          unreported.push(`${relative} @ ${m.index}`);
        }
      }
    }
    expect(unreported).toEqual([]);
  });
});
