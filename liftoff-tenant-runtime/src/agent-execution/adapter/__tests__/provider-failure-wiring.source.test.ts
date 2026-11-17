// Every engine populates the structured failure on its error path.
//
// A SOURCE-level assertion, deliberately. The behavioural certification probes
// run against a happy transport, so an adapter that quietly stopped attaching
// `failure` would certify green — the error terminal it regressed on is never
// reached. This reads the code instead, which is the only place the wiring is
// visible without arming seven failing transports.
//
// Same idiom as the sandbox timer-ladder source guard already in the tree.

import { readFileSync } from 'fs';
import { join } from 'path';

const ADAPTER_DIR = join(__dirname, '..');

/** Every engine that owns an adapter directory and can throw a provider error.
 *  openrouter and xai are absent because they are TARGETS on the shared
 *  openai-wire adapter rather than adapters of their own,
 *  constructed with providerKind 'openrouter' — one file, already covered. */
const ADAPTERS = ['anthropic', 'openai-wire', 'codex', 'gemini', 'gemini-adk', 'gemini-cli', 'opencode'];

describe('every adapter reports the provider failure structurally', () => {
  for (const adapter of ADAPTERS) {
    describe(adapter, () => {
      const source = readFileSync(join(ADAPTER_DIR, adapter, 'index.ts'), 'utf8');

      it('imports the extractor', () => {
        expect(source).toMatch(/from '\.\.\/provider-failure'/);
      });

      it('attaches a failure to at least one error completion', () => {
        expect(source).toMatch(/failure:\s*(extractProviderFailure\(|\{)/);
      });

      // The taxonomy is only worth having if the class it produces reaches the
      // run's terminal. An adapter that computed a failure and dropped it would
      // pass the two checks above and change nothing.
      it('emits the failure on a completion event, not only into a log', () => {
        const completionsWithFailure = source.match(
          /type:\s*'completion'[\s\S]{0,400}?failure:/g,
        );
        expect(completionsWithFailure?.length ?? 0).toBeGreaterThan(0);
      });
    });
  }
});

describe('the deliberate abort is not dressed up as a provider failure', () => {
  // A HITL pause and a user stop both surface as an abort. Classifying either as
  // a provider failure would put a governance decision in the provider-failure
  // dashboard and, worse, mark it retryable.
  for (const adapter of ADAPTERS) {
    it(`${adapter} leaves 'aborted' unclassified`, () => {
      const source = readFileSync(join(ADAPTER_DIR, adapter, 'index.ts'), 'utf8');
      const abortTerminals = source.match(/reason:\s*'aborted'[^}]*\}/g) ?? [];
      for (const terminal of abortTerminals) {
        expect(terminal).not.toMatch(/failure:/);
      }
    });
  }
});
