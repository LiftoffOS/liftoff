import { deriveCapabilityStates } from '../capability-state-derivation';

const PROVIDERS: Record<string, string[]> = {
  version_control: ['github', 'gitlab'],
  team_chat: ['slack', 'microsoft_teams'],
  email_communication: ['google_mail', 'outlook'],
  telephony: ['twilio'],
};
const connectorTypesFor = ({ capability }: { capability: string }): string[] =>
  PROVIDERS[capability] ?? [];

const REQ = [
  { capability: 'version_control' },
  { capability: 'team_chat' },
];

const derive = (
  reqs: Array<{ capability?: string; capabilities?: string[]; connectorType?: string }>,
  bindings: Array<{ type?: string; integrationId?: string }>,
  declared: Record<string, 'live' | 'unwired' | 'absent'> = {},
): Record<string, string> =>
  deriveCapabilityStates(reqs, bindings, declared, connectorTypesFor);

describe('deriveCapabilityStates', () => {
  it('reports a capability with nothing bound as unwired, not missing', () => {
    // The hire that prompted this: github bound, team chat required and never
    // connected. It shipped an empty map, so the gateway could gate nothing.
    expect(derive(REQ, [{ integrationId: 'github' }]))
      .toEqual({ version_control: 'live', team_chat: 'unwired' });
  });

  it('does not care WHICH provider is bound', () => {
    expect(derive(REQ, [{ integrationId: 'gitlab' }]).version_control).toBe('live');
    expect(derive(REQ, [{ integrationId: 'microsoft_teams' }]).team_chat).toBe('live');
  });

  it('keeps a declared absent even when something providing it is bound', () => {
    // `absent` is a fact about the business, not about the bindings.
    expect(derive([{ capability: 'telephony' }], [{ integrationId: 'twilio' }],
      { telephony: 'absent' }).telephony).toBe('absent');
  });

  it('overrides a declared live that the bindings do not support', () => {
    // The lie this exists to prevent: a template cannot promise a connection.
    expect(derive(REQ, [{ integrationId: 'github' }], { team_chat: 'live' }).team_chat)
      .toBe('unwired');
  });

  it('keeps a declared capability the requirements never name', () => {
    expect(derive(REQ, [{ integrationId: 'github' }], { sms: 'absent' }).sms).toBe('absent');
  });

  it('is live if ANY requirement naming the capability is satisfied', () => {
    expect(derive(
      [{ capability: 'team_chat' }, { capability: 'team_chat' }],
      [{ integrationId: 'slack' }],
    ).team_chat).toBe('live');
  });

  it('reads a binding named by `type` as well as by `integrationId`', () => {
    // Both keys are optional on IntegrationPermission and callers differ.
    // Reading only one reports a real connection as unwired.
    expect(derive(REQ, [{ type: 'slack' }]).team_chat).toBe('live');
  });

  it('reports nothing for a requirement pinned to a connector type', () => {
    // No capability key, so nothing downstream could read it either way.
    expect(derive([{ connectorType: 'github' }], [])).toEqual({});
  });

  it('never returns an empty map for a template that requires anything', () => {
    // The property that matters: an empty map reads as "nothing to gate",
    // which is indistinguishable from "everything is fine".
    expect(Object.keys(derive(REQ, [])).length).toBeGreaterThan(0);
  });
});
