import { assignSkillIds } from '../backfill-skill-ids';
import type { Skill } from '../../internal-agents/types';

const skill = (name: string, id?: string): Skill => ({
  ...(id ? { id } : {}),
  name,
  description: `${name} description`,
  instruction: `${name} instruction`,
});

const RUNTIME_ID = 'a1b2c3d4-1111-2222-3333-444455556666';
const OTHER_ID = 'b2c3d4e5-1111-2222-3333-444455556666';

describe('assignSkillIds', () => {
  it('adopts the runtime id so the next publish reactivates that row', () => {
    const out = assignSkillIds([skill('Review a pull request')], [
      { id: RUNTIME_ID, name: 'Review a pull request' },
    ]);
    expect(out.skills[0].id).toBe(RUNTIME_ID);
    expect(out.adopted).toBe(1);
    expect(out.minted).toBe(0);
  });

  it('matches on name case- and whitespace-insensitively', () => {
    const out = assignSkillIds([skill('  Review A Pull Request ')], [
      { id: RUNTIME_ID, name: 'review a pull request' },
    ]);
    expect(out.skills[0].id).toBe(RUNTIME_ID);
    expect(out.adopted).toBe(1);
  });

  it('mints an id when the runtime has no such skill', () => {
    const out = assignSkillIds([skill('Only in the column')], []);
    expect(out.skills[0].id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(out.minted).toBe(1);
    expect(out.adopted).toBe(0);
  });

  it('leaves a skill that already has an id completely alone', () => {
    const out = assignSkillIds([skill('Already keyed', OTHER_ID)], [
      { id: RUNTIME_ID, name: 'Already keyed' },
    ]);
    expect(out.skills[0].id).toBe(OTHER_ID);
    expect(out.alreadyHadId).toBe(1);
    expect(out.adopted).toBe(0);
    expect(out.minted).toBe(0);
  });

  it('refuses a runtime id that is not a uuid, and mints instead', () => {
    // The flywheel's transient `reflection:<uuid>:<origin>` ids are not uuids and
    // could never be what the runtime's uuid column holds.
    const out = assignSkillIds([skill('Transient')], [
      { id: 'reflection:a1b2c3d4-1111-2222-3333-444455556666:origin', name: 'Transient' },
    ]);
    expect(out.skills[0].id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(out.minted).toBe(1);
    expect(out.adopted).toBe(0);
  });

  it('changes nothing else about a skill', () => {
    const input = skill('Untouched');
    const out = assignSkillIds([input], [{ id: RUNTIME_ID, name: 'Untouched' }]);
    expect(out.skills[0]).toEqual({ ...input, id: RUNTIME_ID });
  });

  it('is idempotent — a second pass adopts and mints nothing', () => {
    const runtime = [{ id: RUNTIME_ID, name: 'Review a pull request' }];
    const first = assignSkillIds([skill('Review a pull request')], runtime);
    const second = assignSkillIds(first.skills, runtime);
    expect(second.adopted).toBe(0);
    expect(second.minted).toBe(0);
    expect(second.alreadyHadId).toBe(1);
    expect(second.skills).toEqual(first.skills);
  });
});
