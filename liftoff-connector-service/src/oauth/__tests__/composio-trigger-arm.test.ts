// A connection that completes must end up armed, however it completed.
//
// For a composio_managed connector, Composio's trigger system is the only way
// events reach us — Google/Microsoft/Slack reject our direct webhook arming
// because the OAuth client belongs to Composio. A trigger is bound to the
// connected account it was created against, and a reconnect mints a NEW
// account id.
//
// `composio.triggers.create` had exactly one call site: the arm-watch endpoint,
// reached only when a caller explicitly asks to arm. Nothing armed on
// completion. So after any reconnect the connector goes ACTIVE, the Connections
// page shows it healthy, tool calls keep working — and no event is ever
// delivered again. Wired at one end.

const createTrigger = jest.fn();
jest.mock('../composio-client.js', () => ({
  createComposioTriggerInstance: (args: unknown) => createTrigger(args),
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { ensureComposioTriggerArmed } from '../composio-trigger-arm';
import { COMPOSIO_TRIGGER_BY_CONNECTOR_TYPE } from '../composio-trigger-registry';

const ARGS = {
  tenantId: 'dd7d80bd-3b77-4677-817c-053fdb8668cd',
  connectorId: '14a82d9e-269c-4d56-892a-7d3a9d259c0c',
  connectorType: 'google_mail',
  connectedAccountId: 'ca_new_after_reconnect',
};

beforeEach(() => createTrigger.mockReset().mockResolvedValue({ triggerId: 'ti_1' }));

describe('arming a connection', () => {
  it('registers the connector type’s trigger against the CURRENT account', () => {
    // The account id is the whole point: a reconnect changes it, and a trigger
    // bound to the old one delivers nothing.
    return ensureComposioTriggerArmed(ARGS).then((out) => {
      expect(out).toEqual({ kind: 'armed', triggerId: 'ti_1' });
      expect(createTrigger).toHaveBeenCalledTimes(1);
      expect(createTrigger.mock.calls[0][0]).toMatchObject({
        tenantId: ARGS.tenantId,
        connectedAccountId: 'ca_new_after_reconnect',
        slug: COMPOSIO_TRIGGER_BY_CONNECTOR_TYPE['google_mail']!.slug,
      });
    });
  });

  it('is safe to call on every completion, not only on reconnects', async () => {
    // Composio upserts on (connectedAccountId, slug), which is what lets the
    // caller skip detecting "is this a reconnect?" — a detection that would
    // itself be a thing to get wrong.
    await ensureComposioTriggerArmed(ARGS);
    await ensureComposioTriggerArmed(ARGS);
    expect(createTrigger).toHaveBeenCalledTimes(2);
    expect(createTrigger.mock.calls[1][0]).toMatchObject({ connectedAccountId: 'ca_new_after_reconnect' });
  });

  it('skips a connector type with no event surface, without calling Composio', async () => {
    const out = await ensureComposioTriggerArmed({ ...ARGS, connectorType: 'tool_call_only_type' });
    expect(out).toEqual({ kind: 'no_trigger_for_type' });
    expect(createTrigger).not.toHaveBeenCalled();
  });
});

describe('failure is reported, never fatal', () => {
  it('returns a failed outcome instead of throwing', async () => {
    // A completed connection is one the user finished. Throwing away a working
    // credential over a trigger-registration error would send them back through
    // consent for something they cannot influence.
    createTrigger.mockRejectedValue(new Error('composio 503'));
    const out = await ensureComposioTriggerArmed(ARGS);
    expect(out).toEqual({ kind: 'failed', error: 'composio 503' });
  });
});

describe('the completion funnel arms', () => {
  it('completeComposioConnection calls the armer', () => {
    // Both routes into existence end at this funnel — the OAuth callback (first
    // connect) and the stranded-connection reconciler (recovery) — so arming
    // here covers every way a connection can appear, including future ones.
    const src = readFileSync(join(__dirname, '..', 'composio-bind.ts'), 'utf8');
    expect(src).toContain('ensureComposioTriggerArmed');
    expect(src).toMatch(/connectedAccountId:\s*connectedAccount\.id/);
  });
});
