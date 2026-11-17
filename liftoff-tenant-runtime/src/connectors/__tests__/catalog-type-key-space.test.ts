// The catalog's key space, stated as a test because two namespaces collide here
// and neither collision is an error.
//
// connector-service keys its catalog on the connector type it publishes:
// `google_mail`, with an underscore. The ACTION LEDGER keys `target_ref` on a
// hyphen-separated convention, and `connectorTypeFromAlias` normalises INTO
// that namespace — mapping `google_mail` to `google-mail` deliberately.
//
// Feed one namespace's key into the other's Map and nothing throws. `Map.get`
// returns undefined, the caller reads "this connector declares no tools", and
// every underscore-typed connector drops out while `slack` and `github` keep
// working because they have no underscore to mangle. That is a silent
// half-failure, which is the worst shape a lookup can have: the connectors that
// still work are proof to a reader that the code is right.

import { catalogTypeFor } from '../tool-schema-cache';
import { connectorTypeFromAlias } from '../../action-ledger/target-ref';

describe('catalogTypeFor', () => {
  it('strips an instance suffix', () => {
    expect(catalogTypeFor('google_mail-0105297e')).toBe('google_mail');
    expect(catalogTypeFor('slack-d77db9a0')).toBe('slack');
  });

  it('passes a bare type through unchanged', () => {
    // Agent-execution callers dispatch the bare TYPE, not an alias — the
    // gateway's own binding resolver branches on `input.connector ===
    // "google_mail"`. Both forms have to reach the same catalog row.
    expect(catalogTypeFor('google_mail')).toBe('google_mail');
    expect(catalogTypeFor('github')).toBe('github');
  });

  it('KEEPS underscores', () => {
    // The whole point. Hyphenating here is what silently emptied the gate for
    // every Google connector and every custom MCP server.
    expect(catalogTypeFor('google_sheets')).toBe('google_sheets');
    expect(catalogTypeFor('custom_mcp_server')).toBe('custom_mcp_server');
  });

  it('leaves builtins alone', () => {
    expect(catalogTypeFor('__builtin:search')).toBe('__builtin:search');
  });

  it('is empty for an empty reference rather than guessing', () => {
    expect(catalogTypeFor('')).toBe('');
    expect(catalogTypeFor(undefined as unknown as string)).toBe('');
  });
});

describe('an alias arrives in the OTHER namespace', () => {
  // The half the suffix-stripping did not cover, and the one the manifests
  // actually produce. `google_mail-0105297e` above is a canonical type with an
  // instance suffix; a tenant's manifest alias is the HYPHENATED spelling all
  // the way through — `google-docs-8fd9fc68` — so stripping the suffix alone
  // left `google-docs`, which is not a key.
  //
  // Same silent half-failure the header describes, entered from the other side:
  // slack and github have no separator to disagree about and kept working.
  it.each([
    ['google-docs-8fd9fc68', 'google_docs'],
    ['google-mail-0105297e', 'google_mail'],
    ['microsoft-teams-1a2b3c4d', 'microsoft_teams'],
    ['atlassian-jira-9f8e7d6c', 'atlassian_jira'],
  ])('%s resolves to the catalog key %s', (alias, expected) => {
    expect(catalogTypeFor(alias)).toBe(expected);
  });

  it('reaches the same key from either spelling', () => {
    // The property that matters: a caller holding a type and a caller holding
    // an alias must land on the same catalog row.
    expect(catalogTypeFor('google-docs-8fd9fc68')).toBe(catalogTypeFor('google_docs'));
    expect(catalogTypeFor('slack-d77db9a0')).toBe(catalogTypeFor('slack'));
  });

  it('leaves a name it cannot map where it was', () => {
    // An alias nobody registered misses either way; inventing a type for it
    // would turn a miss into a wrong hit.
    expect(catalogTypeFor('my-crm-9a8b7c6d')).toBe('my_crm');
    expect(catalogTypeFor('my_gmail')).toBe('my_gmail');
  });
});

describe('the two namespaces really do disagree', () => {
  // Stated explicitly so nobody "simplifies" one into the other. They are not
  // duplicates; they answer different questions, and the disagreement is the
  // reason both exist.
  it.each([
    'google_mail',
    'google_sheets',
    'google_docs',
    'google_drive',
    'custom_mcp_server',
    'atlassian_jira',
  ])('%s: the ledger hyphenates it, the catalog does not', (type) => {
    expect(connectorTypeFromAlias(type)).not.toBe(catalogTypeFor(type));
    expect(catalogTypeFor(type)).toBe(type);
  });

  it.each(['slack', 'github', 'gitlab', 'notion'])(
    '%s: they agree, which is exactly why the bug hid',
    (type) => {
      // These connectors kept working throughout, and a reader checking one of
      // them would have concluded the lookup was fine.
      expect(connectorTypeFromAlias(type)).toBe(catalogTypeFor(type));
    },
  );
});
