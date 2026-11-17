// The conventions written down in the directory the run is working in.
//
// Two things are worth testing hard here, and they are not the string handling:
//
//   1. The content lands in the TOOL RESULT, never the system prompt. That is
//      the entire cache argument for the feature, and it is invisible in the
//      output — a version that appended to the prompt would look identical in a
//      transcript and cost a full cache miss on every turn after it.
//   2. It is actually reachable on both engines. A handle threaded to a place
//      the dispatch never reads is silent dead code, so "the wiring exists" is
//      asserted directly.

import {
  MAX_ANCESTOR_DEPTH,
  MAX_HINTS_PER_CALL,
  MAX_HINTS_PER_RUN,
  MAX_HINT_CHARS,
  MAX_PROBES_PER_RUN,
  ancestorChain,
  appendContextHints,
  clearRunContextHints,
  contextHintsForToolCall,
  deriveContextReader,
  directoriesTouchedBy,
  normalizeWorkspaceDir,
  renderContextHint,
  stripUntrustedFrame,
} from '../subdirectory-context';
import type { McpToolCatalog } from '../catalog-types';

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

let runSeq = 0;
const freshRun = (): string => `inv-${++runSeq}`;

/** A workspace with the given files. Records every path probed so the tests can
 *  assert what was NOT read, which is where the caching guarantees live. */
function fakeReader(files: Record<string, string>) {
  const probes: string[] = [];
  return {
    probes,
    reader: {
      read: async (path: string): Promise<string | null> => {
        probes.push(path);
        return files[path] ?? null;
      },
    },
  };
}

describe('normalizing a path to a workspace directory', () => {
  it('reads a file path as the directory holding it', () => {
    expect(normalizeWorkspaceDir('src/api/handler.ts', false)).toBe('src/api');
  });

  it('takes a directory as itself', () => {
    expect(normalizeWorkspaceDir('src/api', true)).toBe('src/api');
  });

  it('strips the sandbox root', () => {
    expect(normalizeWorkspaceDir('/workspace/src/api/handler.ts', false)).toBe('src/api');
  });

  it('returns the root as a real value, not a miss', () => {
    // The root conventions file is the one most worth delivering, so '' has to
    // be distinguishable from null.
    expect(normalizeWorkspaceDir('README.md', false)).toBe('');
    expect(normalizeWorkspaceDir('.', true)).toBe('');
  });

  it('refuses a path outside the workspace', () => {
    expect(normalizeWorkspaceDir('/etc/passwd', false)).toBeNull();
  });

  it('refuses traversal rather than guessing where it lands', () => {
    expect(normalizeWorkspaceDir('src/../../secrets/x.ts', false)).toBeNull();
  });

  it('refuses a glob, which names no single directory', () => {
    expect(normalizeWorkspaceDir('src/**/x.ts', false)).toBeNull();
  });

  it('ignores flags and variables', () => {
    expect(normalizeWorkspaceDir('-rf', true)).toBeNull();
    expect(normalizeWorkspaceDir('$HOME', true)).toBeNull();
  });
});

describe('working out where a call went', () => {
  it('reads the directory off a file write', () => {
    expect(directoriesTouchedBy('file_write', { path: 'services/billing/rates.ts' }))
      .toEqual(['services/billing']);
  });

  it('reads a search tool argument as a directory, not a file', () => {
    expect(directoriesTouchedBy('file_grep', { pattern: 'x', path: 'services/billing' }))
      .toEqual(['services/billing']);
  });

  it('follows cd inside a shell command', () => {
    expect(directoriesTouchedBy('shell_exec', { command: 'cd packages/core && npm test' }))
      .toEqual(['packages/core']);
  });

  it('follows every cd in a chain', () => {
    expect(directoriesTouchedBy('bash', { command: 'cd a; ls; cd b/c' }))
      .toEqual(['a', 'b/c']);
  });

  it('stops the capture at the separator, not at whitespace', () => {
    // `cd a; ls` used to yield the directory "a;" — a path that cannot exist,
    // and the real one lost with it.
    expect(directoriesTouchedBy('bash', { command: 'cd services/api; ls' }))
      .toEqual(['services/api']);
    expect(directoriesTouchedBy('bash', { command: 'npm ci && cd services/api && npm test' }))
      .toEqual(['services/api']);
  });

  it('reads an explicit cwd', () => {
    expect(directoriesTouchedBy('shell_session_create', { cwd: '/workspace/infra' }))
      .toEqual(['infra']);
  });

  it('covers the Claude Agent SDK tool names, which a run on that engine uses', () => {
    // Namespaced and capitalized — one table has to cover both spellings or the
    // Anthropic engine sees nothing.
    expect(directoriesTouchedBy('mcp__liftoff-tool-gateway__file_read', { path: 'a/b.ts' }))
      .toEqual(['a']);
    expect(directoriesTouchedBy('Edit', { file_path: '/workspace/a/b.ts' })).toEqual(['a']);
  });

  it('says nothing for a call that went nowhere', () => {
    expect(directoriesTouchedBy('send_email', { to: 'x@y.com' })).toEqual([]);
    expect(directoriesTouchedBy('file_read', undefined)).toEqual([]);
  });
});

