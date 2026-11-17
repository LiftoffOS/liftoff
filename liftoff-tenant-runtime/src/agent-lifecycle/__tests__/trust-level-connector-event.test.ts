// A connector_event trigger is untrusted only when its content is
// external-authored (contentTrust set). First-party connector sources, and
// every other trigger kind except custom_event, stay trusted.

import { trustLevelFor } from '../types';
import type { ConnectorEventTrigger } from '../types';

describe('trustLevelFor — connector_event content trust', () => {
  it('reports untrusted_inbound when contentTrust is set', () => {
    const trigger: ConnectorEventTrigger = {
      kind: 'connector_event',
      source: 'github',
      entityType: 'Issue',
      contentTrust: 'untrusted_inbound',
    };
    expect(trustLevelFor(trigger)).toBe('untrusted_inbound');
  });

  it('stays trusted for a first-party connector_event (no contentTrust)', () => {
    const trigger: ConnectorEventTrigger = {
      kind: 'connector_event',
      source: 'hubspot',
      entityType: 'Deal',
    };
    expect(trustLevelFor(trigger)).toBe('trusted');
  });

  it('custom_event remains always untrusted; cron/manual stay trusted; undefined is trusted', () => {
    expect(
      trustLevelFor({
        kind: 'custom_event',
        trustLevel: 'untrusted_inbound',
        source: { sourceId: 's', sourceName: 'n', triggerRuleId: 'r', deliveryId: 'd' },
        event: { eventId: 'e', eventType: 't', occurredAt: 'now', contentRedacted: false },
        receivedAt: 'now',
      }),
    ).toBe('untrusted_inbound');
    expect(trustLevelFor({ kind: 'cron' })).toBe('trusted');
    expect(trustLevelFor({ kind: 'manual' })).toBe('trusted');
    expect(trustLevelFor(undefined)).toBe('trusted');
  });
});
