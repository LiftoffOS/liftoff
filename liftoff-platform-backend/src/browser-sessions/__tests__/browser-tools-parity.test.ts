// Every host says the same thing about the browser, because there is only one
// place that says it.
//
// The machinery behind the pane has always been one service. The WORDS were
// three hand-copies and a database row, each carrying a comment promising it
// matched the others. `read_active_browser_session` drifted to mean the page
// on agent chat and the address alone on the three platform assistants; two
// copies of its description went stale for months, and the sentence that tells
// a model to read a page before answering about it could not be written for
// four hosts because it was false on three.
//
// What this pins is the property that fix depends on: the tools this repo
// SERVES and the guidance its prompts RENDER are the package's, not a copy
// that happens to agree today. A future hand-copy fails here rather than
// drifting quietly for a quarter.
//
// It cannot see the other repos — that needs all the trees in hand, the blind
// spot `schema-reachability.test.ts` records for the same reason. Those import
// the package instead, which is the stronger guarantee: there is nothing there
// to drift.

import {
  BROWSER_GUIDANCE,
  BROWSER_GUIDANCE_SECTION,
  BROWSER_TOOLS,
  OBSERVED_TEXT_NOTICE,
} from '@liftoffos/browser-tools';
import { BROWSER_ASSISTANT_TOOLS } from '../assistant-tools';
import { buildLiftoffSystemPrompt } from '../../liftoff/system-prompt';
import { buildInsightsSystemPrompt } from '../../insights/tools/system-prompt';

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('the browser tools are the package\'s, not a copy', () => {
  it('this repo serves exactly what the package defines, name for name and word for word', () => {
    expect(BROWSER_ASSISTANT_TOOLS).toHaveLength(BROWSER_TOOLS.length);
    expect(BROWSER_ASSISTANT_TOOLS.map(t => t.name)).toEqual(BROWSER_TOOLS.map(t => t.name));
    for (const tool of BROWSER_TOOLS) {
      const served = BROWSER_ASSISTANT_TOOLS.find(t => t.name === tool.name);
      expect(served).toBeDefined();
      expect(served!.description).toBe(tool.description);
      expect(served!.input_schema).toEqual(tool.input_schema);
    }
  });

  // The one that went stale. Named on its own so a failure says which promise
  // broke rather than "a description differs".
  it('the page read says it returns the page, on this host too', () => {
    const read = BROWSER_TOOLS.find(t => t.name === 'read_active_browser_session');
    expect(read).toBeDefined();
    expect(read!.description).toContain('the page text');
    expect(read!.description).toContain(OBSERVED_TEXT_NOTICE);
  });
});

describe('every assistant with a pane is told the same thing about it', () => {
  it.each([
    ['Liftoff', () => buildLiftoffSystemPrompt({ today: '2026-09-24', availableTools: [] })],
    ['the Insights Manager', () => buildInsightsSystemPrompt({ today: '2026-09-24', availableTools: [] } as never)],
  ])('%s renders the package\'s paragraph verbatim, exactly once', (_name, build) => {
    const prompt = build();
    expect(occurrences(prompt, BROWSER_GUIDANCE)).toBe(1);
    expect(occurrences(prompt, BROWSER_GUIDANCE_SECTION)).toBe(1);
    expect(occurrences(prompt, '## The Browser Pane')).toBe(1);
  });

  // The paragraph is only true while the tools it names exist.
  it('every tool the paragraph names is a tool that is offered', () => {
    const names = BROWSER_TOOLS.map(t => t.name);
    for (const named of BROWSER_GUIDANCE.match(/`([a-z_]+)`/g) ?? []) {
      expect(names).toContain(named.replace(/`/g, ''));
    }
  });
});
