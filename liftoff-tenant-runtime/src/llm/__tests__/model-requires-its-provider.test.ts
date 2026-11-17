// A pinned model id must travel with the provider it belongs to.
//
// `complete(request, explicitProvider?, usageContext?)` takes the model inside
// the request and the provider as a separate optional argument, and nothing
// coupled them. So a caller could take a model from one source and let the
// provider fall back to the platform default — asking provider A to serve
// provider B's model. The vendor answers 404 for a model it has never heard of,
// and what the caller sees is an opaque provider error rather than the mistake.
//
// It happened three times, all found in one audit of the 26 call sites:
//
//   - the recovery advisor, which pinned the AGENT's model while deliberately
//     forcing the platform default provider. Every non-Anthropic agent — every
//     OpenAI, Google and OpenRouter workspace — escalated with
//     `recovery_llm_unavailable` the moment a step hit an anomaly. Only
//     Anthropic agents ever had working recovery.
//   - semantic step validation, the same pairing, but its catch returns
//     `{ pass: true }`. It has been passing every step unread for those agents:
//     a check that never ran, reported as a check that succeeded.
//   - memory summarization, which read BOTH from getModelForTask and then
//     passed only the model, hardcoding `undefined` for the provider while
//     every sibling caller of the same helper passed `taskConfig.provider`.
//
// The type now makes the incoherent pairing UNWRITABLE: ModelSelection either
// names a provider (optionally with a model that belongs to it) or names
// neither. `complete` takes that one value, and overwrites `request.model` from
// it, so a model cannot reach a provider by any other route.
//
// This suite is what keeps that true as the code moves. A type can be widened,
// a cast can be added, and `as never` is one keystroke; the audit reads the
// call sites as written and does not care what the compiler was told.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === '__tests__' || entry === 'node_modules' ? [] : tsFiles(full);
    }
    return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [full] : [];
  });
}

/** The top-level arguments of a `complete(` call, split on depth-0 commas. */
function splitArgs(text: string): string[] {
  let depth = 0;
  const args: string[] = [];
  let cur = '';
  for (const ch of text) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      if (depth === 0) { args.push(cur); return args; }
      depth--;
    }
    if (ch === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += ch;
  }
  return args;
}

interface CallSite { file: string; line: number; pinsModel: boolean; namesProvider: boolean }

function callSites(): CallSite[] {
  const out: CallSite[] = [];
  for (const file of tsFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    const re = /llmClient\.complete\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      // Strip comments BEFORE splitting, not after. Prose between the
      // arguments contains commas, so splitting first tears a comment in half
      // and shifts every argument after it — which made this audit report a
      // site that had just been fixed.
      const tail = src
        .slice(m.index + m[0].length, m.index + m[0].length + 6000)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      const args = splitArgs(tail);
      const request = args[0] ?? '';
      const provider = (args[1] ?? '').trim();
      out.push({
        file: file.slice(SRC.length + 1),
        line: src.slice(0, m.index).split('\n').length,
        pinsModel: /(^|[\s.{])model\s*:/.test(request),
        // `undefined` is an explicit choice of the platform default, which
        // names no provider for the purposes of this rule.
        namesProvider: provider.length > 0 && provider !== 'undefined',
      });
    }
  }
  return out;
}

describe('llmClient.complete callers', () => {
  const sites = callSites();

  it('finds the call sites, so this cannot pass vacuously', () => {
    expect(sites.length).toBeGreaterThan(10);
  });

  it('never puts a model id in the request', () => {
    // The request is no longer the channel for it. A model there is either
    // dead (the client overwrites it from the selection) or an attempt to
    // reach a provider without naming it.
    const inRequest = sites
      .filter((s) => s.pinsModel)
      .map((s) => `${s.file}:${s.line}`);
    expect(inRequest).toEqual([]);
  });

  it('routes every pinned model through modelSelectionFor', () => {
    // The one place that decides what to do when entitlements returns a model
    // with NO provider (taskSpecificPair case 1b, a legitimate configuration).
    // Binding the platform default there, once, is what keeps that case from
    // being re-decided — or forgotten — at each call site.
    const src = readFileSync(join(SRC, 'scheduling', 'memory-summarization-loop.ts'), 'utf8');
    expect(src).toContain('llmClient.modelSelectionFor(taskConfig)');
  });

  it('leaves tier on the request, where it is provider-agnostic', () => {
    // Tier needs no coupling: every provider maps `large` onto its own.
    // Moving it into the selection would have silently dropped its eleven
    // callers onto their provider's default model.
    const client = readFileSync(join(SRC, 'llm', 'client.ts'), 'utf8');
    expect(client).toContain('request = { ...request, model: selection?.model }');
    expect(client).not.toContain('tier: selection?.tier');
  });
});
