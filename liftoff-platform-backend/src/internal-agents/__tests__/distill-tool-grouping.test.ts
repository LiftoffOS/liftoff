// Tools must reach the model grouped under the integration that owns them.
//
// The AVAILABLE TOOLS section is the only place a distillation learns which
// tools exist and what arguments they take. Grouping matched an integration to
// an alias prefix by substring, both directions — and an alias is
// `<type-with-dashes>-<connectorId first 8>` while a type is spelled with
// UNDERSCORES. `google_mail` and `google-mail-0105297e` contain neither each
// other nor anything else, so the match failed for every multi-word connector
// type: google_mail, google_sheets, google_drive, google_slides,
// google_meet, microsoft_outlook_mail, custom_mcp_server. Single-word types
// (slack, github, zoho) matched by accident of spelling.
//
// What the section looked like for a workspace with Gmail, Slack and a Help
// Center bound:
//
//   - undefined (undefined, id=0105297e-…)   Gmail        — no tools
//   - undefined (undefined, id=d77db9a0-…)   Slack        — 1 tool
//   - undefined (undefined, id=d144a7ea-…)   Help Center  — no tools
//
// Two defects in three lines. A model shown no Gmail tools guesses their
// argument names; shown no Help Center tools, the distillation writes "No
// help-center connector is bound" into the step meant to search the Help
// Center. Both are visible above and neither is detectable from the produced
// graph, which may name tools that happen to be right.
//
// The id suffix is the fix: every alias ends with the connector id's first 8
// characters, and this function is handed the id. Nothing to spell.

import { __formatIntegrationsWithToolsForTest as formatIntegrations } from '../distill-service';

type CatalogEntry = { name: string; description: string; input_schema?: Record<string, unknown> };

const tool = (name: string, props: string[], required: string[] = []): [string, CatalogEntry] => [
  name,
  {
    name,
    description: `does ${name}`,
    input_schema: { properties: Object.fromEntries(props.map((p) => [p, {}])), required },
  },
];

const catalog = new Map<string, CatalogEntry>([
  tool('google-mail-0105297e__list_messages', ['user_id', 'query', 'max_results'], ['user_id']),
  tool('slack-d77db9a0__send_message', ['channel', 'text'], ['channel']),
  tool('custom-mcp-d144a7ea__search_articles', ['query'], ['query']),
]);

// Exactly what `internal_agents.integrations` holds — `integrationId`, no
// `type`, no `name`. Every redistill of a SAVED agent goes through this shape,
// which is why the defect survived: a fresh distill from the UI passes richer
// objects.
const storedRows = [
  { id: '0105297e-eed8-4953-8be6-bdebd3cbf247', integrationId: 'google_mail', selectedObjects: [] },
  { id: 'd77db9a0-0000-4000-8000-000000000000', integrationId: 'slack', selectedObjects: [] },
  { id: 'd144a7ea-91a0-4ce3-8e21-93a732a794e1', integrationId: 'custom_mcp_server', selectedObjects: [] },
];

const render = (rows: unknown[]) => formatIntegrations(rows as never, catalog as never);

describe('a stored agent row lists its tools', () => {
  const out = render(storedRows);

  it('lists the Gmail tool, which the substring match could never reach', () => {
    expect(out).toContain('google-mail-0105297e__list_messages');
  });

  it('lists the custom MCP tool', () => {
    expect(out).toContain('custom-mcp-d144a7ea__search_articles');
  });

  it('still lists the single-word connector that used to be the only one working', () => {
    expect(out).toContain('slack-d77db9a0__send_message');
  });

  it('carries the argument names and which are required', () => {
    // The whole point of listing tools: the model authors toolInputTemplate
    // from this, and guessed `q`/`body`/`id` when it was absent.
    expect(out).toContain('google-mail-0105297e__list_messages(user_id*, query, max_results)');
  });
});

describe('the integration line names something real', () => {
  const out = render(storedRows);

  it('never renders the literal string "undefined"', () => {
    // `i.name` and `i.type` are absent on a stored row, and template
    // interpolation turned that into the WORD undefined — so the prompt
    // described every integration as `- undefined (undefined, id=…)`.
    expect(out).not.toContain('undefined');
  });

  it('falls back to the resolved connector type when there is no name', () => {
    expect(out).toContain('- google_mail (google_mail, id=0105297e-eed8-4953-8be6-bdebd3cbf247)');
  });

  it('keeps the id, which delegate_to_agent and integrationConfigs address by', () => {
    expect(out).toContain('id=d144a7ea-91a0-4ce3-8e21-93a732a794e1');
  });
});

describe('the richer shape a fresh distill sends still works', () => {
  const out = render([
    { id: '0105297e-eed8-4953-8be6-bdebd3cbf247', type: 'google_mail', name: 'Gmail', selectedObjects: [] },
    { id: 'd144a7ea-91a0-4ce3-8e21-93a732a794e1', type: 'custom_mcp_server', name: 'Docs MCP', selectedObjects: [] },
  ]);

  it('prefers the supplied name', () => {
    expect(out).toContain('- Gmail (google_mail,');
    expect(out).toContain('- Docs MCP (custom_mcp_server,');
  });

  it('groups the same tools', () => {
    expect(out).toContain('google-mail-0105297e__list_messages');
    expect(out).toContain('custom-mcp-d144a7ea__search_articles');
  });
});

describe('the id match does not widen the grouping', () => {
  it('does not hand one integration another connector\'s tools', () => {
    const out = render([storedRows[0]]);
    expect(out).toContain('google-mail-0105297e__list_messages');
    expect(out).not.toContain('custom-mcp-d144a7ea__search_articles');
    expect(out).not.toContain('slack-d77db9a0__send_message');
  });

  it('an integration with no id claims nothing', () => {
    // `''.slice(0,8)` is not 8 characters, so the id leg cannot fire — the
    // guard that stops an empty value matching everything.
    const out = render([{ id: '', integrationId: 'google_mail', selectedObjects: [] }]);
    expect(out).not.toContain('custom-mcp-d144a7ea__search_articles');
    expect(out).not.toContain('slack-d77db9a0__send_message');
  });
});
