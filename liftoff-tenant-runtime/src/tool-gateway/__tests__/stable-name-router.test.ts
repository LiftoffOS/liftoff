// Composio cutover-completion (C5): stable-name-router unit tests.

import type { ConnectorFunction } from '@liftoffos/connector-types';
import { resolveStableName } from '../stable-name-router';

function makeFn(over: Partial<ConnectorFunction>): ConnectorFunction {
  return {
    name: 'list_messages',
    description: 'd',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
    ...over,
  };
}

describe('resolveStableName', () => {
  it('routes native tool to native source with vendorToolName == stableName', () => {
    const route = resolveStableName({
      connectorType: 'linear',
      stableName: 'list_issues',
      fn: makeFn({ name: 'list_issues', definitionSource: 'native' }),
    });
    expect(route.source).toBe('native');
    expect(route.vendorToolName).toBe('list_issues');
  });

  it('routes a fn with absent definitionSource as native (backward compatibility)', () => {
    const route = resolveStableName({
      connectorType: 'linear',
      stableName: 'list_issues',
      fn: makeFn({ name: 'list_issues' }),
    });
    expect(route.source).toBe('native');
  });

  it('routes composio tool to composio source with vendor name from fn', () => {
    const route = resolveStableName({
      connectorType: 'google_mail',
      toolkitSlug: 'gmail',
      stableName: 'list_messages',
      fn: makeFn({
        name: 'list_messages',
        definitionSource: 'composio',
        vendorToolName: 'GMAIL_FETCH_EMAILS',
      }),
    });
    expect(route.source).toBe('composio');
    if (route.source === 'composio') {
      expect(route.vendorToolName).toBe('GMAIL_FETCH_EMAILS');
      expect(route.toolkitSlug).toBe('gmail');
      expect(route.canonicalKey).toBe('gmail.list_messages');
      expect(typeof route.translateError).toBe('function');
    }
  });

  it('throws stable_name_router error if composio tool missing toolkit slug', () => {
    expect(() =>
      resolveStableName({
        connectorType: 'google_mail',
        // toolkitSlug omitted
        stableName: 'list_messages',
        fn: makeFn({ name: 'list_messages', definitionSource: 'composio', vendorToolName: 'X' }),
      }),
    ).toThrow(/stable_name_router: composio tool missing toolkit slug/);
  });

  it('throws stable_name_router error if composio tool missing vendorToolName', () => {
    expect(() =>
      resolveStableName({
        connectorType: 'google_mail',
        toolkitSlug: 'gmail',
        stableName: 'list_messages',
        fn: makeFn({ name: 'list_messages', definitionSource: 'composio' }),
      }),
    ).toThrow(/stable_name_router: composio tool missing vendorToolName/);
  });
});

// The runtime runs the overlay translators LOCALLY, from its own copy of
// @liftoffos/composio-overlays, at the seam resolveStableName exposes. The
// schema a connector-service publishes is only the contract if the translator
// the runtime executes honours it: with the older package a schema-valid
// Slack reaction of name: "thumbsup" was dispatched as "eyes", and a Gmail
// create_label with label_name was dispatched with no name at all. These pin
// the runtime's dependency to translators that keep the advertised names.
describe('the translators the runtime dispatches through honour the advertised argument names', () => {
  const composioFn = (name: string, vendorToolName: string) =>
    makeFn({ name, definitionSource: 'composio', vendorToolName });

  it('slack.add_reaction keeps the emoji the agent named', () => {
    const route = resolveStableName({
      connectorType: 'slack',
      toolkitSlug: 'slack',
      stableName: 'add_reaction',
      fn: composioFn('add_reaction', 'SLACK_ADD_REACTION_TO_AN_ITEM'),
    });
    expect(route.source).toBe('composio');
    expect(route.translateInput!({ channel: 'C1', timestamp: '1.2', name: 'thumbsup' })).toMatchObject({ name: 'thumbsup' });
    // And still defaults when none is named: the reaction is the ack.
    expect(route.translateInput!({ channel: 'C1', timestamp: '1.2' })).toMatchObject({ name: 'eyes' });
  });

  it('slack.list_messages forwards cursor, oldest and latest as advertised', () => {
    const route = resolveStableName({
      connectorType: 'slack',
      toolkitSlug: 'slack',
      stableName: 'list_messages',
      fn: composioFn('list_messages', 'SLACK_FETCH_CONVERSATION_HISTORY'),
    });
    expect(route.translateInput!({ channel: 'C1', cursor: 'c', oldest: '1', latest: '2' }))
      .toMatchObject({ channel: 'C1', cursor: 'c', oldest: '1', latest: '2' });
  });

  it('gmail.create_label and delete_label read the names their schemas advertise', () => {
    const create = resolveStableName({
      connectorType: 'google_mail', toolkitSlug: 'gmail', stableName: 'create_label',
      fn: composioFn('create_label', 'GMAIL_CREATE_LABEL'),
    });
    expect(create.translateInput!({ label_name: 'support/handled' })).toMatchObject({ label_name: 'support/handled' });
    const del = resolveStableName({
      connectorType: 'google_mail', toolkitSlug: 'gmail', stableName: 'delete_label',
      fn: composioFn('delete_label', 'GMAIL_REMOVE_LABEL'),
    });
    expect(del.translateInput!({ label_id: 'Label_7' })).toMatchObject({ label_id: 'Label_7' });
  });

  it('gmail.list_messages supplies user_id itself and keeps the agent\'s query', () => {
    const route = resolveStableName({
      connectorType: 'google_mail', toolkitSlug: 'gmail', stableName: 'list_messages',
      fn: composioFn('list_messages', 'GMAIL_FETCH_EMAILS'),
    });
    expect(route.translateInput!({ query: 'is:unread' })).toMatchObject({ user_id: 'me', query: 'is:unread' });
  });
});
