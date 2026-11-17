// Whose logins a browser carries, decided once for every vendor.

import { profileFor } from '../session-profile';
import { NO_AGENT_SENTINEL } from '../types';

const TEAM = '11111111-1111-4111-8111-111111111111';

describe('profileFor', () => {
  it("a team agent gets the team's one profile, whoever opened the browser", () => {
    const withPerson = profileFor({ tenantId: 't1', agentId: TEAM, ownerAccountId: 'acc-1' });
    const onItsOwn = profileFor({ tenantId: 't1', agentId: TEAM });
    expect(withPerson).toEqual({ name: `liftoff-t1-${TEAM}-team`, kind: 'team', ownerAccountId: null });
    expect(onItsOwn).toEqual(withPerson);
  });

  it("a platform assistant gets the workspace's one profile for that assistant, whoever opened the browser", () => {
    // Its conversations are the workspace's; so is its browser.
    const byOne = profileFor({ tenantId: 't1', agentId: NO_AGENT_SENTINEL, assistant: 'team_plan', ownerAccountId: 'acc-1' });
    const byAnother = profileFor({ tenantId: 't1', agentId: '', assistant: 'team_plan', ownerAccountId: 'acc-2' });
    expect(byOne).toEqual({ name: 'liftoff-t1-team_plan-workspace', kind: 'assistant', ownerAccountId: null });
    expect(byAnother).toEqual(byOne);
    // Each assistant is its own unit.
    expect(profileFor({ tenantId: 't1', agentId: '', assistant: 'liftoff' })?.name).toBe('liftoff-t1-liftoff-workspace');
  });

  it('a caller naming neither a team nor an assistant keeps the legacy per-person profile', () => {
    expect(profileFor({ tenantId: 't1', agentId: NO_AGENT_SENTINEL, ownerAccountId: 'acc-1' })).toEqual({
      name: `liftoff-t1-${NO_AGENT_SENTINEL}-acc-1`, kind: 'pane', ownerAccountId: 'acc-1',
    });
  });

  it('nobody named at all gets no profile: an ephemeral browser', () => {
    expect(profileFor({ tenantId: 't1', agentId: NO_AGENT_SENTINEL })).toBeNull();
    expect(profileFor({ tenantId: 't1', agentId: '', ownerAccountId: null })).toBeNull();
  });
});
