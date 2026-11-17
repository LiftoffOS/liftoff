import { BASELINE_SKILLS } from '../baseline-skills';

describe('BASELINE_SKILLS', () => {
  it('contains the curated baseline set (identity/communication + execution discipline)', () => {
    const names = BASELINE_SKILLS.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Identity and scope',
        'Communication and escalation',
        'Reproduce before changing',
        'Validation is acceptance',
        'Blocked-access escape hatch',
        'Rework is a reset',
      ]),
    );
    expect(BASELINE_SKILLS.length).toBe(6);
  });

  it('each entry has non-empty name, description, instruction', () => {
    for (const skill of BASELINE_SKILLS) {
      expect(skill.name).toEqual(expect.any(String));
      expect(skill.name.trim().length).toBeGreaterThan(0);

      expect(skill.description).toEqual(expect.any(String));
      expect(skill.description.trim().length).toBeGreaterThan(0);

      expect(skill.instruction).toEqual(expect.any(String));
      expect(skill.instruction.trim().length).toBeGreaterThan(0);
    }
  });

  it('every entry tags include "baseline"', () => {
    for (const skill of BASELINE_SKILLS) {
      expect(skill.tags).toContain('baseline');
    }
  });
});
