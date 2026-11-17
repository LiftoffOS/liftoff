// Regression tests for buildBindingsByType — the canonical alias /
// type / UUID map that lets resolveBinding translate whatever
// identifier the LLM emitted into the current connector UUID before
// forwarding to connector-service.
//
// The bug this prevents:
//   1. Agent's LLM-direct dispatch path called toolGateway.execute()
//      without bindingsByType.
//   2. resolveBinding fell into its `!input.bindingsByType` branch and
//      returned the alias string ('slack', 'google-mail') as the
//      `connectorId` field on the outbound connector-service request.
//   3. connector-service ran `WHERE id = $1::uuid` against that string.
//      Postgres rejected with "invalid input syntax for type uuid:
//      \"slack\"".
//   4. The agent observed an unhelpful empty result, confabulated a
//      "connector is broken" escalation, saved that as memory, and read
//      it as truth on the next run — propagating fictitious failures
//      across every later scheduled run.
//
// And the stale-UUID corollary: compiled_instructions.integrations
// stores the connector_id at distillation time. When the user
// reconnects, the manifest's id is refreshed (handler's ON CONFLICT DO
// UPDATE SET id = EXCLUDED.id) but the integration's is not.
// buildBindingsByType MUST prefer manifest.id when present so the
// stale id in the instruction doesn't reach connector-service.

import { buildBindingsByType } from '../binding-resolver';