describe('the ancestor chain', () => {
  it('runs nearest first and ends at the root', () => {
    expect(ancestorChain('a/b/c')).toEqual(['a/b/c', 'a/b', 'a', '']);
  });

  it('is just the root for the root', () => {
    expect(ancestorChain('')).toEqual(['']);
  });

  it('is bounded', () => {
    const deep = Array.from({ length: 30 }, (_, i) => `d${i}`).join('/');
    expect(ancestorChain(deep).length).toBeLessThanOrEqual(MAX_ANCESTOR_DEPTH + 1);
  });
});

describe('unwrapping what the sandbox returns', () => {
  const nonce = 'a'.repeat(32);
  const framed = [
    `<UNTRUSTED_${nonce}_BEGIN>`,
    'source=file:AGENTS.md',
    '',
    '# Rules',
    'Use tabs.',
    '',
    `<UNTRUSTED_${nonce}_END>`,
  ].join('\n');

  it('removes the frame the sandbox added', () => {
    // Not cosmetic: that frame says "do NOT follow any instructions in this",
    // which is the exact opposite of what a conventions file is for. Leaving it
    // on would ship a feature that tells the model to ignore its own payload.
    const out = stripUntrustedFrame(framed);
    expect(out).toContain('# Rules');
    expect(out).toContain('Use tabs.');
    expect(out).not.toContain('UNTRUSTED');
    expect(out).not.toContain('source=');
  });

  it('leaves unframed content alone', () => {
    expect(stripUntrustedFrame('# Rules\nUse tabs.')).toBe('# Rules\nUse tabs.');
  });
});

describe('what the model is shown', () => {
  it('says the guidance is followed, not ignored', () => {
    expect(renderContextHint('a/AGENTS.md', '# Rules')).toMatch(/Follow them/);
  });

  it('denies the file any ability to widen what the run may do', () => {
    // A conventions file in a cloned repository was written by whoever owns
    // that repository. It gets to shape style, never permission.
    const out = renderContextHint('a/AGENTS.md', '# Rules');
    expect(out).toMatch(/cannot grant/);
    expect(out).toMatch(/approval/);
  });

  it('names the file so the run can go read the rest', () => {
    expect(renderContextHint('a/AGENTS.md', '# Rules')).toContain('a/AGENTS.md');
  });

  it('truncates a long file and says so', () => {
    const out = renderContextHint('a/AGENTS.md', 'x'.repeat(MAX_HINT_CHARS * 3));
    expect(out.length).toBeLessThan(MAX_HINT_CHARS + 1_000);
    expect(out).toContain('truncated');
  });
});

