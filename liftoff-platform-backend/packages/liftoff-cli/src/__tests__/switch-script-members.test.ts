// A script that reaches an outside service becomes a team member.
//
// The alternative was storing the credential the script wanted, which would
// have let a script reach a service without the tool governance, the connector
// audit or the meter ever seeing it. This is the design that replaced it, and
// these are the properties that make it honest rather than merely different.

import { serviceHintFor, splitScriptMembers } from '../switch/sources/script-members';
import type { RawSkill } from '../switch/contract';

function skill(overrides: Partial<RawSkill> = {}): RawSkill {
  return {
    sourceRef: 'skill:poster',
    name: 'poster',
    text: '# Poster\nPost the weekly update.',
    sourcePath: '~/.claude/skills/poster/SKILL.md',
    ...overrides,
  };
}

describe('serviceHintFor', () => {
  it('reads the service out of a credential variable name', () => {
    expect(serviceHintFor('GITHUB_TOKEN')).toBe('github');
    expect(serviceHintFor('SLACK_BOT_TOKEN')).toBe('slack');
    expect(serviceHintFor('NOTION_API_KEY')).toBe('notion');
    expect(serviceHintFor('GITHUB_PAT')).toBe('github');
  });

  it('strips the longest suffix first, so a compound name survives', () => {
    // `_TOKEN` first would leave `github-access`, which matches nothing.
    expect(serviceHintFor('GITHUB_ACCESS_TOKEN')).toBe('github');
  });

  it('leaves a name it does not recognise alone', () => {
    expect(serviceHintFor('GIPHY_API_KEY')).toBe('giphy');
  });
});

describe('splitScriptMembers', () => {
  it('leaves a skill that needs nothing outside exactly as it was', () => {
    // The majority. A document formatter is deterministic; replacing it with a
    // team member would be a downgrade, not a migration.
    const docx = skill({ name: 'docx', files: [{ path: 'scripts/edit.py', text: 'x' }] });
    const result = splitScriptMembers([docx]);

    expect(result.skills).toEqual([docx]);
    expect(result.members).toHaveLength(0);
    expect(result.unsupported).toHaveLength(0);
  });

  it('turns a script with a connectable credential into a team member', () => {
    const result = splitScriptMembers([
      skill({
        referencedSecretNames: ['GITHUB_TOKEN'],
        files: [{ path: 'scripts/post.py', text: 'import requests' }],
      }),
    ]);

    expect(result.skills).toHaveLength(0);
    expect(result.members).toHaveLength(1);

    const member = result.members[0];
    expect(member.sourceRef).toBe('script-member:poster');
    // Bound to the CONNECTION, which is governed, rather than to a key.
    expect(member.integrationRefs).toEqual(['github']);
    // No schedule of its own: it runs when its caller asks.
    expect(member.routineRefs).toEqual([]);
  });

  it('hands the distiller the script as evidence, never as a file to run', () => {
    const result = splitScriptMembers([
      skill({
        referencedSecretNames: ['GITHUB_TOKEN'],
        files: [
          { path: 'scripts/post.py', text: 'print("posting")' },
          { path: 'references/notes.md', text: 'background reading' },
        ],
      }),
    ]);

    const member = result.members[0];
    // The script's text informs what the member is FOR.
    expect(member.artifacts[0].text).toContain('print("posting")');
    // A reference doc is not evidence of what a script does.
    expect(member.artifacts[0].text).not.toContain('background reading');
    // And the member ships no files: it does the work through a connector, so
    // handing it the script back would return the thing we just replaced.
    expect(member.skills).toHaveLength(0);
  });

  it('keeps the skill and names the gap when nothing connects to that service', () => {
    const result = splitScriptMembers([
      skill({ name: 'gif-search', referencedSecretNames: ['GIPHY_API_KEY'] }),
    ]);

    // The person's own text is still theirs, so it imports.
    expect(result.skills.map((s) => s.name)).toEqual(['gif-search']);
    expect(result.members).toHaveLength(0);
    // And the reason is stated rather than left to be discovered mid-task.
    expect(result.unsupported[0].detail).toContain('GIPHY_API_KEY');
    expect(result.unsupported[0].detail).toMatch(/will not run here/i);
  });

  it('reports the credentials a member’s connection does not cover', () => {
    const result = splitScriptMembers([
      skill({ referencedSecretNames: ['GITHUB_TOKEN', 'GIPHY_API_KEY'] }),
    ]);

    expect(result.members).toHaveLength(1);
    expect(result.unsupported.map((u) => u.detail).join(' ')).toContain('GIPHY_API_KEY');
  });

  it('converts every qualifying script, with no ceiling', () => {
    // Conversion is rate-limited and resumes itself, so there is no member
    // count to stay under and nothing to silently drop.
    const many = Array.from({ length: 60 }, (_, i) =>
      skill({
        sourceRef: `skill:s${i}`,
        name: `s${i}`,
        referencedSecretNames: ['GITHUB_TOKEN'],
      }),
    );

    const result = splitScriptMembers(many);

    expect(result.members).toHaveLength(60);
    expect(result.unsupported).toHaveLength(0);
  });
});
