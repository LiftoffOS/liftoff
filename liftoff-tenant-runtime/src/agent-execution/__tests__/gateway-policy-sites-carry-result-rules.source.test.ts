// Every context that arms the tool gateway carries the whole per-agent policy.
//
// There are seven of them across the autonomous engine and interactive chat —
// scheduled runs, resumptions after a HITL pause, delegated runs, chat turns —
// and they are hand-assembled object literals, not one shared builder. A field
// added to six of seven is a policy the agent has on some paths and not others,
// which is indistinguishable from working until the one uncovered path is the
// one that matters.
//
// That already happened here twice. `sandboxCapabilities` was omitted from the
// chat catalog, so an execution_enabled agent could read and write files on its
// cron run but not when a person asked it to in chat. `completeResultRequired
// Tools` was declared on buildChatToolCatalog's parameters and passed by nobody
// — the same shape, caught only because this file was being written.
//
// So the two travel together by assertion: they come from the same compiled
// instruction, they gate the same catalog, and a ninth site gets both or fails
// here.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');

/** How a site spells "resolve this agent's sandbox capabilities".
 *
 *  Two spellings, because chat withholds one capability and therefore calls a
 *  wrapper. Both are anchored on the FIELD, so the brace-match below walks out
 *  to the gateway-arming literal rather than to a helper's own argument object.
 *  A single spelling silently emptied the chat site out of this scan, which is
 *  the exact blindness the file exists to prevent. */
const TIER_MARKERS = [
  'sandboxCapabilities: sandboxCapabilitiesForTier(instruction.capabilityTier)',
  'sandboxCapabilities: chatSandboxCapabilities(',
] as const;
const RULES = 'completeResultToolNames(instruction)';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** The object literal enclosing `at`, found by matching braces outward. */
function enclosingObjectLiteral(src: string, at: number): string {
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    if (src[i] === '}') depth++;
    else if (src[i] === '{') {
      if (depth === 0) { start = i; break; }
      depth--;
    }
  }
  if (start === -1) return '';
  let d = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') {
      d--;
      if (d === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

const sites = walk(SRC).flatMap((file) => {
  const src = readFileSync(file, 'utf8');
  const found: Array<{ file: string; line: number; literal: string }> = [];
  for (const marker of TIER_MARKERS) {
    for (let i = src.indexOf(marker); i !== -1; i = src.indexOf(marker, i + 1)) {
      found.push({
        file: file.slice(SRC.length + 1),
        line: src.slice(0, i).split('\n').length,
        literal: enclosingObjectLiteral(src, i),
      });
    }
  }
  return found;
});

describe('every gateway-arming context carries the result policy', () => {
  it('finds the sites at all', () => {
    // A rename that empties this list would make the assertion below pass while
    // checking nothing.
    expect(sites.length).toBeGreaterThanOrEqual(7);
  });

  it('each site that resolves sandbox capabilities also resolves result rules', () => {
    const missing = sites
      .filter((s) => !s.literal.includes(RULES))
      .map((s) => `${s.file}:${s.line}`);
    expect(missing).toEqual([]);
  });

  it('covers interactive chat, not only the autonomous engine', () => {
    // A chat turn that reads a store to decide what already exists has the
    // identical hazard, and chat reaches the gateway by its own path.
    expect(sites.some((s) => s.file.includes('interactive-chat'))).toBe(true);
  });

  it('the gateway input and the execution context both declare the field', () => {
    const gateway = readFileSync(join(SRC, 'tool-gateway', 'mcp-server.ts'), 'utf8');
    const context = readFileSync(join(SRC, 'agent-execution', 'types.ts'), 'utf8');
    expect(gateway).toContain('completeResultRequiredTools?: readonly string[]');
    expect(context).toContain('completeResultRequiredTools?: string[]');
  });
});

describe('the policy is read from the compiled instruction', () => {
  const service = readFileSync(join(SRC, 'agent-execution', 'service.ts'), 'utf8');

  it('both instruction loaders select and map the column', () => {
    // The autonomous loader and the chat loader are separate queries against
    // the same table. One that omits the column yields an empty policy with no
    // error — the agent is simply unprotected on that path.
    for (const file of ['agent-execution/service.ts', 'interactive-chat/chat-turn-handler.ts']) {
      const src = readFileSync(join(SRC, ...file.split('/')), 'utf8');
      expect({ file, mapped: src.includes('resultRules: Array.isArray(row.result_rules)') })
        .toEqual({ file, mapped: true });
    }
  });

  it('drops entries that are not a complete-result requirement', () => {
    // The gateway enforces one predicate; anything else in the rule shape must
    // not reach it as if it were that predicate.
    const fn = /export function completeResultToolNames\([\s\S]*?\n\}/.exec(service)?.[0] ?? '';
    expect(fn).toContain('r.requiresComplete');
    expect(fn).toContain("typeof r.toolName === 'string'");
  });
});
