// Visualization fence parser tests — both one-shot and streaming paths.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  StreamingVisualizationParser,
  parseVisualizationBlocks,
} from '../visualization-parser';

const METRIC_BLOCK = {
  type: 'metric_card',
  label: 'Total Cost',
  value: '$4,832',
  trend: 'down',
  trendText: '-7% vs last week',
};

const BAR_BLOCK = {
  type: 'bar_chart',
  title: 'Tasks by Agent',
  data: [{ label: 'Salesforce', value: 120 }],
};

// org_chart is CAIO-specific but lives in the same shared union so one
// parser codepath handles every chat surface.
const ORG_CHART_BLOCK = {
  type: 'org_chart',
  title: 'Proposed Customer Ops Team',
  nodes: [
    { id: 'a', label: 'Customer Success Lead', department: 'Customer Success' },
    { id: 'b', label: 'Renewal Automation', department: 'Customer Success' },
  ],
  edges: [{ from: 'a', to: 'b' }],
};

describe('parseVisualizationBlocks (one-shot)', () => {
  it('returns empty blocks + original text when no fences are present', () => {
    const result = parseVisualizationBlocks('Hello world, no fences here.');
    expect(result.blocks).toEqual([]);
    expect(result.cleanedText).toBe('Hello world, no fences here.');
  });

  it('parses a single fence with an array of blocks', () => {
    const text = `Here are the numbers:

\`\`\`visualization
[${JSON.stringify(METRIC_BLOCK)}, ${JSON.stringify(BAR_BLOCK)}]
\`\`\`

That's the summary.`;

    const result = parseVisualizationBlocks(text);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]).toMatchObject(METRIC_BLOCK);
    expect(result.blocks[1]).toMatchObject(BAR_BLOCK);
    expect(result.cleanedText).toContain('Here are the numbers:');
    expect(result.cleanedText).toContain("That's the summary.");
    expect(result.cleanedText).not.toContain('```visualization');
  });

  it('parses multiple separate fences', () => {
    const text = `\`\`\`visualization
[${JSON.stringify(METRIC_BLOCK)}]
\`\`\`

Some text between.

\`\`\`visualization
[${JSON.stringify(BAR_BLOCK)}]
\`\`\``;

    const result = parseVisualizationBlocks(text);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].type).toBe('metric_card');
    expect(result.blocks[1].type).toBe('bar_chart');
    expect(result.cleanedText).toContain('Some text between.');
  });

  it('parses a fence containing a single object (not array)', () => {
    const text = `\`\`\`visualization
${JSON.stringify(METRIC_BLOCK)}
\`\`\``;
    const result = parseVisualizationBlocks(text);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject(METRIC_BLOCK);
  });

  it('parses an org_chart block (CAIO-specific type in shared union)', () => {
    const text = `Here is the team:

\`\`\`visualization
[${JSON.stringify(ORG_CHART_BLOCK)}]
\`\`\``;
    const result = parseVisualizationBlocks(text);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].type).toBe('org_chart');
    expect(result.blocks[0]).toMatchObject(ORG_CHART_BLOCK);
  });

  it('filters out blocks with unknown types', () => {
    const text = `\`\`\`visualization
[${JSON.stringify(METRIC_BLOCK)}, { "type": "not_a_real_block", "foo": 1 }]
\`\`\``;
    const result = parseVisualizationBlocks(text);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].type).toBe('metric_card');
  });

  // The sentence in an observation belongs in `content`, which is the only
  // field the renderer reads. The model tends to write `text` instead, in
  // exactly the shape of this fence. Admitted unchanged, it reaches the reader
  // as a "Key Observations" heading with nothing underneath.
  it('moves an observation\'s sentence onto `content` when the model wrote `text`', () => {
    const text = `\`\`\`visualization
[{ "icon": "!", "text": "The payroll line reports an identical, implausibly large figure for both weeks.", "type": "observation" }]
\`\`\``;
    const result = parseVisualizationBlocks(text);
    expect(result.blocks).toEqual([
      {
        type: 'observation',
        icon: '!',
        content: 'The payroll line reports an identical, implausibly large figure for both weeks.',
      },
    ]);
  });

  it('keeps an observation that already used `content`, exactly as written', () => {
    const text = `\`\`\`visualization
[{ "type": "observation", "icon": "+", "content": "Spend is down 39% week over week." }]
\`\`\``;
    const result = parseVisualizationBlocks(text);
    expect(result.blocks).toEqual([
      { type: 'observation', icon: '+', content: 'Spend is down 39% week over week.' },
    ]);
  });

  it('gives an observation with no usable icon the one that claims least', () => {
    const text = `\`\`\`visualization
[{ "type": "observation", "icon": "warning", "content": "Error rates climbed on Tuesday." }]
\`\`\``;
    const result = parseVisualizationBlocks(text);
    expect(result.blocks).toEqual([
      { type: 'observation', icon: '?', content: 'Error rates climbed on Tuesday.' },
    ]);
  });

  // Nothing to say and nowhere to say it: rendering this is the blank bullet
  // under a heading that started all of it.
  it('drops an observation carrying no sentence at all', () => {
    const text = `\`\`\`visualization
[${JSON.stringify(METRIC_BLOCK)}, { "type": "observation", "icon": "+" }]
\`\`\``;
    const result = parseVisualizationBlocks(text);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].type).toBe('metric_card');
  });

  // Same field, same undocumented shape, same silent blank.
  it('moves a text block\'s paragraph onto `content` when the model wrote `text`', () => {
    const text = `\`\`\`visualization
[{ "type": "text", "text": "Costs are concentrated in one team." }]
\`\`\``;
    const result = parseVisualizationBlocks(text);
    expect(result.blocks).toEqual([
      { type: 'text', content: 'Costs are concentrated in one team.' },
    ]);
  });

  it('leaves malformed fences in the cleaned text (so operators can see)', () => {
    const text = `Some text.

\`\`\`visualization
{ "type": "metric_card", "label":
\`\`\`

More text.`;
    const result = parseVisualizationBlocks(text);
    expect(result.blocks).toEqual([]);
    expect(result.cleanedText).toContain('```visualization');
    expect(result.cleanedText).toContain('"type": "metric_card"');
  });

  it('trims excessive blank lines from the cleaned text', () => {
    const text = `Before.



\`\`\`visualization
[${JSON.stringify(METRIC_BLOCK)}]
\`\`\`



After.`;
    const result = parseVisualizationBlocks(text);
    expect(result.cleanedText).not.toMatch(/\n{3,}/);
  });
});