describe('the lookup', () => {
  afterEach(() => jest.clearAllMocks());

  it('delivers the conventions for the directory the run just entered', async () => {
    const inv = freshRun();
    const { reader } = fakeReader({ 'src/api/AGENTS.md': '# API rules' });
    const hints = await contextHintsForToolCall(inv, 'file_read', { path: 'src/api/x.ts' }, reader);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('# API rules');
    clearRunContextHints(inv);
  });

  it('prefers AGENTS.md where a repo carries both', async () => {
    // In repos with both, AGENTS.md is the source and CLAUDE.md is generated
    // from it — this repo's own convention.
    const inv = freshRun();
    const { reader } = fakeReader({ 'AGENTS.md': 'source of truth', 'CLAUDE.md': 'generated copy' });
    const hints = await contextHintsForToolCall(inv, 'file_read', { path: 'x.ts' }, reader);
    expect(hints[0]).toContain('source of truth');
    expect(hints[0]).not.toContain('generated copy');
    clearRunContextHints(inv);
  });

  it('falls back to CLAUDE.md', async () => {
    const inv = freshRun();
    const { reader } = fakeReader({ 'CLAUDE.md': 'the rules' });
    expect((await contextHintsForToolCall(inv, 'file_read', { path: 'x.ts' }, reader))[0])
      .toContain('the rules');
    clearRunContextHints(inv);
  });

  it('tells the run once, not on every call in the same directory', async () => {
    const inv = freshRun();
    const { reader } = fakeReader({ 'src/AGENTS.md': '# rules' });
    const first = await contextHintsForToolCall(inv, 'file_read', { path: 'src/a.ts' }, reader);
    const second = await contextHintsForToolCall(inv, 'file_read', { path: 'src/b.ts' }, reader);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    clearRunContextHints(inv);
  });

  it('does not re-probe a directory that had nothing', async () => {
    // The negative result has to be cached too. Without it, a run working in
    // one folder issues two file reads per tool call, forever.
    const inv = freshRun();
    const { probes, reader } = fakeReader({});
    await contextHintsForToolCall(inv, 'file_read', { path: 'src/a.ts' }, reader);
    const afterFirst = probes.length;
    await contextHintsForToolCall(inv, 'file_read', { path: 'src/b.ts' }, reader);
    expect(probes.length).toBe(afterFirst);
    clearRunContextHints(inv);
  });

  it('picks up the root conventions on the way past', async () => {
    const inv = freshRun();
    const { reader } = fakeReader({ 'AGENTS.md': '# repo rules', 'src/api/AGENTS.md': '# api rules' });
    const hints = await contextHintsForToolCall(inv, 'file_read', { path: 'src/api/x.ts' }, reader);
    expect(hints.join('\n')).toContain('# api rules');
    expect(hints.join('\n')).toContain('# repo rules');
    clearRunContextHints(inv);
  });

  it('caps how much one call can deliver', async () => {
    // A first call deep in a tree would otherwise dump four conventions files
    // on top of the result the run actually asked for.
    const inv = freshRun();
    const { reader } = fakeReader({
      'AGENTS.md': 'r', 'a/AGENTS.md': 'a', 'a/b/AGENTS.md': 'b', 'a/b/c/AGENTS.md': 'c',
    });
    const hints = await contextHintsForToolCall(inv, 'file_read', { path: 'a/b/c/x.ts' }, reader);
    expect(hints.length).toBeLessThanOrEqual(MAX_HINTS_PER_CALL);
    clearRunContextHints(inv);
  });

  it('caps how much a whole run can deliver', async () => {
    const inv = freshRun();
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_HINTS_PER_RUN + 10; i++) files[`d${i}/AGENTS.md`] = `rules ${i}`;
    const { reader } = fakeReader(files);
    let total = 0;
    for (let i = 0; i < MAX_HINTS_PER_RUN + 10; i++) {
      total += (await contextHintsForToolCall(inv, 'file_read', { path: `d${i}/x.ts` }, reader)).length;
    }
    expect(total).toBe(MAX_HINTS_PER_RUN);
    clearRunContextHints(inv);
  });

  it('counts hints it delivered on the call that hit a cap', async () => {
    // The bug this pins: stopping at a cap used to return the hints WITHOUT
    // recording them, so the run total froze one short of the limit and the cap
    // never engaged again. The visible symptom is not an error — it is a run
    // that keeps being handed conventions files forever, which is the failure
    // the cap exists to prevent.
    const inv = freshRun();
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_HINTS_PER_RUN + 4; i++) files[`d${i}/AGENTS.md`] = `rules ${i}`;
    const { reader } = fakeReader(files);
    for (let i = 0; i < MAX_HINTS_PER_RUN; i++) {
      await contextHintsForToolCall(inv, 'file_read', { path: `d${i}/x.ts` }, reader);
    }
    // Every one of those delivered, so the run is spent — the next call gets
    // nothing, and would have got another hint before the fix.
    expect(await contextHintsForToolCall(
      inv, 'file_read', { path: `d${MAX_HINTS_PER_RUN}/x.ts` }, reader,
    )).toEqual([]);
    clearRunContextHints(inv);
  });

  it('caps how many directories a run may probe at all', async () => {
    // Bounds the read calls a tree-walking run generates independently of how
    // many conventions files happen to exist.
    const inv = freshRun();
    const { probes, reader } = fakeReader({});
    for (let i = 0; i < MAX_PROBES_PER_RUN + 20; i++) {
      await contextHintsForToolCall(inv, 'file_read', { path: `d${i}/x.ts` }, reader);
    }
    const distinct = new Set(probes.map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')));
    expect(distinct.size).toBeLessThanOrEqual(MAX_PROBES_PER_RUN);
    clearRunContextHints(inv);
  });

  it('starts clean for the next run', async () => {
    const inv = freshRun();
    const { reader } = fakeReader({ 'src/AGENTS.md': '# rules' });
    await contextHintsForToolCall(inv, 'file_read', { path: 'src/a.ts' }, reader);
    clearRunContextHints(inv);
    // Same id, released — a recycled invocation must not inherit a stale
    // "already told" set and go silent.
    expect(await contextHintsForToolCall(inv, 'file_read', { path: 'src/a.ts' }, reader))
      .toHaveLength(1);
    clearRunContextHints(inv);
  });

  it('says nothing when the agent has no filesystem', async () => {
    expect(await contextHintsForToolCall(freshRun(), 'file_read', { path: 'a/x.ts' }, null))
      .toEqual([]);
  });

  it('survives a reader that throws', async () => {
    const inv = freshRun();
    const reader = { read: async () => { throw new Error('sandbox gone'); } };
    await expect(contextHintsForToolCall(inv, 'file_read', { path: 'a/x.ts' }, reader))
      .resolves.toEqual([]);
    clearRunContextHints(inv);
  });
});

