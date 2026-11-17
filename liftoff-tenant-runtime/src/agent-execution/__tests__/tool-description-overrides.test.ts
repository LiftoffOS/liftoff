// Per-tool description overrides, applied where the model will actually read
// them.
//
// The layer table's first row. A rule that governs one call belongs on that
// call: the model reads a tool's description at the moment it writes that
// tool's arguments, which is when the rule helps. The same rule in the system
// prompt was read once, thousands of tokens ago, on a turn that may never touch
// the tool.

import { applyToolDescriptionOverrides } from '../../tool-gateway/tool-description-overrides';

const tools = [
  { name: 'create_review_comment', description: 'Post a review comment.' },
  { name: 'get_pull_request', description: 'Fetch a pull request.' },
];

describe('applyToolDescriptionOverrides', () => {
  it('appends rather than replaces', () => {
    // The vendor description says what the tool DOES; the override says how
    // this agent must use it. A model that no longer knows what a tool does
    // follows no rule about it correctly.
    const [first] = applyToolDescriptionOverrides(tools, {
      create_review_comment: 'Always anchor to file and line.',
    });
    expect(first.description).toContain('Post a review comment.');
    expect(first.description).toContain('Always anchor to file and line.');
  });

  it('leaves untouched tools alone, identity included', () => {
    const out = applyToolDescriptionOverrides(tools, { create_review_comment: 'x' });
    expect(out[1]).toBe(tools[1]);
  });

  it('returns the same array when there is nothing to apply', () => {
    expect(applyToolDescriptionOverrides(tools, {})).toBe(tools);
    expect(applyToolDescriptionOverrides(tools, undefined)).toBe(tools);
  });

  it('drops an override naming no tool in the catalog', () => {
    // Silent HERE and loud at distillation, which is the right division: the
    // distiller knows the name was invented; by this point a missing tool is
    // ordinary, because the agent's bindings changed since it was distilled.
    const out = applyToolDescriptionOverrides(tools, { not_a_tool: 'ignored' });
    expect(out.map((t) => t.description)).toEqual(tools.map((t) => t.description));
  });

  it('uses the override alone when the tool describes itself with nothing', () => {
    const out = applyToolDescriptionOverrides(
      [{ name: 'x', description: '' }],
      { x: 'The only rule.' },
    );
    expect(out[0].description).toBe('The only rule.');
  });

  it('does not mutate the input', () => {
    const before = tools[0].description;
    applyToolDescriptionOverrides(tools, { create_review_comment: 'appended' });
    expect(tools[0].description).toBe(before);
  });
});