describe('StreamingVisualizationParser', () => {
  it('streams plain text when no fences are present', () => {
    const parser = new StreamingVisualizationParser();
    const events = [...parser.feed('Hello '), ...parser.feed('world.'), ...parser.flush()];
    const textEvents = events.filter(e => e.type === 'text');
    const combined = textEvents.map(e => (e.type === 'text' ? e.content : '')).join('');
    expect(combined).toBe('Hello world.');
  });

  it('holds back partial fence opener at end of delta', () => {
    const parser = new StreamingVisualizationParser();

    // First delta ends with a partial fence opener
    const events1 = parser.feed('Here it is ```vis');
    // Should emit "Here it is " but hold back "```vis" because it might be a fence
    const text1 = events1
      .filter(e => e.type === 'text')
      .map(e => (e.type === 'text' ? e.content : ''))
      .join('');
    expect(text1).toBe('Here it is ');
    expect(events1.find(e => e.type === 'blocks')).toBeUndefined();

    // Second delta completes the fence opener and includes the full fence
    const events2 = parser.feed('ualization\n' + JSON.stringify([METRIC_BLOCK]) + '\n```');
    const blocksEvents = events2.filter(e => e.type === 'blocks');
    expect(blocksEvents).toHaveLength(1);
    if (blocksEvents[0].type === 'blocks') {
      expect(blocksEvents[0].blocks).toHaveLength(1);
      expect(blocksEvents[0].blocks[0].type).toBe('metric_card');
    }
  });

  it('emits blocks from a fence split across multiple deltas', () => {
    const parser = new StreamingVisualizationParser();
    const events: Array<ReturnType<StreamingVisualizationParser['feed']>[number]> = [];

    events.push(...parser.feed('```visuali'));
    events.push(...parser.feed('zation\n[{"type":"metric_card",'));
    events.push(...parser.feed('"label":"Cost","value":"$100"}]\n```'));
    events.push(...parser.flush());

    const blocksEvents = events.filter(e => e.type === 'blocks');
    expect(blocksEvents).toHaveLength(1);
    if (blocksEvents[0].type === 'blocks') {
      expect(blocksEvents[0].blocks[0]).toMatchObject({
        type: 'metric_card',
        label: 'Cost',
        value: '$100',
      });
    }
  });

  it('interleaves text and blocks for multiple fences', () => {
    const parser = new StreamingVisualizationParser();

    const events = [
      ...parser.feed('Here is the first chart:\n'),
      ...parser.feed('```visualization\n' + JSON.stringify([METRIC_BLOCK]) + '\n```\n'),
      ...parser.feed('And the second:\n'),
      ...parser.feed('```visualization\n' + JSON.stringify([BAR_BLOCK]) + '\n```'),
      ...parser.flush(),
    ];

    const types = events.map(e => e.type);
    expect(types).toContain('text');
    expect(types).toContain('blocks');

    const blocks = events.filter(e => e.type === 'blocks').flatMap(e => (e.type === 'blocks' ? e.blocks : []));
    expect(blocks).toHaveLength(2);
    expect(blocks.map(b => b.type)).toEqual(['metric_card', 'bar_chart']);

    // Text around the fences should all be present
    const allText = events.filter(e => e.type === 'text').map(e => (e.type === 'text' ? e.content : '')).join('');
    expect(allText).toContain('Here is the first chart');
    expect(allText).toContain('And the second');
  });

  it('does NOT split a fence opener on safe character boundaries', () => {
    // If we feed a string that has 'abc' then nothing else, we should be able
    // to emit 'abc' immediately (not hold it back because it could be partial)
    const parser = new StreamingVisualizationParser();
    const events = parser.feed('abc');
    // Without flush, we should still get some text — the hold-back window is
    // FENCE_OPEN.length - 1 = 15 chars, so a 3-char string gets held back entirely.
    // That's fine; on flush it comes out.
    const flushEvents = parser.flush();
    const combined = [...events, ...flushEvents]
      .filter(e => e.type === 'text')
      .map(e => (e.type === 'text' ? e.content : ''))
      .join('');
    expect(combined).toBe('abc');
  });

  it('emits held-back buffer on flush even if stream ends mid-partial-fence', () => {
    const parser = new StreamingVisualizationParser();
    const events = [...parser.feed('partial text ```vi'), ...parser.flush()];
    // On flush, the held-back "```vi" should come out as text
    const combined = events
      .filter(e => e.type === 'text')
      .map(e => (e.type === 'text' ? e.content : ''))
      .join('');
    expect(combined).toBe('partial text ```vi');
  });

  // The live stream and the persisted message are parsed by two different
  // objects in this file, and a reader who watched the reply arrive and a reader
  // who opened it later must see the same sentence.
  it('moves an observation\'s sentence onto `content` on the streaming path too', () => {
    const parser = new StreamingVisualizationParser();
    const events = [
      ...parser.feed(
        'Spend is down.\n\n```visualization\n[{ "icon": "!", "text": "Payroll looks like a data issue.", "type": "observation" }]\n```',
      ),
      ...parser.flush(),
    ];
    const blocks = events.flatMap(e => (e.type === 'blocks' ? e.blocks : []));
    expect(blocks).toEqual([
      { type: 'observation', icon: '!', content: 'Payroll looks like a data issue.' },
    ]);
  });

  it('falls back to emitting fence as text on malformed JSON', () => {
    const parser = new StreamingVisualizationParser();
    const events = [
      ...parser.feed('```visualization\n{not valid json\n```'),
      ...parser.flush(),
    ];
    const blocksEvents = events.filter(e => e.type === 'blocks');
    expect(blocksEvents).toHaveLength(0);
    const textEvents = events.filter(e => e.type === 'text');
    const combined = textEvents.map(e => (e.type === 'text' ? e.content : '')).join('');
    expect(combined).toContain('{not valid json');
  });

  it('handles an unterminated fence by emitting buffer on flush', () => {
    const parser = new StreamingVisualizationParser();
    const events = [
      ...parser.feed('intro ```visualization\n[{"type":"metric_card","label":"X","value":"1"}'),
      ...parser.flush(), // stream ended mid-fence
    ];
    // Should still emit "intro " text and then the raw buffered content (no blocks since unterminated)
    const blocks = events.filter(e => e.type === 'blocks');
    expect(blocks).toHaveLength(0);
    const combinedText = events
      .filter(e => e.type === 'text')
      .map(e => (e.type === 'text' ? e.content : ''))
      .join('');
    expect(combinedText).toContain('intro ');
    expect(combinedText).toContain('metric_card');
  });
});