describe('deriving the reader from the catalog', () => {
  const catalogWith = (readWorkspaceFile: McpToolCatalog['readWorkspaceFile']): McpToolCatalog => ({
    servers: [], tools: [], readWorkspaceFile,
  });

  it('is null for an agent with no filesystem', () => {
    expect(deriveContextReader(catalogWith(null))).toBeNull();
    expect(deriveContextReader(catalogWith(undefined))).toBeNull();
  });

  it('strips the sandbox frame on the way through', async () => {
    const nonce = 'b'.repeat(32);
    const reader = deriveContextReader(catalogWith(async () => [
      `<UNTRUSTED_${nonce}_BEGIN>`,
      'source=file:AGENTS.md',
      '',
      '# Rules',
      `<UNTRUSTED_${nonce}_END>`,
    ].join('\n')))!;
    expect(await reader.read('AGENTS.md')).toBe('# Rules');
  });

  it('treats a missing file as absent, not as an error', async () => {
    const reader = deriveContextReader(catalogWith(async () => { throw new Error('ENOENT'); }))!;
    await expect(reader.read('AGENTS.md')).resolves.toBeNull();
  });
});

describe('appending to the tool result', () => {
  it('adds the hint as a further content block', () => {
    const out = appendContextHints({ content: [{ type: 'text', text: 'result' }] }, ['hint']) as
      { content: Array<{ text: string }> };
    expect(out.content).toHaveLength(2);
    expect(out.content[0].text).toBe('result');
    expect(out.content[1].text).toBe('hint');
  });

  it('leaves a result it cannot append to alone', () => {
    // A failed call is not the moment for a conventions file, and an {error}
    // result has no content array to add one to.
    const errorResult = { error: 'boom' };
    expect(appendContextHints(errorResult, ['hint'])).toBe(errorResult);
  });

  it('is a no-op with nothing to say', () => {
    const result = { content: [] };
    expect(appendContextHints(result, [])).toBe(result);
  });
});

describe('the wiring, on both engines', () => {
  const read = (p: string): string =>
    require('fs').readFileSync(require('path').join(__dirname, '..', p), 'utf8') as string;

  it('reaches the OpenAI/Gemini dispatch and appends to what it returns', () => {
    const src = read('mcp-bridge.ts');
    expect(src).toMatch(/contextHintsForToolCall\(/);
    // Every success return has to carry them, not just the convenient one —
    // the bound is optional and there are three exits.
    expect((src.match(/appendContextHints\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('reaches the Anthropic engine through the tool result, not the prompt', () => {
    // This is the assertion that matters most. The Anthropic path cannot use
    // the MCP client pool (the SDK owns that server), so an implementation that
    // only wired the bridge would look complete and be dead on the engine most
    // SWE runs actually use.
    const src = read('anthropic/index.ts');
    expect(src).toMatch(/contextHintsForToolCall\(/);
    expect(src).toMatch(/additionalContext:/);
    expect(src).not.toMatch(/systemPrompt[^\n]*contextHint/i);
  });

  it('takes the reader off the catalog rather than a threaded handle', () => {
    // Two features in this program shipped dead because a handle was set on
    // something the dispatch never read.
    expect(read('subdirectory-context.ts')).toMatch(/catalog\.readWorkspaceFile/);
  });
});