describe('buildBindingsByType', () => {
  it('returns empty map when there are no integrations', () => {
    expect(buildBindingsByType(undefined)).toEqual({});
    expect(buildBindingsByType([])).toEqual({});
  });

  it('keys each integration by its canonical type AND its UUID', () => {
    const out = buildBindingsByType([
      { id: 'uuid-slack', type: 'slack' },
      { id: 'uuid-gmail', type: 'google_mail', config: { gmailQuery: 'to:support@x.com' } },
    ]);

    // Type-keyed entries.
    expect(out['slack']).toEqual({ connectorId: 'uuid-slack', config: undefined });
    expect(out['google_mail']).toEqual({
      connectorId: 'uuid-gmail',
      config: { gmailQuery: 'to:support@x.com' },
    });

    // UUID-keyed entries (legacy callers that already hold the UUID).
    expect(out['uuid-slack']).toEqual({ connectorId: 'uuid-slack', config: undefined });
    expect(out['uuid-gmail']).toEqual({
      connectorId: 'uuid-gmail',
      config: { gmailQuery: 'to:support@x.com' },
    });
  });

  it('adds alias keys when manifests are supplied', () => {
    const out = buildBindingsByType(
      [
        { id: 'uuid-slack', type: 'slack' },
        { id: 'uuid-gmail', type: 'google_mail' },
      ],
      [
        { connectorType: 'slack', alias: 'slack' },
        { connectorType: 'google_mail', alias: 'google-mail' },
      ],
    );

    // The LLM-facing tool name uses the manifest alias, so resolveBinding
    // must find the right connectorId via the alias key. Without this the
    // agent's slack__list_channels and google-mail__list_messages calls
    // both pass the alias straight through to connector-service.
    expect(out['slack']?.connectorId).toBe('uuid-slack');
    expect(out['google-mail']?.connectorId).toBe('uuid-gmail');
  });

  it('prefers manifest.id over integration.id (stale-UUID resolution)', () => {
    // The stale-UUID scenario: instruction.integrations references the
    // OLD connector UUID captured at distillation time. The user later
    // reconnected; the connectors-table row + connector_manifests row
    // both carry the NEW UUID. Forwarding the old UUID to connector-
    // service yields "no such connector" 404.
    const out = buildBindingsByType(
      [
        { id: 'old-gmail-uuid', type: 'google_mail' },
      ],
      [
        { connectorType: 'google_mail', alias: 'google-mail', id: 'new-gmail-uuid' },
      ],
    );

    // Type and alias entries should both resolve to the CURRENT UUID.
    expect(out['google_mail']?.connectorId).toBe('new-gmail-uuid');
    expect(out['google-mail']?.connectorId).toBe('new-gmail-uuid');

    // Callers that happen to pass the OLD UUID still resolve to the
    // current one (defensive: lets compiled-in stale IDs survive a
    // reconnect without rebuilding instructions).
    expect(out['old-gmail-uuid']?.connectorId).toBe('new-gmail-uuid');

    // And of course passing the CURRENT UUID also works.
    expect(out['new-gmail-uuid']?.connectorId).toBe('new-gmail-uuid');
  });

  it('falls back to integration.id when manifest has no id (transition window)', () => {
    // The connector-credentials event handler is now transactional and
    // always populates manifest.id, but this guards the moment-of-deploy
    // window where the migration 251 backfill is mid-run and some
    // manifests still pre-date the handler that started populating the
    // id column.
    const out = buildBindingsByType(
      [{ id: 'uuid-slack', type: 'slack' }],
      [{ connectorType: 'slack', alias: 'slack' /* no id */ }],
    );
    expect(out['slack']?.connectorId).toBe('uuid-slack');
    expect(out['slack']?.config).toBeUndefined();
  });

  it('only adds alias entries for manifests the agent is actually bound to', () => {
    // The agent has only slack; a tenant-wide manifest for google_calendar
    // exists but is not in the agent's integrations. Aliases for the
    // unbound manifest must NOT appear in the map — otherwise an agent
    // could call a connector it doesn't have permission for and bypass
    // the validator's allowlist check.
    const out = buildBindingsByType(
      [{ id: 'uuid-slack', type: 'slack' }],
      [
        { connectorType: 'slack', alias: 'slack', id: 'uuid-slack' },
        { connectorType: 'google_calendar', alias: 'google-calendar', id: 'uuid-gcal' },
      ],
    );

    expect(out['slack']?.connectorId).toBe('uuid-slack');
    expect(out['google-calendar']).toBeUndefined();
    expect(out['google_calendar']).toBeUndefined();
    expect(out['uuid-gcal']).toBeUndefined();
  });

  it('threads per-binding config (Gmail q, sendAs) through every key', () => {
    const config = { gmailQuery: 'to:support@x.com', sendAs: 'support@x.com' };
    const out = buildBindingsByType(
      [{ id: 'uuid-gmail', type: 'google_mail', config }],
      [{ connectorType: 'google_mail', alias: 'google-mail', id: 'uuid-gmail' }],
    );

    expect(out['google_mail']?.config).toEqual(config);
    expect(out['google-mail']?.config).toEqual(config);
    expect(out['uuid-gmail']?.config).toEqual(config);
  });

  describe('multi-account scenarios', () => {
    // Multi-account: the same agent is bound to two OAuth grants of the
    // same connector type — e.g. a support agent that monitors both
    // support@ and sales@ Gmail mailboxes. The platform allows this
    // (Composio `allowMultiple: true`, identity-fetchers populate
    // config.externalAccountLabel, frontend disambiguates). Migration
    // 252 + handler change use per-account alias suffixes
    // (`google-mail-<first-8-of-id>`) so the two manifests don't
    // collide on the unique (tenant_id, alias) constraint.

    const supportConfig = { gmailQuery: 'to:support@x.com', sendAs: 'support@x.com' };
    const salesConfig = { gmailQuery: 'to:sales@x.com', sendAs: 'sales@x.com' };
    const supportId = 'eaec0c30-9514-448f-8ed0-29b1567de8d3';
    const salesId = '14a82d9e-269c-4d56-892a-7d3a9d259c0c';

    it('keys two same-type integrations by their unique per-account aliases', () => {
      const out = buildBindingsByType(
        [
          { id: supportId, type: 'google_mail', config: supportConfig },
          { id: salesId, type: 'google_mail', config: salesConfig },
        ],
        [
          { connectorType: 'google_mail', alias: 'google-mail-eaec0c30', id: supportId },
          { connectorType: 'google_mail', alias: 'google-mail-14a82d9e', id: salesId },
        ],
      );

      // Per-account alias keys route each tool call to the right mailbox.
      expect(out['google-mail-eaec0c30']?.connectorId).toBe(supportId);
      expect(out['google-mail-eaec0c30']?.config).toEqual(supportConfig);
      expect(out['google-mail-14a82d9e']?.connectorId).toBe(salesId);
      expect(out['google-mail-14a82d9e']?.config).toEqual(salesConfig);

      // UUID keys still unambiguous.
      expect(out[supportId]?.connectorId).toBe(supportId);
      expect(out[salesId]?.connectorId).toBe(salesId);
    });

    it('omits the type-keyed entry when multiple integrations share a type', () => {
      // Type lookup is ambiguous in multi-account: which Gmail does
      // `google_mail` mean? Silently picking one would route a tool
      // call to the wrong inbox. Better to surface a missing-key
      // error so the caller migrates to alias-based lookup.
      const out = buildBindingsByType(
        [
          { id: supportId, type: 'google_mail', config: supportConfig },
          { id: salesId, type: 'google_mail', config: salesConfig },
        ],
        [
          { connectorType: 'google_mail', alias: 'google-mail-eaec0c30', id: supportId },
          { connectorType: 'google_mail', alias: 'google-mail-14a82d9e', id: salesId },
        ],
      );

      expect(out['google_mail']).toBeUndefined();
    });

    it('keeps the type-keyed entry for single-integration types alongside multi-account ones', () => {
      // An agent could have two Gmails AND one Slack. The Slack type
      // lookup is unambiguous and should still work for backward-compat
      // callers; only the Gmail type entry is omitted.
      const out = buildBindingsByType(
        [
          { id: supportId, type: 'google_mail', config: supportConfig },
          { id: salesId, type: 'google_mail', config: salesConfig },
          { id: 'uuid-slack', type: 'slack' },
        ],
        [
          { connectorType: 'google_mail', alias: 'google-mail-eaec0c30', id: supportId },
          { connectorType: 'google_mail', alias: 'google-mail-14a82d9e', id: salesId },
          { connectorType: 'slack', alias: 'slack-uuid-sla', id: 'uuid-slack' },
        ],
      );

      expect(out['google_mail']).toBeUndefined(); // ambiguous
      expect(out['slack']?.connectorId).toBe('uuid-slack'); // unambiguous
    });

    it('threads per-account config independently for each binding', () => {
      // The Gmail q-string and sendAs differ per account. Without
      // per-account binding, both calls would inject the same
      // (whichever-one-won-the-upsert) q/sendAs into outbound calls.
      const out = buildBindingsByType(
        [
          { id: supportId, type: 'google_mail', config: supportConfig },
          { id: salesId, type: 'google_mail', config: salesConfig },
        ],
        [
          { connectorType: 'google_mail', alias: 'google-mail-eaec0c30', id: supportId },
          { connectorType: 'google_mail', alias: 'google-mail-14a82d9e', id: salesId },
        ],
      );

      expect(out['google-mail-eaec0c30']?.config).toEqual(supportConfig);
      expect(out['google-mail-14a82d9e']?.config).toEqual(salesConfig);
    });
  });
});
