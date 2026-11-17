// Routines people can pick without typing a cron expression.
//
// The design constraint that shapes everything here: a blueprint does NOT write
// a schedule. It produces the sentence that goes into the team member's
// standing guidance, and distillation turns that into a trigger the same way it
// would if the person had typed it. A blueprint that wrote cron directly would
// be a second authoring path, and the version history, the rollback and the
// analyzer guards all hang off distillation being the only one.

import {
  ROUTINE_BLUEPRINTS,
  blueprintsFor,
  findBlueprint,
  renderBlueprintProse,
} from '../routine-blueprints';

describe('the catalog', () => {
  it('has unique ids', () => {
    const ids = ROUTINE_BLUEPRINTS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never contains a cron expression — prose only', () => {
    // The moment a blueprint carries cron, it has become a second authoring
    // path and the distiller is no longer the only author.
    for (const b of ROUTINE_BLUEPRINTS) {
      expect(b.prose).not.toMatch(/(\*\/\d+|\d+\s+\*\s+\*\s+\*)/);
    }
  });

  it('gives every slot a default, so a blueprint is one click from usable', () => {
    for (const b of ROUTINE_BLUEPRINTS) {
      for (const s of b.slots) {
        expect(s.default.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('references only slots it declares', () => {
    for (const b of ROUTINE_BLUEPRINTS) {
      const referenced = [...b.prose.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const declared = new Set(b.slots.map((s) => s.key));
      for (const key of referenced) expect(declared).toContain(key);
    }
  });

  it('tells monitor-shaped routines to stay silent', () => {
    // The whole point of silent monitors: one that reports every run teaches people to
    // ignore it.
    const watcher = findBlueprint('watch-for-changes')!;
    expect(watcher.prose).toContain('[SILENT]');
  });

  it('tells report-shaped routines to always report', () => {
    // The converse — a weekly summary that goes quiet on a slow week looks
    // broken.
    expect(findBlueprint('weekly-summary')!.prose).toMatch(/even when|even if/i);
  });
});

describe('rendering the prose', () => {
  const b = findBlueprint('weekly-summary')!;

  it('fills the slots the person set', () => {
    const out = renderBlueprintProse(b, { weekday: 'Monday', time: '09:00', topic: 'open bugs' });
    expect(out).toContain('Monday');
    expect(out).toContain('09:00');
    expect(out).toContain('open bugs');
  });

  it('falls back to the default for anything unset', () => {
    const out = renderBlueprintProse(b, {});
    expect(out).toContain('Friday');
    expect(out).toContain('16:00');
  });

  it('treats blank as unset rather than emitting an empty gap', () => {
    const out = renderBlueprintProse(b, { weekday: '   ' });
    expect(out).toContain('Friday');
  });

  it('never leaves a brace in the text handed to the distiller', () => {
    // A literal {slot} reaching the distiller would be read as content and
    // paraphrased into the instructions.
    for (const bp of ROUTINE_BLUEPRINTS) {
      expect(renderBlueprintProse(bp, {})).not.toMatch(/[{}]/);
    }
  });

  it('reads as an instruction to the team member, not a form summary', () => {
    const out = renderBlueprintProse(findBlueprint('morning-inbox-sweep')!, {});
    expect(out).toMatch(/^Each weekday/);
  });
});

describe('offering only what can actually run', () => {
  it('hides a blueprint whose integration is not connected', () => {
    // Otherwise the person picks it and finds out it cannot run when it fails
    // on a schedule.
    const ids = blueprintsFor([]).map((b) => b.id);
    expect(ids).not.toContain('morning-inbox-sweep');
  });

  it('offers it once the integration is there', () => {
    const ids = blueprintsFor(['google_mail']).map((b) => b.id);
    expect(ids).toContain('morning-inbox-sweep');
  });

  it('accepts any one of several supported integrations', () => {
    expect(blueprintsFor(['outlook']).map((b) => b.id)).toContain('morning-inbox-sweep');
    expect(blueprintsFor(['microsoft_teams']).map((b) => b.id)).toContain('daily-standup-post');
  });

  it('always offers the ones that need nothing', () => {
    const ids = blueprintsFor([]).map((b) => b.id);
    expect(ids).toContain('weekly-summary');
    expect(ids).toContain('watch-for-changes');
  });
});

describe('findBlueprint', () => {
  it('returns null for an unknown id rather than throwing', () => {
    expect(findBlueprint('does-not-exist')).toBeNull();
  });
});
